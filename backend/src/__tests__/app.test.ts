import { describe, it, expect, vi, afterEach } from "vitest";
import type { Server } from "node:http";
import { Keypair, SorobanRpc } from "@stellar/stellar-sdk";
import { isValidStellarAddress } from "../lib/stellarAddress";
import { createDeliverableSchema, createJobSchema } from "../lib/schemas";
import { jsonReplacer } from "../lib/json";
import { MAX_JOB_TAGS, SKILL_TAG_SLUGS } from "../lib/tags";

// Pure unit tests against real modules; no DB or env vars required.
// Integration tests requiring a live DB belong in a separate test suite
// run against a real environment (see CONTRIBUTING.md).

// Two checksum-valid account ids: Circle's Stellar testnet USDC issuer and the
// admin of the deployments in deployments/testnet.json.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const DEPLOY_ADMIN = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";

// Health endpoint operational checks (issue #93)

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /health", () => {
  it("returns 200 with status ok when DB, indexer, and RPC are healthy", async () => {
    const { prisma } = await import("../db");
    const soroban = await import("../lib/soroban");
    vi.spyOn(soroban, "checkSorobanRpcHealth").mockResolvedValue(true);
    vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ "?column?": 1 }]);
    vi.spyOn(prisma.indexerCursor, "findUnique").mockResolvedValue({
      id: "main",
      lastLedger: 100,
      updatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof prisma.indexerCursor.findUnique>>);

    let server!: Server;
    const { createApp } = await import("../app");
    const app = await createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: boolean; indexer: boolean; rpc: boolean };
    expect(body.status).toBe("ok");
    expect(body.db).toBe(true);
    expect(body.indexer).toBe(true);
    expect(body.rpc).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 503 when database is unreachable", async () => {
    const { prisma } = await import("../db");
    const soroban = await import("../lib/soroban");
    vi.spyOn(soroban, "checkSorobanRpcHealth").mockResolvedValue(true);
    vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("Connection refused"));
    
    let server!: Server;
    const { createApp } = await import("../app");
    const app = await createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; db: boolean; indexer: boolean };
    expect(body.status).toBe("unhealthy");
    expect(body.db).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it("returns 503 degraded when Soroban RPC is unreachable", async () => {
    const { prisma } = await import("../db");
    const soroban = await import("../lib/soroban");
    vi.spyOn(soroban, "checkSorobanRpcHealth").mockResolvedValue(false);
    vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ "?column?": 1 }]);
    vi.spyOn(prisma.indexerCursor, "findUnique").mockResolvedValue({
      id: "main",
      lastLedger: 100,
      updatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof prisma.indexerCursor.findUnique>>);

    let server!: Server;
    const { createApp } = await import("../app");
    const app = await createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; db: boolean; indexer: boolean; rpc: boolean };
    expect(body.status).toBe("degraded");
    expect(body.rpc).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("GET /ready", () => {
  it("returns 200 with status ok when DB, indexer, and RPC are healthy", async () => {
    const { prisma } = await import("../db");
    const soroban = await import("../lib/soroban");
    vi.spyOn(soroban, "checkSorobanRpcHealth").mockResolvedValue(true);
    vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ "?column?": 1 }]);
    vi.spyOn(prisma.indexerCursor, "findUnique").mockResolvedValue({
      id: "main",
      lastLedger: 100,
      updatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof prisma.indexerCursor.findUnique>>);

    let server!: Server;
    const { createApp } = await import("../app");
    const app = await createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: boolean; indexer: boolean; rpc: boolean };
    expect(body.status).toBe("ok");
    expect(body.db).toBe(true);
    expect(body.indexer).toBe(true);
    expect(body.rpc).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 503 when database is unreachable", async () => {
    const { prisma } = await import("../db");
    const soroban = await import("../lib/soroban");
    vi.spyOn(soroban, "checkSorobanRpcHealth").mockResolvedValue(true);
    vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("Connection refused"));
    
    let server!: Server;
    const { createApp } = await import("../app");
    const app = await createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; db: boolean; indexer: boolean };
    expect(body.status).toBe("unhealthy");
    expect(body.db).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });
});

describe("checkSorobanRpcHealth", () => {
  it("returns true when getLatestLedger succeeds", async () => {
    const { checkSorobanRpcHealth } = await import("../lib/soroban");
    const mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ id: "ledger-1", sequence: 1000 }),
    } as unknown as SorobanRpc.Server;
    const ok = await checkSorobanRpcHealth(mockServer);
    expect(ok).toBe(true);
  });

  it("returns false when getLatestLedger rejects", async () => {
    const { checkSorobanRpcHealth } = await import("../lib/soroban");
    const mockServer = {
      getLatestLedger: vi.fn().mockRejectedValue(new Error("RPC node down")),
    } as unknown as SorobanRpc.Server;
    const ok = await checkSorobanRpcHealth(mockServer);
    expect(ok).toBe(false);
  });
});


describe("stellar address validation", () => {
  it("accepts checksum-valid G addresses", () => {
    expect(isValidStellarAddress(USDC_ISSUER)).toBe(true);
    expect(isValidStellarAddress(DEPLOY_ADMIN)).toBe(true);
    expect(isValidStellarAddress(Keypair.random().publicKey())).toBe(true);
  });

  it("rejects strings that are not 56-character account strkeys", () => {
    // The 55-character fixture this file used to assert on (via a locally
    // defined lambda) is one character short of a real strkey, so it was
    // never a valid Stellar address.
    expect(
      isValidStellarAddress("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"),
    ).toBe(false);
    expect(isValidStellarAddress(USDC_ISSUER.slice(0, 55))).toBe(false);
    expect(isValidStellarAddress(`${USDC_ISSUER}A`)).toBe(false);
    expect(isValidStellarAddress("")).toBe(false);
    expect(isValidStellarAddress("not-an-address")).toBe(false);
    // A contract address (C…) is not an account (G…), even though it is a
    // well-formed strkey of the same length.
    expect(
      isValidStellarAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"),
    ).toBe(false);
  });

  it("rejects the wrong alphabet or a broken checksum", () => {
    expect(isValidStellarAddress(USDC_ISSUER.toLowerCase())).toBe(false);
    // '0', '1', '8', '9' are not base32 characters.
    expect(isValidStellarAddress("G" + "0".repeat(55))).toBe(false);
    // Same length and alphabet, last character flipped: the CRC16 fails.
    expect(isValidStellarAddress(DEPLOY_ADMIN.slice(0, -1) + "A")).toBe(false);
  });
});

describe("POST /api/jobs request validation", () => {
  const valid = {
    title: "Landing page redesign",
    description: "What needs to be delivered by Friday",
    milestones: [{ amount: 1.5, description: "Milestone 1" }],
  };

  it("accepts a minimal job and defaults the asset to USDC", () => {
    const parsed = createJobSchema.parse(valid);
    expect(parsed.asset).toBe("USDC");
    expect(parsed.milestones).toHaveLength(1);
  });

  it("rejects zero and negative milestone amounts", () => {
    expect(
      createJobSchema.safeParse({ ...valid, milestones: [{ amount: 0 }] }).success,
    ).toBe(false);
    expect(
      createJobSchema.safeParse({ ...valid, milestones: [{ amount: -1 }] }).success,
    ).toBe(false);
  });

  it("requires at least one milestone", () => {
    expect(createJobSchema.safeParse({ ...valid, milestones: [] }).success).toBe(false);
  });

  it("keeps a caller-chosen asset symbol for the registry to look up", () => {
    expect(createJobSchema.parse({ ...valid, asset: "XLM" }).asset).toBe("XLM");
  });

  it("accepts an exact decimal string amount", () => {
    // A string reaches the server as typed; the route sums it in base units so
    // 0.1 + 0.2 stores 0.3 rather than 0.30000000000000004.
    const parsed = createJobSchema.parse({
      ...valid,
      milestones: [{ amount: "0.1" }, { amount: "0.2" }],
    });
    expect(parsed.milestones.map((m) => m.amount)).toEqual(["0.1", "0.2"]);
  });

  it("rejects a zero, negative, or malformed string amount", () => {
    for (const amount of ["0", "0.0", "-1", "1e3", "abc", ""]) {
      expect(
        createJobSchema.safeParse({ ...valid, milestones: [{ amount }] }).success,
      ).toBe(false);
    }
  });
});

describe("POST /api/jobs skill tags", () => {
  const valid = {
    title: "Landing page redesign",
    description: "What needs to be delivered by Friday",
    milestones: [{ amount: 1.5 }],
  };

  it("defaults to no tags, so an older client keeps working", () => {
    expect(createJobSchema.parse(valid).tags).toEqual([]);
  });

  it("accepts curated slugs", () => {
    const parsed = createJobSchema.parse({ ...valid, tags: ["web-development", "devops"] });
    expect(parsed.tags).toEqual(["web-development", "devops"]);
  });

  it("de-duplicates the same tag sent twice", () => {
    expect(createJobSchema.parse({ ...valid, tags: ["marketing", "marketing"] }).tags).toEqual([
      "marketing",
    ]);
  });

  it("rejects a tag outside the curated list", () => {
    expect(createJobSchema.safeParse({ ...valid, tags: ["moon-shot"] }).success).toBe(false);
  });

  it("rejects more tags than the cap", () => {
    const tooMany = SKILL_TAG_SLUGS.slice(0, MAX_JOB_TAGS + 1);
    expect(createJobSchema.safeParse({ ...valid, tags: tooMany }).success).toBe(false);
  });
});

describe("POST /api/milestones/:id/deliverables request validation", () => {
  const valid = {
    fileName: "work.zip",
    fileUrl: "https://example.com/work.zip",
  };

  it("accepts a valid upload payload with optional metadata", () => {
    expect(
      createDeliverableSchema.parse({
        ...valid,
        fileSize: 1024,
        fileType: "application/zip",
        description: "Completed deliverables",
      }),
    ).toEqual({
      ...valid,
      fileSize: 1024,
      fileType: "application/zip",
      description: "Completed deliverables",
    });
  });

  it("rejects malformed URLs, non-positive sizes, and oversized fields", () => {
    expect(createDeliverableSchema.safeParse({ ...valid, fileUrl: "not-a-url" }).success).toBe(false);
    expect(createDeliverableSchema.safeParse({ ...valid, fileSize: 0 }).success).toBe(false);
    expect(createDeliverableSchema.safeParse({ ...valid, description: "x".repeat(1001) }).success).toBe(false);
  });
});

describe("jsonReplacer", () => {
  it("serializes a BigInt column as a string instead of throwing", () => {
    // Prisma returns escrowId as a BigInt; JSON.stringify would otherwise throw
    // and turn a successful write into a 500.
    const job = { id: "job_1", escrowId: 7n, onChainId: 9_007_199_254_740_993n };

    expect(JSON.stringify(job, jsonReplacer)).toBe(
      '{"id":"job_1","escrowId":"7","onChainId":"9007199254740993"}',
    );
  });

  it("leaves other values, including a Decimal's own JSON form, untouched", () => {
    const row = { total: "2.5", nested: { released: false }, missing: null };
    expect(JSON.stringify(row, jsonReplacer)).toBe(JSON.stringify(row));
  });
});

describe("HTTP cache headers (issue #294)", () => {
  it("serves /api/docs/openapi.json with ETag and Cache-Control, and returns 304 on matching If-None-Match", async () => {
    let server!: Server;
    const { createApp } = await import("../app");
    const app = await createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const res = await fetch(`${baseUrl}/api/docs/openapi.json`);
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    const cacheControl = res.headers.get("cache-control");

    expect(etag).toBeTruthy();
    expect(cacheControl).toBe("public, max-age=300, stale-while-revalidate=60");

    // Conditional request with matching ETag
    const conditionalRes = await fetch(`${baseUrl}/api/docs/openapi.json`, {
      headers: { "If-None-Match": etag! },
    });
    expect(conditionalRes.status).toBe(304);
    const text = await conditionalRes.text();
    expect(text).toBe("");

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves /api/escrow/:escrowId/receipt with ETag and Cache-Control, and returns 304 on matching If-None-Match", async () => {
    const { prisma } = await import("../db");
    vi.spyOn(prisma.job, "findUnique").mockResolvedValue({
      id: "job-1",
      escrowId: 1n,
      title: "Test Job",
      description: "Test description",
      status: "COMPLETED",
      asset: "USDC",
      totalAmount: "100.0",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      milestones: [
        {
          id: "m-1",
          index: 0,
          amount: "100.0",
          status: "RELEASED",
          description: "Milestone 1",
          deadline: null,
        },
      ],
      client: { stellarAddress: USDC_ISSUER, displayName: "Client" },
      freelancer: { stellarAddress: DEPLOY_ADMIN, displayName: "Freelancer" },
    } as unknown as Awaited<ReturnType<typeof prisma.job.findUnique>>);
    vi.spyOn(prisma.chainEvent, "findMany").mockResolvedValue([
      {
        id: "evt-1",
        escrowId: 1n,
        action: "funded",
        amount: 1000000000n,
        txHash: "hash123",
        ledger: 100,
        createdAt: new Date("2026-01-01T01:00:00Z"),
      },
    ] as unknown as Awaited<ReturnType<typeof prisma.chainEvent.findMany>>);

    let server!: Server;
    const { createApp } = await import("../app");
    const app = await createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const res = await fetch(`${baseUrl}/api/escrow/1/receipt`);
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    const cacheControl = res.headers.get("cache-control");

    expect(etag).toBeTruthy();
    expect(cacheControl).toBe("public, max-age=300, stale-while-revalidate=60");

    // Conditional request with matching ETag
    const conditionalRes = await fetch(`${baseUrl}/api/escrow/1/receipt`, {
      headers: { "If-None-Match": etag! },
    });
    expect(conditionalRes.status).toBe(304);
    const text = await conditionalRes.text();
    expect(text).toBe("");

    // Conditional request with mismatched ETag returns full 200 payload
    const mismatchRes = await fetch(`${baseUrl}/api/escrow/1/receipt`, {
      headers: { "If-None-Match": '"mismatched-etag"' },
    });
    expect(mismatchRes.status).toBe(200);
    const body = (await mismatchRes.json()) as { escrowId: string };
    expect(body.escrowId).toBe("1");

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
