import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { SignJWT } from "jose";
import { jobsRouter } from "../routes/jobs";
import { errorHandler } from "../middleware/errorHandler";

const CLIENT = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";
// A checksum-valid G address (the previous fixture was 55 characters, so the
// assign schema correctly rejected it).
const FREELANCER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const OTHER_USER = "GDMVLW7Y3L2R5G3U2SBNFFXN677OHZCRW3B2PZ6WJFF3TPLXJ5L4I2KJ";

const JWT_SECRET = process.env.JWT_SECRET || "development-secret-change-in-production";

const h = vi.hoisted(() => ({
  $transaction: vi.fn(),
  job: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  proposal: {
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../db", () => ({
  prisma: {
    $transaction: h.$transaction,
    job: h.job,
    user: h.user,
    proposal: h.proposal,
  },
}));

let server: Server;
let baseUrl: string;

async function tokenFor(address: string): Promise<string> {
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobsRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port assigned");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  h.$transaction.mockReset();
  h.$transaction.mockImplementation((fn: (tx: typeof h) => Promise<unknown>) => fn(h));
  h.job.findUnique.mockReset();
  h.job.findMany.mockReset();
  h.job.update.mockReset();
  h.user.findUnique.mockReset();
  h.user.upsert.mockReset();
  h.proposal.findMany.mockReset();
  h.proposal.create.mockReset();
  h.proposal.updateMany.mockReset();
  // `requireAuth` loads the caller's current session before the handler runs.
  // The assign route also looks a freelancer up by address, without a session
  // select, so keep that lookup separate.
  h.user.findUnique.mockImplementation(
    ({ where, select }: { where: { stellarAddress: string }; select?: { sessions?: unknown } }) =>
      Promise.resolve(
        select?.sessions
          ? { id: `auth_${where.stellarAddress}`, sessions: [] }
          : { id: `user_${where.stellarAddress}`, stellarAddress: where.stellarAddress },
      ),
  );
});

describe("Job Proposals API (Issue #63)", () => {
  describe("POST /api/jobs/:id/proposals", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await fetch(`${baseUrl}/api/jobs/job_1/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coverLetter: "I would love to work on this!" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects proposal if job is not found", async () => {
      const token = await tokenFor(FREELANCER);
      h.job.findUnique.mockResolvedValue(null);

      const res = await fetch(`${baseUrl}/api/jobs/job_missing/proposals`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ coverLetter: "Valid cover letter text" }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects proposal if client tries to apply to own job", async () => {
      const token = await tokenFor(CLIENT);
      h.job.findUnique.mockResolvedValue({
        id: "job_1",
        status: "CREATED",
        freelancerId: null,
        client: { id: "client_user_id", stellarAddress: CLIENT },
      });

      const res = await fetch(`${baseUrl}/api/jobs/job_1/proposals`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ coverLetter: "I want to apply to my own job" }),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.error?.message ?? json.error).toMatch(/client cannot apply/i);
    });

    it("rejects proposal if job is not open (already assigned or not CREATED)", async () => {
      const token = await tokenFor(FREELANCER);
      h.job.findUnique.mockResolvedValue({
        id: "job_1",
        status: "ACTIVE",
        freelancerId: "already_assigned_id",
        client: { id: "client_user_id", stellarAddress: CLIENT },
      });

      const res = await fetch(`${baseUrl}/api/jobs/job_1/proposals`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ coverLetter: "Let me do this job please" }),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.error?.message ?? json.error).toMatch(/not open for proposals/i);
    });

    it("creates a proposal successfully", async () => {
      const token = await tokenFor(FREELANCER);
      h.job.findUnique.mockResolvedValue({
        id: "job_1",
        status: "CREATED",
        freelancerId: null,
        client: { id: "client_user_id", stellarAddress: CLIENT },
      });
      h.user.upsert.mockResolvedValue({
        id: "user_freelancer_id",
        stellarAddress: FREELANCER,
      });
      h.proposal.create.mockResolvedValue({
        id: "proposal_1",
        jobId: "job_1",
        freelancerId: "user_freelancer_id",
        coverLetter: "I am an expert in Stellar Soroban contracts",
        proposedRate: "500",
        status: "PENDING",
        freelancer: { id: "user_freelancer_id", stellarAddress: FREELANCER },
      });

      const res = await fetch(`${baseUrl}/api/jobs/job_1/proposals`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          coverLetter: "I am an expert in Stellar Soroban contracts",
          proposedRate: "500",
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as any;
      expect(json.id).toBe("proposal_1");
      expect(json.status).toBe("PENDING");
      expect(h.proposal.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            jobId: "job_1",
            freelancerId: "user_freelancer_id",
            coverLetter: "I am an expert in Stellar Soroban contracts",
            proposedRate: "500",
          }),
        }),
      );
    });

    it("returns 409 conflict when duplicate proposal submitted", async () => {
      const token = await tokenFor(FREELANCER);
      h.job.findUnique.mockResolvedValue({
        id: "job_1",
        status: "CREATED",
        freelancerId: null,
        client: { id: "client_user_id", stellarAddress: CLIENT },
      });
      h.user.upsert.mockResolvedValue({
        id: "user_freelancer_id",
        stellarAddress: FREELANCER,
      });
      const p2002Error: any = new Error("Unique constraint failed");
      p2002Error.code = "P2002";
      h.proposal.create.mockRejectedValue(p2002Error);

      const res = await fetch(`${baseUrl}/api/jobs/job_1/proposals`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          coverLetter: "Second attempt to apply for the same job",
        }),
      });

      expect(res.status).toBe(409);
      const json = (await res.json()) as any;
      expect(json.error?.message ?? json.error).toMatch(/already applied/i);
    });
  });

  describe("GET /api/jobs/:id/proposals", () => {
    const openJob = { id: "job_1", client: { stellarAddress: CLIENT } };
    const prop = (id: string, address: string) => ({
      id,
      jobId: "job_1",
      freelancerId: `free_${id}`,
      coverLetter: "Hello",
      proposedRate: "200",
      status: "PENDING",
      freelancer: { stellarAddress: address },
    });

    it("rejects unauthenticated callers with 401 and never reads proposals", async () => {
      const res = await fetch(`${baseUrl}/api/jobs/job_1/proposals`);
      expect(res.status).toBe(401);
      expect(h.proposal.findMany).not.toHaveBeenCalled();
    });

    it("returns 404 when the job does not exist", async () => {
      h.job.findUnique.mockResolvedValue(null);
      const token = await tokenFor(CLIENT);
      const res = await fetch(`${baseUrl}/api/jobs/job_missing/proposals`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
      expect(h.proposal.findMany).not.toHaveBeenCalled();
    });

    it("returns every proposal to the job's client", async () => {
      h.job.findUnique.mockResolvedValue(openJob);
      h.proposal.findMany.mockResolvedValue([prop("p1", FREELANCER), prop("p2", OTHER_USER)]);
      const token = await tokenFor(CLIENT);

      const res = await fetch(`${baseUrl}/api/jobs/job_1/proposals`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json).toHaveLength(2);
      expect(h.proposal.findMany).toHaveBeenCalledWith({
        where: { jobId: "job_1" },
        include: { freelancer: true },
        orderBy: { createdAt: "desc" },
      });
    });

    it("limits an applicant to their own proposal", async () => {
      h.job.findUnique.mockResolvedValue(openJob);
      h.proposal.findMany.mockResolvedValue([prop("p1", FREELANCER)]);
      const token = await tokenFor(FREELANCER);

      const res = await fetch(`${baseUrl}/api/jobs/job_1/proposals`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json).toHaveLength(1);
      expect(h.proposal.findMany).toHaveBeenCalledWith({
        where: { jobId: "job_1", freelancer: { stellarAddress: FREELANCER } },
        include: { freelancer: true },
        orderBy: { createdAt: "desc" },
      });
    });

    it("refuses an authenticated user who is neither client nor applicant", async () => {
      h.job.findUnique.mockResolvedValue(openJob);
      h.proposal.findMany.mockResolvedValue([]);
      const token = await tokenFor(OTHER_USER);

      const res = await fetch(`${baseUrl}/api/jobs/job_1/proposals`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/jobs/:id proposal privacy (Issue #309)", () => {
    const jobWithProposals = {
      id: "job_1",
      title: "Design Smart Contract",
      client: { id: "client_id", stellarAddress: CLIENT },
      freelancer: null,
      milestones: [],
      disputes: [],
      proposals: [
        {
          id: "prop_1",
          jobId: "job_1",
          freelancerId: "free_1",
          coverLetter: "Freelancer 1 proposal details",
          proposedRate: "500",
          freelancer: { stellarAddress: FREELANCER },
        },
        {
          id: "prop_2",
          jobId: "job_1",
          freelancerId: "free_2",
          coverLetter: "Other user confidential rate",
          proposedRate: "450",
          freelancer: { stellarAddress: OTHER_USER },
        },
      ],
    };

    it("allows the job client to view all submitted proposals", async () => {
      const token = await tokenFor(CLIENT);
      h.job.findUnique.mockResolvedValue({ ...jobWithProposals });

      const res = await fetch(`${baseUrl}/api/jobs/job_1`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.proposals).toHaveLength(2);
      expect(json.proposals.map((p: any) => p.id)).toEqual(["prop_1", "prop_2"]);
    });

    it("restricts a competing freelancer to only view their own proposal", async () => {
      const token = await tokenFor(FREELANCER);
      h.job.findUnique.mockResolvedValue({ ...jobWithProposals });

      const res = await fetch(`${baseUrl}/api/jobs/job_1`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.proposals).toHaveLength(1);
      expect(json.proposals[0].id).toBe("prop_1");
      expect(json.proposals[0].coverLetter).toBe("Freelancer 1 proposal details");
      expect(json.proposals.some((p: any) => p.id === "prop_2")).toBe(false);
    });

    it("returns an empty proposals list to an authenticated user who has not applied", async () => {
      const thirdParty = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFQDVR5ZZZZZZZZZZZZ";
      const token = await tokenFor(thirdParty);
      h.job.findUnique.mockResolvedValue({ ...jobWithProposals });

      const res = await fetch(`${baseUrl}/api/jobs/job_1`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.proposals).toEqual([]);
    });

    it("returns an empty proposals list to unauthenticated visitors", async () => {
      h.job.findUnique.mockResolvedValue({ ...jobWithProposals });

      const res = await fetch(`${baseUrl}/api/jobs/job_1`);

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.proposals).toEqual([]);
    });
  });

  describe("PUT /api/jobs/:id/assign", () => {
    it("updates job freelancer and accepts proposal while rejecting other pending proposals", async () => {
      const token = await tokenFor(CLIENT);
      h.job.findUnique.mockResolvedValue({
        id: "job_1",
        status: "CREATED",
        client: { stellarAddress: CLIENT },
      });
      h.user.findUnique.mockImplementation(
        ({ where, select }: { where: { stellarAddress: string }; select?: { sessions?: unknown } }) =>
          Promise.resolve(
            select?.sessions
              ? { id: `auth_${where.stellarAddress}`, sessions: [] }
              : { id: "freelancer_user_id", stellarAddress: FREELANCER },
          ),
      );
      h.job.update.mockResolvedValue({
        id: "job_1",
        freelancerId: "freelancer_user_id",
      });

      const res = await fetch(`${baseUrl}/api/jobs/job_1/assign`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ freelancerAddress: FREELANCER }),
      });

      expect(res.status).toBe(200);
      expect(h.job.update).toHaveBeenCalledWith({
        where: { id: "job_1" },
        data: { freelancerId: "freelancer_user_id" },
      });
      expect(h.proposal.updateMany).toHaveBeenCalledWith({
        where: { jobId: "job_1", freelancerId: "freelancer_user_id" },
        data: { status: "ACCEPTED" },
      });
      expect(h.proposal.updateMany).toHaveBeenCalledWith({
        where: { jobId: "job_1", freelancerId: { not: "freelancer_user_id" }, status: "PENDING" },
        data: { status: "REJECTED" },
      });
    });
  });
});
