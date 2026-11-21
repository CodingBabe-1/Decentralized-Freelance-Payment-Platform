import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { SignJWT } from "jose";
import {
  consumeNonce,
  issueNonce,
  NONCE_TTL_MS,
  type AuthNonceRow,
  type AuthNonceStore,
} from "../lib/authNonce";
import { config } from "../config";

/** In-memory stand-in for `prisma.authNonce`. */
class FakeNonceStore implements AuthNonceStore {
  rows = new Map<string, AuthNonceRow>();

  async upsert(args: {
    where: { address: string };
    create: AuthNonceRow;
    update: { nonce: string; expiresAt: Date };
  }): Promise<unknown> {
    this.rows.set(args.create.address, { ...args.create });
    return undefined;
  }

  async deleteMany(args: {
    where: {
      address?: string;
      nonce?: string;
      expiresAt?: { lte?: Date; gt?: Date };
    };
  }): Promise<{ count: number }> {
    let count = 0;
    for (const [address, row] of this.rows) {
      const { where } = args;
      const addressMatches = where.address === undefined || where.address === address;
      const nonceMatches = where.nonce === undefined || where.nonce === row.nonce;
      const expiryMatches =
        where.expiresAt?.lte === undefined ||
        row.expiresAt.getTime() <= where.expiresAt.lte.getTime();
      const notExpired =
        where.expiresAt?.gt === undefined ||
        row.expiresAt.getTime() > where.expiresAt.gt.getTime();
      if (addressMatches && nonceMatches && expiryMatches && notExpired) {
        this.rows.delete(address);
        count += 1;
      }
    }
    return { count };
  }
}

const ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const OTHER = "GBVCHN3CR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const JWT_SECRET = config.JWT_SECRET || "development-secret-change-in-production";
const secretKey = new TextEncoder().encode(JWT_SECRET);

async function createToken(address: string, version?: number): Promise<string> {
  const payload: Record<string, unknown> = { sub: address };
  if (version !== undefined) {
    payload.v = version;
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secretKey);
}

// ---------------------------------------------------------------------------
// Database mocks for user & session management
// ---------------------------------------------------------------------------
interface UserSessionRecord {
  id: string;
  userId: string;
  tokenVersion: number;
  expiresAt: Date;
}

let mockSessions: UserSessionRecord[] = [];
let mockUserRecord: { id: string; stellarAddress: string; displayName?: string } | null = null;

const dbMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  userSession: {
    create: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  },
  job: { findMany: vi.fn(), deleteMany: vi.fn() },
  savedJob: { deleteMany: vi.fn() },
  notification: { deleteMany: vi.fn() },
  milestone: { deleteMany: vi.fn() },
  proposal: { deleteMany: vi.fn() },
  authNonce: {},
}));

vi.mock("../db", () => ({
  prisma: {
    user: dbMock.user,
    userSession: dbMock.userSession,
    job: dbMock.job,
    savedJob: dbMock.savedJob,
    notification: dbMock.notification,
    milestone: dbMock.milestone,
    proposal: dbMock.proposal,
    authNonce: dbMock.authNonce,
  },
}));

describe("auth nonces", () => {
  it("accepts a freshly issued nonce (valid flow)", async () => {
    const db = new FakeNonceStore();
    const now = new Date("2026-01-01T00:00:00Z");
    const nonce = await issueNonce(db, ADDRESS, now);

    expect(await consumeNonce(db, ADDRESS, nonce, now)).toBe(true);
  });

  it("rejects replay of an already-used nonce", async () => {
    const db = new FakeNonceStore();
    const now = new Date("2026-01-01T00:00:00Z");
    const nonce = await issueNonce(db, ADDRESS, now);

    expect(await consumeNonce(db, ADDRESS, nonce, now)).toBe(true);
    // Single use: the row was deleted, so the same nonce cannot be replayed.
    expect(await consumeNonce(db, ADDRESS, nonce, now)).toBe(false);
  });

  it("rejects an expired nonce", async () => {
    const db = new FakeNonceStore();
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    const nonce = await issueNonce(db, ADDRESS, issuedAt);

    const later = new Date(issuedAt.getTime() + NONCE_TTL_MS);
    expect(await consumeNonce(db, ADDRESS, nonce, later)).toBe(false);
  });

  it("allows only one concurrent consumer", async () => {
    const db = new FakeNonceStore();
    const now = new Date("2026-01-01T00:00:00Z");
    const nonce = await issueNonce(db, ADDRESS, now);

    const results = await Promise.all([
      consumeNonce(db, ADDRESS, nonce, now),
      consumeNonce(db, ADDRESS, nonce, now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("rejects a nonce issued for a different address", async () => {
    const db = new FakeNonceStore();
    const now = new Date("2026-01-01T00:00:00Z");
    const nonce = await issueNonce(db, ADDRESS, now);

    expect(await consumeNonce(db, OTHER, nonce, now)).toBe(false);
  });

  it("prunes expired nonces opportunistically", async () => {
    const db = new FakeNonceStore();
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    await issueNonce(db, ADDRESS, issuedAt);

    const later = new Date(issuedAt.getTime() + NONCE_TTL_MS + 1);
    await issueNonce(db, OTHER, later);

    expect(db.rows.has(ADDRESS)).toBe(false);
    expect(db.rows.has(OTHER)).toBe(true);
  });
});

describe("session revocation and token version invalidation (Issue #282)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { usersRouter } = await import("../routes/users");
    const { errorHandler } = await import("../middleware/errorHandler");
    const { jsonReplacer } = await import("../lib/json");

    const app = express();
    app.set("json replacer", jsonReplacer);
    app.use(express.json());
    app.use("/api/users", usersRouter);
    app.use(errorHandler);

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port assigned");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    mockUserRecord = {
      id: "user-123",
      stellarAddress: ADDRESS,
      displayName: "Alice Developer",
    };
    mockSessions = [
      {
        id: "session-1",
        userId: "user-123",
        tokenVersion: 0,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    ];

    dbMock.user.findUnique.mockImplementation(
      ({ where, select }: { where: { stellarAddress?: string }; select?: Record<string, unknown> }) => {
        if (!mockUserRecord || where.stellarAddress !== mockUserRecord.stellarAddress) {
          return Promise.resolve(null);
        }
        if (select?.sessions) {
          return Promise.resolve({
            id: mockUserRecord.id,
            sessions: mockSessions.map((s) => ({ tokenVersion: s.tokenVersion })),
          });
        }
        if (select?.id && Object.keys(select).length === 1) {
          return Promise.resolve({ id: mockUserRecord.id });
        }
        return Promise.resolve(mockUserRecord);
      },
    );

    dbMock.userSession.updateMany.mockImplementation(
      ({ where, data }: { where: { userId?: string }; data: { tokenVersion?: { increment?: number } } }) => {
        let count = 0;
        for (const s of mockSessions) {
          if (!where.userId || s.userId === where.userId) {
            if (data.tokenVersion?.increment) {
              s.tokenVersion += data.tokenVersion.increment;
              count++;
            }
          }
        }
        return Promise.resolve({ count });
      },
    );
  });

  it("authenticates with Token A, revokes it on logout, and verifies 401 on subsequent requests while Token B succeeds", async () => {
    // 1. User has session at version 0, client obtains Token A with v: 0
    const tokenA = await createToken(ADDRESS, 0);

    // 2. Token A accesses protected GET /api/users/me successfully
    const meResBefore = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(meResBefore.status).toBe(200);
    const meDataBefore = (await meResBefore.json()) as { stellarAddress?: string };
    expect(meDataBefore.stellarAddress).toBe(ADDRESS);

    // 3. User calls POST /api/users/logout with Token A
    const logoutRes = await fetch(`${baseUrl}/api/users/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(logoutRes.status).toBe(200);
    const logoutData = (await logoutRes.json()) as { message?: string };
    expect(logoutData.message).toBe("Logged out successfully");

    // Session version is now incremented to 1
    expect(mockSessions[0].tokenVersion).toBe(1);

    // 4. Assert that calling GET /api/users/me with Token A now fails with 401 Unauthorized
    const meResAfter = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(meResAfter.status).toBe(401);
    const meErrAfter = (await meResAfter.json()) as { error?: { message?: string } };
    expect(meErrAfter.error?.message).toContain("Token has been revoked");

    // 5. Re-authenticate: client obtains new Token B with updated version (v: 1)
    const tokenB = await createToken(ADDRESS, 1);
    const meResTokenB = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(meResTokenB.status).toBe(200);
    const meDataTokenB = (await meResTokenB.json()) as { stellarAddress?: string };
    expect(meDataTokenB.stellarAddress).toBe(ADDRESS);
  });

  it("handles multi-session environments: older tokens are rejected, latest session succeeds", async () => {
    // Add multiple sessions, with active version at 2
    mockSessions = [
      {
        id: "session-desktop",
        userId: "user-123",
        tokenVersion: 2,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    ];

    const olderToken = await createToken(ADDRESS, 1);
    const currentToken = await createToken(ADDRESS, 2);

    const olderRes = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${olderToken}` },
    });
    expect(olderRes.status).toBe(401);
    const olderBody = (await olderRes.json()) as { error?: { message?: string } };
    expect(olderBody.error?.message).toContain("Token has been revoked");

    const currentRes = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    expect(currentRes.status).toBe(200);
  });

  it("rejects tokens with missing version claim when session version is positive", async () => {
    mockSessions[0].tokenVersion = 1;
    // Token without version claim (defaults to 0 in auth middleware)
    const unversionedToken = await createToken(ADDRESS);

    const res = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${unversionedToken}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("Token has been revoked");
  });

  it("rejects token for a user that no longer exists in database", async () => {
    mockUserRecord = null;
    const token = await createToken(ADDRESS, 0);

    const res = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("User not found");
  });
});
