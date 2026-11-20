import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { IndexerCursor } from "@prisma/client";
import { createApp } from "../app";
import { config } from "../config";
import { prisma } from "../db";
import { setIndexerMetrics } from "../lib/metrics";

describe("Prometheus Metrics Endpoint /metrics (issue #305)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = await createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Server failed to bind port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    config.METRICS_USER = "";
    config.METRICS_PASSWORD = "";
    config.METRICS_TOKEN = "";

    vi.spyOn(prisma.indexerCursor, "findUnique").mockResolvedValue({
      id: "main",
      lastLedger: 1000,
      updatedAt: new Date(),
    } as unknown as IndexerCursor);
    vi.spyOn(prisma.indexerDeadLetter, "count").mockResolvedValue(0);
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ 1: 1 }] as unknown as ReturnType<typeof prisma.$queryRaw>);
  });

  it("serves Prometheus-formatted text metrics on GET /metrics", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const text = await res.text();
    expect(text).toContain("freelance_http_requests_total");
    expect(text).toContain("freelance_http_request_duration_seconds");
    expect(text).toContain("freelance_indexer_cursor_ledger_height");
    expect(text).toContain("freelance_indexer_sync_lag_ledgers");
  });

  it("tracks HTTP request counts and durations with labels", async () => {
    // Make a request to /health
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBeDefined();

    const metricsRes = await fetch(`${baseUrl}/metrics`);
    const text = await metricsRes.text();

    expect(text).toMatch(/freelance_http_requests_total\{.*method="GET".*route="\/health".*\}/);
    expect(text).toMatch(/freelance_http_request_duration_seconds_count\{.*method="GET".*route="\/health".*\}/);
  });

  it("exports indexer cursor ledger height and sync lag gauges", async () => {
    vi.spyOn(prisma.indexerCursor, "findUnique").mockResolvedValue({
      id: "main",
      lastLedger: 5432100,
      updatedAt: new Date(),
    } as unknown as IndexerCursor);
    vi.spyOn(prisma.indexerDeadLetter, "count").mockResolvedValue(2);

    setIndexerMetrics({
      cursorLedger: 5432100,
      latestLedger: 5432500,
      lag: 400,
      deadLetterCount: 2,
    });

    const res = await fetch(`${baseUrl}/metrics`);
    const text = await res.text();

    expect(text).toContain("freelance_indexer_cursor_ledger_height 5432100");
    expect(text).toContain("freelance_indexer_sync_lag_ledgers 400");
    expect(text).toContain("freelance_indexer_dead_letter_count 2");
  });

  it("collects dynamic indexer cursor height and dead-letter count from database", async () => {
    vi.spyOn(prisma.indexerCursor, "findUnique").mockResolvedValue({
      id: "main",
      lastLedger: 6123456,
      updatedAt: new Date(),
    } as unknown as IndexerCursor);

    vi.spyOn(prisma.indexerDeadLetter, "count").mockResolvedValue(5);

    const res = await fetch(`${baseUrl}/metrics`);
    const text = await res.text();

    expect(text).toContain("freelance_indexer_cursor_ledger_height 6123456");
    expect(text).toContain("freelance_indexer_dead_letter_count 5");
  });

  describe("Authentication protection", () => {
    it("rejects unauthorized requests when METRICS_USER and METRICS_PASSWORD are set", async () => {
      config.METRICS_USER = "prom";
      config.METRICS_PASSWORD = "secret-password";

      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('Basic realm="Prometheus Metrics"');
    });

    it("rejects invalid Basic Auth credentials", async () => {
      config.METRICS_USER = "prom";
      config.METRICS_PASSWORD = "secret-password";

      const badAuth = Buffer.from("prom:wrong-password").toString("base64");
      const res = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: `Basic ${badAuth}` },
      });
      expect(res.status).toBe(401);
    });

    it("allows access with valid Basic Auth credentials", async () => {
      config.METRICS_USER = "prom";
      config.METRICS_PASSWORD = "secret-password";

      const validAuth = Buffer.from("prom:secret-password").toString("base64");
      const res = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: `Basic ${validAuth}` },
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("freelance_http_requests_total");
    });

    it("allows access with valid Bearer token", async () => {
      config.METRICS_TOKEN = "monitoring-token-12345";

      const resBad = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(resBad.status).toBe(401);

      const resGood = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: "Bearer monitoring-token-12345" },
      });
      expect(resGood.status).toBe(200);

      const resQuery = await fetch(`${baseUrl}/metrics?token=monitoring-token-12345`);
      expect(resQuery.status).toBe(200);
    });
  });
});
