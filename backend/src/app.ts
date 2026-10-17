import express, { type RequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";

import { config } from "./config";
import { docsEnabled, openApiDocument } from "./openapi";
import { isAllowedOrigin, parseList } from "./lib/access";
import { jsonReplacer } from "./lib/json";
import { errorHandler } from "./middleware/errorHandler";
import { notFoundHandler } from "./middleware/notFound";
import { usersRouter } from "./routes/users";
import { jobsRouter } from "./routes/jobs";
import { escrowRouter } from "./routes/escrow";
import { disputesRouter } from "./routes/disputes";
import { reputationRouter } from "./routes/reputation";
import { notificationsRouter } from "./routes/notifications";
import { milestonesRouter } from "./routes/milestones";

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
      console.log(
        JSON.stringify({
          level: "info",
          event: "http_request",
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

export function createApp() {
  const app = express();

  if (config.TRUST_PROXY > 0) {
    app.set("trust proxy", config.TRUST_PROXY);
  }

  // OpenAPI description + explorer (issue #61). Mounted ahead of helmet because
  // the bundled Swagger UI bootstraps itself with an inline script, which
  // helmet's default Content-Security-Policy would block. The routes are only
  // registered outside production, so a deployed instance exposes neither.
  if (docsEnabled) {
    app.get("/api/docs/openapi.json", (_req, res) => res.json(openApiDocument));
    app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  }

  app.use(helmet());

  // CORS_ORIGIN is a comma-separated allowlist of browser origins. When it is
  // unset we keep the permissive development behaviour, but saying so out loud
  // in production beats silently exposing the API to every origin.
  const allowedOrigins = parseList(config.CORS_ORIGIN);
  if (allowedOrigins.length === 0 && config.NODE_ENV === "production") {
    console.warn(
      "[cors] CORS_ORIGIN is unset in production — every origin may call this API. " +
        "Set it to your frontend origin, e.g. CORS_ORIGIN=https://your-app.vercel.app",
    );
  }
  app.use(
    cors({
      origin: (origin, callback) =>
        isAllowedOrigin(origin ?? undefined, allowedOrigins)
          ? callback(null, true)
          : callback(null, false),
    }),
  );

  app.use(express.json({ limit: "10mb" }));
  // Prisma rows carry BigInt ids, which `JSON.stringify` throws on; without this
  // any route that returns a job or dispute row would 500 after a successful write.
  app.set("json replacer", jsonReplacer);
  app.use(rateLimit({ windowMs: 60_000, max: 100 }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/users", usersRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/milestones", milestonesRouter);
  app.use("/api/escrow", escrowRouter);
  app.use("/api/disputes", disputesRouter);
  app.use("/api/reputation", reputationRouter);
  app.use("/api/notifications", notificationsRouter);

  // Unmatched paths fall through to Express's built-in final handler, which
  // answers HTML — unlike every route above. Answer them as JSON instead.
  app.use(notFoundHandler);

  app.use(errorHandler);

  return app;
}
