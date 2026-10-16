/**
 * shutdown.ts
 *
 * Graceful shutdown for the API process (issue #26).
 *
 * `server.ts` used to ignore the `app.listen` handle, the indexer's interval and
 * `prisma.$disconnect()`, so a Render SIGTERM during a deploy left a dangling
 * interval and an open connection — the container was killed rather than
 * stopped. The ordering and the watchdog live here so the wiring in `server.ts`
 * stays a few lines and the sequence can be unit-tested without a real HTTP
 * server, database or signal.
 */

/** How long to let in-flight work drain before the process is forced out. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownDeps {
  /** Stop the indexer's polling loop; resolves once an in-flight poll is done. */
  stopIndexer: () => void | Promise<void>;
  /** Close the HTTP server; resolves once in-flight requests have finished. */
  closeServer: () => Promise<void>;
  /** Release the database connection pool. */
  disconnect: () => Promise<void>;
  /** Terminate the process. Injected so tests can assert the exit code. */
  exit: (code: number) => void;
  /** Defaults to `DEFAULT_SHUTDOWN_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Defaults to `console.log`. */
  log?: (message: string) => void;
  /** Defaults to `console.error`. */
  errorLog?: (message: string, error?: unknown) => void;
}

/**
 * Build the SIGTERM/SIGINT handler.
 *
 * Repeated signals are ignored: a second `kill` must not start a second drain
 * while the first is still running, and the first drain's exit code must win.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let inFlight: Promise<void> | null = null;

  return (signal: string) => {
    if (!inFlight) inFlight = runShutdown(signal, deps);
    return inFlight;
  };
}

async function runShutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  const {
    stopIndexer,
    closeServer,
    disconnect,
    exit,
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  } = deps;
  const log = deps.log ?? ((message: string) => console.log(message));
  const errorLog =
    deps.errorLog ??
    ((message: string, error?: unknown) =>
      error === undefined ? console.error(message) : console.error(message, error));

  let finished = false;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    exit(code);
  };

  log(`[shutdown] ${signal} received — draining`);

  // A stuck request (or a hung RPC poll) must not keep the container alive
  // forever: the host would SIGKILL it with no chance to log why. `unref` so the
  // watchdog itself never holds the event loop open.
  const timer = setTimeout(() => {
    errorLog(`[shutdown] did not drain within ${timeoutMs}ms — forcing exit`);
    finish(1);
  }, timeoutMs);
  timer.unref?.();

  try {
    // Order matters: stop producing new work, let the work already accepted
    // finish, then release the connection pool those handlers were using.
    await stopIndexer();
    await closeServer();
    await disconnect();
    log("[shutdown] drained cleanly");
    finish(0);
  } catch (err) {
    errorLog("[shutdown] failed", err);
    finish(1);
  }
}
