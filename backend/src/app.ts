import express, { type RequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";

import { config } from "./config";
import { prisma } from "./db";
import { docsEnabled, openApiDocument } from "./openapi";
import { isAllowedOrigin, parseList } from "./lib/access";
import { jsonReplacer } from "./lib/json";
import { sendCachedJson } from "./lib/cache";
import { checkSorobanRpcHealth } from "./lib/soroban";
import { errorHandler } from "./middleware/errorHandler";
import { notFoundHandler } from "./middleware/notFound";
import { createAuthRateLimiter } from "./middleware/rateLimit";
import { createRedisClient, RedisStore } from "./lib/redisRateLimiter";
import { usersRouter } from "./routes/users";
import { jobsRouter } from "./routes/jobs";
import { escrowRouter } from "./routes/escrow";
import { disputesRouter } from "./routes/disputes";
import { reputationRouter } from "./routes/reputation";
import { notificationsRouter } from "./routes/notifications";
import { milestonesRouter } from "./routes/milestones";
import { webhooksRouter } from "./routes/webhooks";
import { adminIndexerRouter } from "./routes/adminIndexer";
import { tracingMiddleware } from "./lib/tracing";
import { metricsMiddleware } from "./lib/metrics";
import { metricsRouter } from "./routes/metrics";

/**
 * Access logging (issue #27).
 *
 * The API emitted no access log at all, so there was no record of what was
 * requested or how long it took. Emit one structured JSON line per request — a
 * log collector can index it without a parser, unlike an ad-hoc `console.log`
 * or a pair-format string.
 *
 * `path` is `originalUrl` (query string included) rather than `req.url`, because
 * the router rewrites `req.url` before `finish` fires and the query is often the
 * interesting part of a report. `durationMs` is wall-clock from the first byte
 * in to the response's `finish`, so it covers time spent in every handler.
 */
export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const traceId = res.locals?.traceId || (req as unknown as { traceId?: string })?.traceId;
      console.log(
        JSON.stringify({
          level: "info",
          event: "http_request",
          ...(traceId ? { traceId } : {}),
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Number(durationMs.toFixed(3)),
        }),
      );
    });
    next();
  };
}

export async function createApp() {
  const app = express();

  app.use(tracingMiddleware());
  app.use(metricsMiddleware());

  if (config.TRUST_PROXY > 0) {
    app.set("trust proxy", config.TRUST_PROXY);
  }

  // OpenAPI description + explorer (issue #61). Mounted ahead of helmet because
  // the bundled Swagger UI bootstraps itself with an inline script, which
  // helmet's default Content-Security-Policy would block. The routes are only
  // registered outside production, so a deployed instance exposes neither.
  if (docsEnabled) {
    app.get("/api/docs/openapi.json", (req, res) => {
      sendCachedJson(req, res, openApiDocument);
    });
    app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  }

  app.use(helmet());

  // CORS_ORIGIN is a comma-separated allowlist of browser origins. In
  // production (and staging) config.ts refuses to start without an explicit
  // allowlist, and `strict` here means an empty list or `*` never allows a
  // browser origin even if that check were bypassed. Only development keeps
  // the permissive "allow everything" behaviour.
  const allowedOrigins = parseList(config.CORS_ORIGIN);
  const strictCors = config.NODE_ENV === "production";
  app.use(
    cors({
      origin: (origin, callback) =>
        isAllowedOrigin(origin ?? undefined, allowedOrigins, strictCors)
          ? callback(null, true)
          : callback(null, false),
    }),
  );

  app.use(express.json({ limit: "10mb" }));
  // Prisma rows carry BigInt ids, which `JSON.stringify` throws on; without this
  // any route that returns a job or dispute row would 500 after a successful write.
  app.set("json replacer", jsonReplacer);

  // Initialize Redis-backed rate limiter for multi-replica deployments (issue #234)
  let redisStore: RedisStore | undefined;
  try {
    if (config.REDIS_URL) {
      console.log("[App] Initializing Redis for distributed rate limiting...");
      const { client } = await createRedisClient(config.REDIS_URL, {
        socketTimeoutMs: config.REDIS_SOCKET_TIMEOUT_MS,
        socketReconnectIntervalMs: config.REDIS_SOCKET_RECONNECT_INTERVAL_MS,
      });
      redisStore = new RedisStore({ client });
      console.log("[App] Redis rate limiter initialized");
    } else {
      console.log("[App] Using in-memory rate limiter (REDIS_URL not set)");
    }
  } catch (err) {
    console.error("[App] Failed to initialize Redis, falling back to in-memory:", err);
    // Continue with in-memory limiter as fallback
  }

  // Global rate limiter: 100 requests per 60s per IP (issue #262: standard RateLimit-* headers)
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      store: redisStore,
    }),
  );

  // Wallet auth gets a tighter, dedicated budget on top of the global limiter
  // (issue #44). Challenge issuance writes a nonce row, and /auth is where an
  // attacker scripts signature attempts, so 100/min/IP was far too loose. One
  // limiter per route means the two counters are independent: exhausting the
  // challenge budget cannot block the auth call that completes the flow.
  const authLimit = {
    windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
    max: config.AUTH_RATE_LIMIT_MAX,
    store: redisStore,
  };
  app.use("/api/users/challenge", createAuthRateLimiter(authLimit));
  app.use("/api/users/auth", createAuthRateLimiter(authLimit));

  const handleHealth = async (_req: express.Request, res: express.Response) => {
    const dbOk = await checkDbHealth();
    const indexerOk = await checkIndexerHealth();
    const rpcOk = await checkSorobanRpcHealth();

    if (!dbOk || !indexerOk) {
      return res.status(503).json({
        status: "unhealthy",
        db: dbOk,
        indexer: indexerOk,
        rpc: rpcOk,
      });
    }

    if (!rpcOk) {
      return res.status(503).json({
        status: "degraded",
        db: dbOk,
        indexer: indexerOk,
        rpc: false,
      });
    }

    // Also check indexer staleness: if cursor hasn't advanced recently,
    // return degraded status even if indexer is running
    const indexerStale = await checkIndexerStaleness();
    if (indexerStale) {
      return res.status(200).json({
        status: "degraded",
        db: true,
        indexer: false,
        rpc: true,
        message: "Indexer has not advanced recently",
      });
    }

    return res.json({ status: "ok", db: true, indexer: true, rpc: true });
  };

  app.get("/health", handleHealth);
  app.get("/ready", handleHealth);
  app.use("/metrics", metricsRouter);

  app.use("/api/users", usersRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/milestones", milestonesRouter);
  app.use("/api/escrow", escrowRouter);
  app.use("/api/disputes", disputesRouter);
  app.use("/api/reputation", reputationRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/webhooks", webhooksRouter);
  app.use("/api/admin/indexer", adminIndexerRouter);

  // Unmatched paths fall through to Express's built-in final handler, which
  // answers HTML — unlike every route above. Answer them as JSON instead.
  app.use(notFoundHandler);

  app.use(errorHandler);

  return app;
}

/**
 * Check if the indexer cursor has advanced beyond a reasonable threshold.
 * Returns true if the indexer appears stuck (cursor at 0 or hasn't advanced in a while). */
async function checkIndexerStaleness(): Promise<boolean> {
  try {
    const cursor = await prisma.indexerCursor.findUnique({ where: { id: "main" } });
    if (!cursor) return true; // no cursor table yet
    // If cursor is at 0, the indexer has never successfully polled
    if (cursor.lastLedger === 0) return true;
    // If the cursor hasn't been updated in over 24h, consider it stale
    const now = Date.now();
    const lastUpdated = new Date(cursor.updatedAt).getTime();
    const stalenessThreshold = 24 * 60 * 60 * 1000; // 24 hours
    if (now - lastUpdated > stalenessThreshold) return true;
    return false;
  } catch {
    // If we can't read the cursor, assume stale (conservative)
    return true;
  }
}

/** Check database connectivity with a cheap query and timeout guard */
async function checkDbHealth(): Promise<boolean> {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Database health check timed out")), 3000),
    );
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch {
    return false;
  }
}

/** Check indexer health by reading the cursor */
async function checkIndexerHealth(): Promise<boolean> {
  try {
    const cursor = await prisma.indexerCursor.findUnique({ where: { id: "main" } });
    return !!(cursor && cursor.lastLedger > 0);
  } catch {
    return false;
  }
}
