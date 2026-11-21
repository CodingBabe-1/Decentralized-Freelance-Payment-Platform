import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { SignJWT } from "jose";

const h = vi.hoisted(() => ({
  secret: "test-secret-at-least-32-characters-long",
  adminAddress: "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B",
  userAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  findUnique: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("../config", () => ({
  config: {
    JWT_SECRET: h.secret,
    INDEXER_ADMIN_ADDRESSES: h.adminAddress,
    AUTH_RATE_LIMIT_WINDOW_MS: 60000,
    AUTH_RATE_LIMIT_MAX: 10,
    REMINDER_HORIZON_HOURS: 48,
    ARBITRATOR_ADDRESSES: "",
    CORS_ORIGIN: "",
    TRUST_PROXY: 0,
    STELLAR_NETWORK: "testnet",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  },
}));

vi.mock("../db", () => ({
  prisma: {
    job: {
      findUnique: h.findUnique,
      update: h.update,
      findMany: h.findMany,
    },
    user: { findUnique: h.userFindUnique },
  },
}));

let baseUrl: string;
let server: Server;

async function signToken(address: string, version = 1): Promise<string> {
  return new SignJWT({ sub: address, v: version })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(h.secret));
}

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
  vi.clearAllMocks();
  h.userFindUnique.mockResolvedValue({ id: "user-1", sessions: [] });
});

describe("Job Verification API (issue #314)", () => {
  it("rejects unauthenticated requests to PATCH /api/jobs/:id/verify with 401", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/job-1/verify`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isVerified: true }),
    });

    expect(res.status).toBe(401);
  });

  it("rejects non-admin caller with 403 Forbidden", async () => {
    const token = await signToken(h.userAddress);

    const res = await fetch(`${baseUrl}/api/jobs/job-1/verify`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ isVerified: true }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("Only a configured admin can verify jobs");
  });

  it("allows configured admin to verify a job with default verificationSource", async () => {
    const token = await signToken(h.adminAddress);

    h.findUnique.mockResolvedValueOnce({ id: "job-1", title: "Grant Project" });
    h.update.mockResolvedValueOnce({
      id: "job-1",
      title: "Grant Project",
      isVerified: true,
      verificationSource: "Stellar Community Fund",
      milestones: [],
      client: { id: "c-1", stellarAddress: "GCLIENT", displayName: "Client" },
      freelancer: null,
    });

    const res = await fetch(`${baseUrl}/api/jobs/job-1/verify`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ isVerified: true }),
    });

    expect(res.status).toBe(200);
    const updated = (await res.json()) as { isVerified?: boolean; verificationSource?: string };
    expect(updated.isVerified).toBe(true);
    expect(updated.verificationSource).toBe("Stellar Community Fund");

    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1" },
        data: {
          isVerified: true,
          verificationSource: "Stellar Community Fund",
        },
      }),
    );
  });

  it("allows admin to specify custom verification source", async () => {
    const token = await signToken(h.adminAddress);

    h.findUnique.mockResolvedValueOnce({ id: "job-1" });
    h.update.mockResolvedValueOnce({
      id: "job-1",
      isVerified: true,
      verificationSource: "Ecosystem Partner Grant",
    });

    const res = await fetch(`${baseUrl}/api/jobs/job-1/verify`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ isVerified: true, verificationSource: "Ecosystem Partner Grant" }),
    });

    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          isVerified: true,
          verificationSource: "Ecosystem Partner Grant",
        },
      }),
    );
  });

  it("unsets verificationSource when isVerified is set to false", async () => {
    const token = await signToken(h.adminAddress);

    h.findUnique.mockResolvedValueOnce({ id: "job-1" });
    h.update.mockResolvedValueOnce({
      id: "job-1",
      isVerified: false,
      verificationSource: null,
    });

    const res = await fetch(`${baseUrl}/api/jobs/job-1/verify`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ isVerified: false }),
    });

    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          isVerified: false,
          verificationSource: null,
        },
      }),
    );
  });
});
