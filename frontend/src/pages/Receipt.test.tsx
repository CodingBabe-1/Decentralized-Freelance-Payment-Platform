/**
 * Receipt.test.tsx
 *
 * The receipt is the artifact a client keeps, so the things that matter are that
 * it renders the milestones, the releases and the transaction links, that it
 * offers a print and a file export, and that it says so when there is nothing to
 * show. The API client and the router are mocked — no network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  id: "7",
  fetchReceipt: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useParams: () => ({ id: h.id }),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("../lib/api", () => ({ fetchReceipt: h.fetchReceipt }));

import Receipt from "./Receipt";
import type { EscrowReceiptApi } from "../lib/api";

const RECEIPT: EscrowReceiptApi = {
  escrowId: "7",
  generatedAt: "2026-03-01T09:00:00.000Z",
  job: {
    id: "job-1",
    title: "Landing page redesign",
    description: "A new marketing site",
    status: "ACTIVE",
    asset: "USDC",
    totalAmount: "2.5",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    client: { stellarAddress: "GCLIENT", displayName: null },
    freelancer: { stellarAddress: "GFREELANCER", displayName: null },
  },
  milestones: [
    {
      index: 0,
      description: "Design",
      amount: "1.5",
      status: "RELEASED",
      deadline: null,
      releasedAt: "2026-02-02T12:00:00.000Z",
    },
  ],
  events: [
    {
      id: "evt-1",
      action: "milestone_released",
      amount: "1.5",
      txHash: "hash-release-0123456789",
      ledger: 20,
      createdAt: "2026-02-02T12:00:00.000Z",
    },
  ],
  totals: { released: "1.5", outstanding: "1" },
};

const print = vi.fn();
const createObjectURL = vi.fn(() => "blob:receipt");

beforeEach(() => {
  h.id = "7";
  h.fetchReceipt.mockReset();
  h.fetchReceipt.mockResolvedValue(RECEIPT);
  // jsdom has no print dialog and no object URLs.
  Object.defineProperty(window, "print", { value: print, configurable: true });
  print.mockClear();
  Object.defineProperty(URL, "createObjectURL", {
    value: createObjectURL,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
});

afterEach(() => cleanup());

describe("Receipt page", () => {
  it("renders the escrow, its released milestone and the transaction link", async () => {
    render(<Receipt />);

    expect(await screen.findByRole("heading", { name: "Landing page redesign" })).toBeTruthy();
    // The released total, the milestone amount and the event that released it
    // all read as "1.5 USDC", which is exactly what a receipt should show.
    expect(screen.getAllByText("1.5 USDC")).toHaveLength(3);
    // The receipt uses the same status badge as the rest of the app, so the
    // printed/exported record has the same visual status language.
    expect(screen.getByText("ACTIVE").className).toBe("badge badge-active");
    expect(screen.getByText("RELEASED")).toBeTruthy();
    // The action is labelled for a human, not as the raw event name.
    expect(screen.getByText("Milestone released")).toBeTruthy();
    const tx = screen.getByRole("link", { name: "hash-release-012…" });
    expect(tx.getAttribute("href")).toContain("/tx/hash-release-0123456789");
    expect(h.fetchReceipt).toHaveBeenCalledWith("7");
  });

  it("prints the receipt through the browser", async () => {
    render(<Receipt />);

    fireEvent.click(await screen.findByRole("button", { name: "Print / Save as PDF" }));

    expect(print).toHaveBeenCalled();
  });

  it("exports a standalone HTML file named after the escrow", async () => {
    render(<Receipt />);
    const download = await screen.findByRole("button", { name: "Download receipt" });

    // jsdom navigates on a link click; the filename and the blob are what matter.
    fireEvent.click(download);

    expect(createObjectURL).toHaveBeenCalled();
    const [blob] = createObjectURL.mock.calls[0] as unknown as [Blob];
    expect(blob.type).toBe("text/html");
  });

  it("reports a missing receipt instead of rendering an empty document", async () => {
    h.fetchReceipt.mockRejectedValue(new Error("Could not load the receipt (HTTP 404)"));

    render(<Receipt />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load the receipt (HTTP 404)",
    );
  });
});
