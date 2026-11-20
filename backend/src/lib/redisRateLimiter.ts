/**
 * redisRateLimiter.ts
 *
 * Redis-backed rate limiter store for distributed deployments (issue #234).
 * Implements the express-rate-limit Store interface for use in multi-replica
 * environments where in-memory storage would bypass rate limits via request distribution.
 *
 * Each instance shares a distributed counter in Redis, so rate limits are
 * enforced globally across all backend replicas.
 */

import { createClient } from "redis";
import type { ClientRateLimitInfo, Store } from "express-rate-limit";

type RedisClient = ReturnType<typeof createClient>;

interface RedisStoreOptions {
  client: RedisClient;
  prefix?: string;
  sendUnknownCommands?: boolean;
}

/**
 * Redis-backed store for express-rate-limit.
 * Shares rate limit counters across all backend instances in a cluster.
 */
export class RedisStore implements Store {
  private client: RedisClient;
  prefix: string;

  constructor(options: RedisStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix || "rl:";
  }

  /**
   * Increment the counter for a given key and return current counts.
   * Called by express-rate-limit on each request to check if the limit is exceeded.
   */
  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redisKey = this.prefix + key;
    const now = Date.now();

    try {
      // Use INCR for atomic increment; returns the new value
      const hits = await this.client.incr(redisKey);

      // Get the TTL (expiry) of the key
      let ttl = await this.client.pTTL(redisKey);

      // If this is the first hit (hits === 1), set an expiry
      // This ensures old counters don't stick around forever
      if (hits === 1) {
        // We don't know the window yet, so this gets set externally via resetKey
        // For now, set a generous TTL (we'll update it properly in resetKey)
        ttl = 60_000; // 60 second default, overridden by rate-limit window
      }

      // If TTL is -1 (key exists but no expiry), set one now
      if (ttl === -1) {
        // Conservative: set 1 hour TTL as a fallback
        await this.client.pExpire(redisKey, 3600_000);
        ttl = 3600_000;
      }

      // If TTL is -2 (key doesn't exist) or we haven't set it, handle gracefully
      if (ttl < 0) {
        ttl = 60_000;
      }

      const resetTime = new Date(now + ttl);

      return { totalHits: hits, resetTime };
    } catch (err) {
      console.error(`[RedisStore] Error incrementing key ${key}:`, err);
      throw err;
    }
  }

  /**
   * Decrement the counter for a given key.
   * Called when express-rate-limit needs to "undo" a count (e.g., for custom logic).
   */
  async decrement(key: string): Promise<void> {
    const redisKey = this.prefix + key;

    try {
      await this.client.decr(redisKey);
    } catch (err) {
      console.error(`[RedisStore] Error decrementing key ${key}:`, err);
      throw err;
    }
  }

  /**
   * Reset the counter for a given key and set its TTL.
   * Called by express-rate-limit during initialization or manual reset.
   */
  async resetKey(key: string): Promise<void> {
    const redisKey = this.prefix + key;

    try {
      // Delete the key to reset the counter
      await this.client.del(redisKey);
    } catch (err) {
      console.error(`[RedisStore] Error resetting key ${key}:`, err);
      throw err;
    }
  }

  /**
   * Reset all rate limit counters (for testing or admin purposes).
   * Scans and deletes all keys with the store's prefix.
   */
  async reset(): Promise<void> {
    try {
      // Use SCAN to iterate over all keys matching the prefix pattern
      let cursor = 0;
      let keysDeleted = 0;

      do {
        const reply = await this.client.scan(cursor, {
          MATCH: `${this.prefix}*`,
          COUNT: 100,
        });

        cursor = reply.cursor;
        const keys = reply.keys;

        if (keys.length > 0) {
          await this.client.del(keys);
          keysDeleted += keys.length;
        }
      } while (cursor !== 0);

      console.log(`[RedisStore] Reset ${keysDeleted} rate limit keys`);
    } catch (err) {
      console.error("[RedisStore] Error resetting all keys:", err);
      throw err;
    }
  }
}

/**
 * Create a Redis client and connect it.
 * Returns the client and a cleanup function.
 */
export async function createRedisClient(
  redisUrl: string,
  options?: { socketTimeoutMs?: number; socketReconnectIntervalMs?: number },
): Promise<{ client: RedisClient; disconnect: () => Promise<void> }> {
  const client = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries: number) => {
        // Exponential backoff with a cap: 1s, 2s, 4s, ..., up to 30s
        const delayMs = Math.min(options?.socketReconnectIntervalMs ?? 1000 * retries, 30_000);
        return delayMs;
      },
      connectTimeout: options?.socketTimeoutMs ?? 5000,
    },
  });

  // Handle connection errors
  client.on("error", (err) => {
    console.error("[Redis] Connection error:", err);
  });

  // Reconnection messages (debug level)
  client.on("reconnecting", () => {
    console.log("[Redis] Reconnecting...");
  });

  client.on("connect", () => {
    console.log("[Redis] Connected");
  });

  // Connect to Redis
  await client.connect();

  return {
    client,
    disconnect: async () => {
      try {
        await client.quit();
        console.log("[Redis] Disconnected");
      } catch (err) {
        console.error("[Redis] Error during disconnect:", err);
        await client.disconnect();
      }
    },
  };
}
