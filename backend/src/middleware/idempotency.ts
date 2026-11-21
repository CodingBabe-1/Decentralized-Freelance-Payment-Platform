/**
 * backend/src/middleware/idempotency.ts
 *
 * Idempotency middleware for mutation endpoints (issue #267).
 * Caches response bodies keyed on (callerAddress, idempotencyKey) with a 24-hour TTL.
 * Replayed requests with the same key and payload return the cached response with
 * header `Idempotent-Replay: true`. Requests reusing a key with a different payload
 * return 422 Conflict.
 */

import crypto from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";

export interface CachedResponse {
  statusCode: number;
  body: unknown;
  payloadHash: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory cache for idempotency records
export const idempotencyCache = new Map<string, CachedResponse>();

export function clearIdempotencyCache(): void {
  idempotencyCache.clear();
}

/**
 * Creates an idempotency middleware handler.
 */
export function idempotency(options: { ttlMs?: number } = {}): RequestHandler {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  return (req: Request, res: Response, next: NextFunction) => {
    const rawKey = req.header("idempotency-key");
    if (!rawKey || typeof rawKey !== "string" || !rawKey.trim()) {
      return next();
    }

    const key = rawKey.trim();
    const caller = (res.locals.stellarAddress as string | undefined) || req.ip || "anonymous";
    const cacheKey = `${caller}:${key}`;
    const payloadHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(req.body ?? {}))
      .digest("hex");

    const now = Date.now();
    const cached = idempotencyCache.get(cacheKey);

    if (cached && now < cached.expiresAt) {
      if (cached.payloadHash !== payloadHash) {
        return res.status(422).json({
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message: "Idempotency key already used with different request parameters",
          },
        });
      }

      res.setHeader("Idempotent-Replay", "true");
      return res.status(cached.statusCode).json(cached.body);
    }

    // Intercept response methods to cache result
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    let responseCached = false;

    const saveCache = (body: unknown) => {
      if (!responseCached && res.statusCode < 500) {
        responseCached = true;
        idempotencyCache.set(cacheKey, {
          statusCode: res.statusCode,
          body,
          payloadHash,
          expiresAt: now + ttlMs,
        });
      }
    };

    res.json = (body: unknown) => {
      saveCache(body);
      return originalJson(body);
    };

    res.send = (body: unknown) => {
      try {
        const parsed = typeof body === "string" ? JSON.parse(body) : body;
        saveCache(parsed);
      } catch {
        saveCache(body);
      }
      return originalSend(body);
    };

    next();
  };
}
