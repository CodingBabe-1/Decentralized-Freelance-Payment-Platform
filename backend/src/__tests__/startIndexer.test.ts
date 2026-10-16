/**
 * startIndexer's handle (issue #26): `stop()` must clear the polling interval
 * and let the poll already in flight finish, so a shutdown never races a cursor
 * write. The DB and the RPC are stubbed, so the loop runs on a fake clock and
 * nothing leaves the process.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  upsert: vi.fn(),
  cursorUpdate: vi.fn(),
}));

vi.mock("../db", () => ({
  prisma: { indexerCursor: { upsert: h.upsert, update: h.cursorUpdate } },
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  // No network: an empty page is all the loop needs to keep ticking.
  class FakeServer {
    async getEvents() {
      return { events: [], latestLedger: 1 };
    }

    async getLatestLedger() {
      return { sequence: 1 };
    }
  }

  return { ...actual, SorobanRpc: { ...actual.SorobanRpc, Server: FakeServer } };
});

// Contract ids are read when the module is first imported, so set one before the
// dynamic import below; otherwise the indexer skips itself and never polls.
process.env.ESCROW_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

let startIndexer: typeof import("../indexer").startIndexer;

beforeAll(async () => {
  ({ startIndexer } = await import("../indexer"));
});

beforeEach(() => {
  vi.useFakeTimers();
  h.upsert.mockReset();
  h.cursorUpdate.mockReset();
  h.upsert.mockResolvedValue({ id: "main", lastLedger: 0 });
  h.cursorUpdate.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startIndexer handle", () => {
  it("polls once immediately and again on the interval", async () => {
    startIndexer();

    await vi.advanceTimersByTimeAsync(0);
    expect(h.upsert).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.upsert.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("stops polling after stop() resolves", async () => {
    const indexer = startIndexer();
    await vi.advanceTimersByTimeAsync(5_000);
    const before = h.upsert.mock.calls.length;

    await indexer.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.upsert.mock.calls.length).toBe(before);
  });

  it("waits for the poll already in flight before stop() resolves", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.upsert.mockImplementationOnce(async () => {
      await gate;
      return { id: "main", lastLedger: 0 };
    });

    const indexer = startIndexer();
    await vi.advanceTimersByTimeAsync(0); // the immediate tick is now awaiting `gate`

    let stopped = false;
    const stopping = indexer.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});
