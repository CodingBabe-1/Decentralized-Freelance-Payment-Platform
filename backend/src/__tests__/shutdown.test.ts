/**
 * createShutdownHandler (issue #26).
 *
 * `server.ts` used to leak its `app.listen` handle, the indexer's interval and
 * the Prisma connection on SIGTERM. The handler is injected with all four
 * collaborators, so the ordering, the drain timeout and the exit code are
 * asserted here without a real server, database or signal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdownHandler, DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../lib/shutdown";

describe("createShutdownHandler", () => {
  it("stops the indexer, drains the server, disconnects, then exits 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      stopIndexer: () => {
        order.push("indexer");
      },
      closeServer: async () => {
        order.push("server");
      },
      disconnect: async () => {
        order.push("db");
      },
      exit,
    });

    await shutdown("SIGTERM");

    // New work stops before the pool it used is closed.
    expect(order).toEqual(["indexer", "server", "db"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("waits for in-flight work before exiting", async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      stopIndexer: () => {},
      // A request still being served: `close()` only calls back once it is done.
      closeServer: () => inFlight,
      disconnect: async () => {},
      exit,
    });

    const draining = shutdown("SIGTERM");
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    release();
    await draining;
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("drains only once when a second signal arrives", async () => {
    const stopIndexer = vi.fn();
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      stopIndexer,
      closeServer: async () => {},
      disconnect: async () => {},
      exit,
    });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(stopIndexer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits non-zero when a drain step fails", async () => {
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      stopIndexer: () => {},
      closeServer: async () => {
        throw new Error("server refused to close");
      },
      disconnect: async () => {},
      exit,
    });

    await shutdown("SIGTERM");

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("forces a non-zero exit when draining exceeds the timeout", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const shutdown = createShutdownHandler({
        stopIndexer: () => {},
        // A stuck request that never finishes.
        closeServer: () => new Promise<void>(() => {}),
        disconnect: async () => {},
        exit,
        timeoutMs: 1_000,
      });

      void shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a sane default timeout", () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
