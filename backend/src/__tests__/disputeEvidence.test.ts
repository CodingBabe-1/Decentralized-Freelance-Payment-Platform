/**
 * disputeEvidence.test.ts
 *
 * Issue #78: each party may attach notes and files to a dispute before
 * arbitration, and the panel can read them. The panel is the set of addresses
 * in `ARBITRATOR_ADDRESSES`; everyone else who is not a party is refused.
 *
 * `prisma` is stubbed, so these pin the route rules (who may write, when the
 * record is still open, who may read) and the writes the route issues. The
 * validation tests below call `evidenceSchema` directly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { SignJWT } from "jose";
import { config } from "../config";
import { evidenceSchema, MAX_EVIDENCE_FILE_BYTES } from "../routes/disputes";

const CLIENT = Keypair.random().publicKey();
const FREELANCER = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();
const ARBITRATOR = Keypair.random().publicKey();

const db = vi.hoisted(() => ({
  dispute: { findUnique: vi.fn() },
  disputeEvidence: { create: vi.fn(), findMany: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock("../db", () => ({ prisma: db }));

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { disputesRouter } = await import("../routes/disputes");
  const { errorHandler } = await import("../middleware/errorHandler");

  const app = express();
  app.use(express.json());
  app.use("/api/disputes", disputesRouter);
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
  db.dispute.findUnique.mockReset();
  db.disputeEvidence.create.mockReset();
  db.disputeEvidence.findMany.mockReset();
  db.user.findUnique.mockReset();
  // `requireAuth` asks for the session; the evidence writer asks for the user's
  // id. Distinguish the two by the `select` shape.
  db.user.findUnique.mockImplementation(
    ({ where, select }: { where: { stellarAddress: string }; select?: { sessions?: unknown } }) =>
      Promise.resolve(
        select?.sessions
          ? { id: `auth_${where.stellarAddress}`, sessions: [] }
          : { id: `user_${where.stellarAddress}` },
      ),
  );
  db.disputeEvidence.findMany.mockResolvedValue([]);
  // Keep the panel empty unless a test opts in.
  config.ARBITRATOR_ADDRESSES = "";
});

async function tokenFor(address: string): Promise<string> {
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function request(
  method: "GET" | "POST",
  path: string,
  address: string,
  body?: unknown,
) {
  const res = await fetch(`${baseUrl}/api/disputes${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await tokenFor(address)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

/** A RAISED, on-chain dispute between CLIENT and FREELANCER. */
function dispute(overrides: Record<string, unknown> = {}) {
  return {
    id: "dispute_1",
    jobId: "job_1",
    onChainId: 3n,
    raisedByAddress: CLIENT,
    reason: "The delivered work does not match the brief",
    status: "RAISED",
    clientShare: null,
    freelancerShare: null,
    resolvedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    job: {
      id: "job_1",
      client: { id: "client_user", stellarAddress: CLIENT },
      freelancer: { id: "freelancer_user", stellarAddress: FREELANCER },
    },
    ...overrides,
  };
}

function evidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evidence_1",
    disputeId: "dispute_1",
    note: "Here is the scope document",
    fileName: null,
    fileUrl: null,
    fileSize: null,
    fileType: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    author: { stellarAddress: CLIENT, displayName: null },
    ...overrides,
  };
}

describe("evidenceSchema", () => {
  it("accepts a note, an attachment, or both", () => {
    expect(evidenceSchema.safeParse({ note: "Scope was signed" }).success).toBe(true);
    expect(
      evidenceSchema.safeParse({
        fileName: "scope.pdf",
        fileUrl: "https://example.com/scope.pdf",
        fileSize: 1024,
        fileType: "application/pdf",
      }).success,
    ).toBe(true);
    expect(
      evidenceSchema.safeParse({
        note: "See attached",
        fileName: "scope.pdf",
        fileUrl: "https://example.com/scope.pdf",
      }).success,
    ).toBe(true);
  });

  it("accepts an inline data URL produced by the browser file picker", () => {
    const dataUrl = `data:application/pdf;base64,${"A".repeat(64)}`;
    expect(
      evidenceSchema.safeParse({ fileName: "scope.pdf", fileUrl: dataUrl }).success,
    ).toBe(true);
  });

  it("refuses an empty submission", () => {
    const parsed = evidenceSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/note or a file attachment/);
    }
  });

  it("requires fileName and fileUrl together", () => {
    expect(
      evidenceSchema.safeParse({ fileName: "scope.pdf" }).success,
    ).toBe(false);
    expect(
      evidenceSchema.safeParse({ fileUrl: "https://example.com/scope.pdf" }).success,
    ).toBe(false);
  });

  it("refuses a non-http(s), non-data scheme", () => {
    expect(
      evidenceSchema.safeParse({
        fileName: "payload.sh",
        fileUrl: "ftp://example.com/payload.sh",
      }).success,
    ).toBe(false);
  });

  it("caps the attachment size the client may claim", () => {
    expect(
      evidenceSchema.safeParse({
        fileName: "huge.zip",
        fileUrl: "https://example.com/huge.zip",
        fileSize: MAX_EVIDENCE_FILE_BYTES + 1,
      }).success,
    ).toBe(false);
  });
});

describe("POST /api/disputes/:id/evidence", () => {
  it("requires a token", async () => {
    const res = await fetch(`${baseUrl}/api/disputes/dispute_1/evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "note" }),
    });

    expect(res.status).toBe(401);
    expect(db.disputeEvidence.create).not.toHaveBeenCalled();
  });

  it("404s an unknown dispute", async () => {
    db.dispute.findUnique.mockResolvedValue(null);

    const res = await request("POST", "/dispute_missing/evidence", CLIENT, { note: "note" });

    expect(res.status).toBe(404);
  });

  it("403s a wallet that is not a party to the job", async () => {
    db.dispute.findUnique.mockResolvedValue(dispute());

    const res = await request("POST", "/dispute_1/evidence", STRANGER, { note: "note" });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("Not a participant of this job");
    expect(db.disputeEvidence.create).not.toHaveBeenCalled();
  });

  it("refuses evidence for a dispute that is not on-chain yet", async () => {
    db.dispute.findUnique.mockResolvedValue(dispute({ onChainId: null, status: "PENDING" }));

    const res = await request("POST", "/dispute_1/evidence", CLIENT, { note: "note" });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not on-chain yet/);
    expect(db.disputeEvidence.create).not.toHaveBeenCalled();
  });

  it("closes the record once arbitration is under way", async () => {
    db.dispute.findUnique.mockResolvedValue(dispute({ status: "UNDER_REVIEW" }));

    const res = await request("POST", "/dispute_1/evidence", CLIENT, { note: "late note" });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("Evidence can only be added before arbitration");
    expect(db.disputeEvidence.create).not.toHaveBeenCalled();
  });

  it("lets the client attach a note before arbitration", async () => {
    db.dispute.findUnique.mockResolvedValue(dispute());
    db.disputeEvidence.create.mockResolvedValue(evidenceRow());

    const res = await request("POST", "/dispute_1/evidence", CLIENT, {
      note: "Here is the scope document",
    });

    expect(res.status).toBe(201);
    expect(db.disputeEvidence.create).toHaveBeenCalledWith({
      data: {
        disputeId: "dispute_1",
        authorId: `user_${CLIENT}`,
        note: "Here is the scope document",
        fileName: null,
        fileUrl: null,
        fileSize: null,
        fileType: null,
      },
      include: { author: { select: { stellarAddress: true, displayName: true } } },
    });
  });

  it("lets the freelancer attach a file", async () => {
    db.dispute.findUnique.mockResolvedValue(dispute());
    db.disputeEvidence.create.mockResolvedValue(
      evidenceRow({ note: null, fileName: "handoff.zip", author: { stellarAddress: FREELANCER } }),
    );

    const res = await request("POST", "/dispute_1/evidence", FREELANCER, {
      fileName: "handoff.zip",
      fileUrl: "https://example.com/handoff.zip",
      fileSize: 2048,
      fileType: "application/zip",
    });

    expect(res.status).toBe(201);
    expect(db.disputeEvidence.create.mock.calls[0][0].data).toMatchObject({
      authorId: `user_${FREELANCER}`,
      note: null,
      fileName: "handoff.zip",
      fileUrl: "https://example.com/handoff.zip",
      fileSize: 2048,
      fileType: "application/zip",
    });
  });

  it("rejects a submission with neither a note nor an attachment", async () => {
    db.dispute.findUnique.mockResolvedValue(dispute());

    const res = await request("POST", "/dispute_1/evidence", CLIENT, {});

    expect(res.status).toBe(400);
    expect(db.disputeEvidence.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/disputes/:id/evidence", () => {
  it("403s a wallet that is neither a party nor an arbitrator", async () => {
    db.dispute.findUnique.mockResolvedValue(dispute());

    const res = await request("GET", "/dispute_1/evidence", STRANGER);

    expect(res.status).toBe(403);
    expect(db.disputeEvidence.findMany).not.toHaveBeenCalled();
  });

  it("lets a party read the evidence, oldest first", async () => {
    db.dispute.findUnique.mockResolvedValue(dispute());
    db.disputeEvidence.findMany.mockResolvedValue([evidenceRow()]);

    const res = await request("GET", "/dispute_1/evidence", CLIENT);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].note).toBe("Here is the scope document");
    expect(db.disputeEvidence.findMany).toHaveBeenCalledWith({
      where: { disputeId: "dispute_1" },
      include: { author: { select: { stellarAddress: true, displayName: true } } },
      orderBy: { createdAt: "asc" },
    });
  });

  it("lets a configured arbitrator read the evidence", async () => {
    config.ARBITRATOR_ADDRESSES = ARBITRATOR;
    db.dispute.findUnique.mockResolvedValue(dispute());
    db.disputeEvidence.findMany.mockResolvedValue([evidenceRow()]);

    const res = await request("GET", "/dispute_1/evidence", ARBITRATOR);

    expect(res.status).toBe(200);
    expect(res.body[0].author.stellarAddress).toBe(CLIENT);
  });

  it("fails closed when no arbitrator is configured", async () => {
    config.ARBITRATOR_ADDRESSES = "";
    db.dispute.findUnique.mockResolvedValue(dispute());

    const res = await request("GET", "/dispute_1/evidence", ARBITRATOR);

    expect(res.status).toBe(403);
  });

  it("hides evidence for a dispute that never reached the chain", async () => {
    db.dispute.findUnique.mockResolvedValue(dispute({ onChainId: null, status: "PENDING" }));

    const res = await request("GET", "/dispute_1/evidence", CLIENT);

    expect(res.status).toBe(404);
    expect(db.disputeEvidence.findMany).not.toHaveBeenCalled();
  });
});
