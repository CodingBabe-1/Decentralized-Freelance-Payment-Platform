import { z } from "zod";
import { corsConfigError } from "./lib/access";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(32),
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  HORIZON_URL: z.string().url().optional(),
  SOROBAN_RPC_URL: z.string().url(),
  ESCROW_CONTRACT_ID: z.string().default(""),
  DISPUTE_CONTRACT_ID: z.string().default(""),
  REPUTATION_CONTRACT_ID: z.string().default(""),
  USDC_CONTRACT_ID: z.string().default(""),
  XLM_CONTRACT_ID: z.string().default(""),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().default(5000),
  // Dedicated budget for the wallet-auth endpoints (issue #44), applied per IP
  // and per route on top of the global 100/min limiter in app.ts. Nonce
  // issuance and signature attempts are the cheapest thing to script, so they
  // get a much tighter cap than the rest of the API.
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // How far ahead a milestone deadline counts as "due soon" for the in-app
  // reminders (issue #74). A per-request `?withinHours=` overrides it.
  REMINDER_HORIZON_HOURS: z.coerce.number().default(48),
  // Comma-separated Stellar addresses that may resolve disputes through the
  // API. Empty means "nobody", not "everybody": the route fails closed.
  // When DISPUTE_CONTRACT_ID is set the panel is read from the contract
  // (`arbitrators()`), and this list is only the fallback if the chain cannot
  // be read. Without a dispute contract it is the panel.
  ARBITRATOR_ADDRESSES: z.string().default(""),
  // How long an on-chain arbitrator panel read is reused before re-reading it.
  ARBITRATOR_PANEL_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(30_000),
  // Comma-separated wallet addresses authorized to operate admin endpoints.
  // Empty means "nobody", not "everybody".
  INDEXER_ADMIN_ADDRESSES: z.string().default(""),
  // Comma-separated browser origins allowed to call the API (e.g. the Vercel
  // frontend). Empty means "no restriction" in development only; in production
  // (and staging, which runs with NODE_ENV=production) an empty value or a
  // wildcard `*` is rejected at startup.
  CORS_ORIGIN: z.string().default(""),
  // Reverse proxy hop count (e.g. 1 behind Render, Heroku, or Nginx).
  // Configures Express 'trust proxy' so rate limiting keys on the real client IP.
  // 0 disables proxy trust (default).
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Alert webhook URL (Slack, Discord, PagerDuty, or custom webhook) for indexer lag and dead-letter growth (issue #306).
  ALERT_WEBHOOK_URL: z.string().default(""),
  // Maximum allowed difference between chain tip ledger and indexer cursor before alerting.
  INDEXER_LAG_ALERT_THRESHOLD: z.coerce.number().int().positive().default(1000),
  // Maximum unhandled dead-letter rows before alerting.
  DEAD_LETTER_ALERT_THRESHOLD: z.coerce.number().int().positive().default(10),
  // Dead letter background retry settings (issue #245)
  DEAD_LETTER_RETRY_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  DEAD_LETTER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // SMTP Email Provider settings (issue #247)
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default(""),
  SMTP_SECURE: z.enum(["true", "false"]).optional(),
  // Optional HTTP auth for the Prometheus /metrics endpoint (issue #305).
  // Unset means the endpoint is open; the route is normally not public.
  METRICS_USER: z.string().optional(),
  METRICS_PASSWORD: z.string().optional(),
  METRICS_TOKEN: z.string().optional(),
  // How often expired AuthNonce / UserSession rows are deleted (lib/cleanup.ts).
  // Default 15 minutes; 0 disables the job.
  CLEANUP_INTERVAL_MS: z.coerce.number().int().min(0).default(15 * 60 * 1000),
  // Prisma connection pool settings (issue #275).
  // DATABASE_POOL_SIZE controls connection_limit (default: 10 in containerized/production setups).
  // DATABASE_TIMEOUT_MS controls query statement_timeout in ms and pool_timeout (default: 10_000).
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
  DATABASE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Redis configuration for distributed rate limiting in multi-replica deployments (issue #234).
  // If REDIS_URL is set, rate limiters use Redis store instead of in-memory storage.
  // Format: redis://[user:password@]host[:port][/db] or rediss:// for TLS.
  REDIS_URL: z.string().url().optional(),
  // Redis connection timeout and retry settings
  REDIS_SOCKET_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  REDIS_SOCKET_RECONNECT_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  // Frontend URL for email verification links (issue #233)
  FRONTEND_URL: z.string().url().default("http://localhost:3001"),
  // Safely expose Swagger UI / OpenAPI docs in staging environments (issue #263)
  ENABLE_API_DOCS: z.coerce.boolean().default(false),
}).superRefine((env, ctx) => {
  const message = corsConfigError(env.CORS_ORIGIN, env.NODE_ENV);
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["CORS_ORIGIN"], message });
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
