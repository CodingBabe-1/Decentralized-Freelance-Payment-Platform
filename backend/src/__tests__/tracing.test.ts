import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { Server } from "node:http";
import express from "express";
import { createApp, requestLogger } from "../app";
import { initTracing, shutdownTracing, tracingMiddleware, tracer } from "../lib/tracing";
import { setupPrismaQueryMonitoring, prisma } from "../db";

describe("OpenTelemetry Distributed Tracing (Issue #307)", () => {
  beforeEach(() => {
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ "?column?": 1 }] as unknown as never);
    vi.spyOn(prisma.indexerCursor, "findUnique").mockResolvedValue({
      id: "main",
      lastLedger: 100,
      updatedAt: new Date(),
    } as unknown as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("HTTP Request Tracing & Header Propagation", () => {
    it("propagates X-Trace-Id header on HTTP responses", async () => {
      const app = await createApp();
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });

      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("no port assigned");
        const res = await fetch(`http://127.0.0.1:${address.port}/health`);

        const traceId = res.headers.get("x-trace-id");
        expect(traceId).toBeDefined();
        expect(traceId).not.toBeNull();
        expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    });

    it("generates unique trace IDs across distinct requests", async () => {
      const app = await createApp();
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });

      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("no port assigned");

        const res1 = await fetch(`http://127.0.0.1:${address.port}/ready`);
        const traceId1 = res1.headers.get("x-trace-id");

        const res2 = await fetch(`http://127.0.0.1:${address.port}/ready`);
        const traceId2 = res2.headers.get("x-trace-id");

        expect(traceId1).toBeDefined();
        expect(traceId2).toBeDefined();
        expect(traceId1).not.toBe(traceId2);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    });

    it("includes traceId in structured request access logs", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line: unknown) => {
        lines.push(String(line));
      });

      const app = express();
      app.use(tracingMiddleware());
      app.use(requestLogger());
      app.get("/test", (_req, res) => {
        res.status(200).json({ ok: true });
      });

      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });

      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("no port assigned");

        const res = await fetch(`http://127.0.0.1:${address.port}/test`);
        expect(res.status).toBe(200);

        const traceIdHeader = res.headers.get("x-trace-id");
        expect(lines).toHaveLength(1);

        const logEntry = JSON.parse(lines[0]) as {
          event: string;
          traceId?: string;
          method: string;
          path: string;
          status: number;
        };

        expect(logEntry.event).toBe("http_request");
        expect(logEntry.traceId).toBe(traceIdHeader);
        expect(logEntry.method).toBe("GET");
        expect(logEntry.path).toBe("/test");
        expect(logEntry.status).toBe(200);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    });
  });

  describe("Prisma Query Instrumentation", () => {
    it("traces Prisma queries with span attributes", async () => {
      const startSpanSpy = vi.spyOn(tracer, "startSpan");

      const fakeClient = {
        $use: vi.fn((middleware: (params: unknown, next: (p: unknown) => Promise<unknown>) => Promise<unknown>) => {
          // Simulate executing query through middleware
          return middleware(
            {
              model: "Job",
              action: "findMany",
              args: { where: { status: "OPEN" } },
            },
            async () => [{ id: "job-1", title: "Test Job" }],
          );
        }),
      };

      setupPrismaQueryMonitoring(fakeClient as unknown as Parameters<typeof setupPrismaQueryMonitoring>[0]);

      expect(startSpanSpy).toHaveBeenCalledWith(
        "prisma.Job.findMany",
        expect.objectContaining({
          kind: expect.any(Number),
          attributes: expect.objectContaining({
            "db.system": "postgresql",
            "db.operation": "findMany",
            "db.model": "Job",
          }),
        }),
      );
    });
  });

  describe("Tracing SDK Lifecycle", () => {
    it("initializes and shuts down cleanly", async () => {
      const sdk = await initTracing();
      expect(sdk).toBeDefined();
      await expect(shutdownTracing()).resolves.toBeUndefined();
    });
  });
});
