import { describe, expect, it, beforeEach, afterAll, beforeAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { idempotency, clearIdempotencyCache } from "../middleware/idempotency";

describe("Idempotency Middleware (issue #267)", () => {
  let server: Server;
  let baseUrl: string;
  let handlerExecutionCount = 0;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());

    // Test endpoint using idempotency middleware
    app.post("/test-idempotent", idempotency(), (req, res) => {
      handlerExecutionCount++;
      return res.status(201).json({
        success: true,
        data: req.body,
        executionNumber: handlerExecutionCount,
      });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    clearIdempotencyCache();
    handlerExecutionCount = 0;
  });

  it("executes handler normally when Idempotency-Key is not provided", async () => {
    const res1 = await fetch(`${baseUrl}/test-idempotent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: "job-1" }),
    });
    expect(res1.status).toBe(201);
    expect(res1.headers.get("Idempotent-Replay")).toBeNull();
    const data1 = (await res1.json()) as { executionNumber: number };
    expect(data1.executionNumber).toBe(1);

    const res2 = await fetch(`${baseUrl}/test-idempotent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: "job-1" }),
    });
    expect(res2.status).toBe(201);
    expect(res2.headers.get("Idempotent-Replay")).toBeNull();
    const data2 = (await res2.json()) as { executionNumber: number };
    expect(data2.executionNumber).toBe(2);
    expect(handlerExecutionCount).toBe(2);
  });

  it("replays cached response on duplicate request with same Idempotency-Key and payload", async () => {
    const key = "test-key-abc-123";
    const payload = { title: "Smart Contract Audit", budget: 1000 };

    // First request: executes handler
    const res1 = await fetch(`${baseUrl}/test-idempotent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(payload),
    });

    expect(res1.status).toBe(201);
    expect(res1.headers.get("Idempotent-Replay")).toBeNull();
    const data1 = (await res1.json()) as { executionNumber: number };
    expect(data1.executionNumber).toBe(1);
    expect(handlerExecutionCount).toBe(1);

    // Second request: replayed without re-executing handler
    const res2 = await fetch(`${baseUrl}/test-idempotent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(payload),
    });

    expect(res2.status).toBe(201);
    expect(res2.headers.get("Idempotent-Replay")).toBe("true");
    const data2 = (await res2.json()) as { executionNumber: number };
    expect(data2.executionNumber).toBe(1);
    expect(handlerExecutionCount).toBe(1); // handler was not run again
  });

  it("returns 422 Conflict when the same key is used with a different payload", async () => {
    const key = "shared-conflict-key";

    const res1 = await fetch(`${baseUrl}/test-idempotent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ amount: 100 }),
    });
    expect(res1.status).toBe(201);

    // Different payload
    const res2 = await fetch(`${baseUrl}/test-idempotent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ amount: 200 }),
    });

    expect(res2.status).toBe(422);
    const body2 = (await res2.json()) as { error: { message: string } };
    expect(body2.error.message).toMatch(/idempotency key already used/i);
  });
});
