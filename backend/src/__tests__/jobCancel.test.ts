/**
 * jobCancel.test.ts
 *
 * Issue #81: an off-chain job that was created but never funded can be
 * withdrawn by its client, and a cancelled job must stop appearing in the open
 * listing. The route is exercised over HTTP with `prisma` stubbed, so these
 * assertions cover the authorization and state rules (who may cancel, which
 * statuses are cancellable) plus the writes the route issues.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { SignJWT } from "jose";

const CLIENT = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();

const db = vi.hoisted(() => ({
  job: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
  proposal: {
    updateMany: vi.fn(),
  },
}));

vi.mock("../db", () => ({ prisma: db }));

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { jobsRouter } = await import("../routes/jobs");
  const { errorHandler } = await import("../middleware/errorHandler");

  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobsRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  db.job.findUnique.mockReset();
  db.job.update.mockReset();
  db.user.findUnique.mockReset();
  db.proposal.updateMany.mockReset();
  // `requireAuth` loads the caller's current session before the handler runs.
  db.user.findUnique.mockImplementation(
    ({ where, select }: { where: { stellarAddress: string }; select?: { sessions?: unknown } }) =>
      Promise.resolve(
        select?.sessions
          ? { id: `auth_${where.stellarAddress}`, sessions: [] }
          : { id: `user_${where.stellarAddress}`, stellarAddress: where.stellarAddress },
      ),
  );
});

async function tokenFor(address: string): Promise<string> {
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function cancel(jobId: string, address: string = CLIENT) {
  const res = await fetch(`${baseUrl}/api/jobs/${jobId}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenFor(address)}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

/** A job the given client owns, defaulting to a cancellable unfunded CREATED row. */
function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    clientId: "client_user_id",
    client: { stellarAddress: CLIENT },
    status: "CREATED",
    escrowId: null,
    freelancerId: null,
    ...overrides,
  };
}

describe("POST /api/jobs/:id/cancel", () => {
  it("requires a token", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/job_1/cancel`, { method: "POST" });

    expect(res.status).toBe(401);
    expect(db.job.findUnique).not.toHaveBeenCalled();
  });

  it("404s a job that does not exist", async () => {
    db.job.findUnique.mockResolvedValue(null);

    const res = await cancel("job_missing");

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Job not found");
    expect(db.job.update).not.toHaveBeenCalled();
  });

  it("403s a caller who is not the client", async () => {
    db.job.findUnique.mockResolvedValue(job());

    const res = await cancel("job_1", STRANGER);

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("Only the client can cancel this job");
    expect(db.job.update).not.toHaveBeenCalled();
  });

  it("refuses to cancel a funded or non-CREATED job", async () => {
    db.job.findUnique.mockResolvedValue(job({ status: "ACTIVE", escrowId: 42n }));

    const res = await cancel("job_1");

    // 409: the request is well-formed but the job is in the wrong state.
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/unfunded CREATED job/);
    expect(db.job.update).not.toHaveBeenCalled();
    expect(db.proposal.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a CREATED job that already has an escrow id", async () => {
    // Status can lag the chain; the escrow id is the authoritative signal that
    // funds exist.
    db.job.findUnique.mockResolvedValue(job({ escrowId: 7n }));

    const res = await cancel("job_1");

    expect(res.status).toBe(409);
    expect(db.job.update).not.toHaveBeenCalled();
  });

  it("cancels an unfunded CREATED job and rejects pending proposals", async () => {
    db.job.findUnique.mockResolvedValue(job());
    db.job.update.mockResolvedValue(job({ status: "CANCELLED" }));
    db.proposal.updateMany.mockResolvedValue({ count: 2 });

    const res = await cancel("job_1");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
    expect(db.job.update).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: { status: "CANCELLED" },
    });
    expect(db.proposal.updateMany).toHaveBeenCalledWith({
      where: { jobId: "job_1", status: "PENDING" },
      data: { status: "REJECTED" },
    });
  });

  it("is idempotent: cancelling an already-cancelled job returns it unchanged", async () => {
    const cancelled = job({ status: "CANCELLED" });
    db.job.findUnique.mockResolvedValue(cancelled);

    const res = await cancel("job_1");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
    // A retried request must not write again or re-reject proposals.
    expect(db.job.update).not.toHaveBeenCalled();
    expect(db.proposal.updateMany).not.toHaveBeenCalled();
  });
});
