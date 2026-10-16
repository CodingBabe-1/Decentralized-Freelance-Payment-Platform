import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import Dashboard from "../pages/Dashboard";
import PostJob from "../pages/PostJob";

// Mock dependencies
const h = vi.hoisted(() => ({
  wallet: {
    publicKey: "GCLIENT" as string | null,
    connect: vi.fn(async () => "GCLIENT"),
    connecting: false,
    disconnect: vi.fn(),
    signMessage: vi.fn(async () => "sig"),
    error: null as string | null,
  },
  escrow: {
    createAndFund: vi.fn(),
    isPending: vi.fn(() => false),
    error: null as string | null,
  },
  api: {
    fetchJobs: vi.fn(async () => []),
    authenticate: vi.fn(),
    createJob: vi.fn(),
    linkEscrowId: vi.fn(),
    fetchReminders: vi.fn(async () => []),
  },
}));

vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
vi.mock("../hooks/useEscrow", () => ({ useEscrow: () => h.escrow }));
vi.mock("../lib/api", () => ({
  fetchJobs: h.api.fetchJobs,
  fetchReminders: h.api.fetchReminders,
  authenticate: h.api.authenticate,
  createJob: h.api.createJob,
  linkEscrowId: h.api.linkEscrowId,
}));
vi.mock("../lib/stellar", () => ({
  CONTRACT_ADDRESSES: { escrow: "CESCROW", dispute: "", reputation: "", usdc: "" },
  explorerTxUrl: (hash: string) => `https://stellar.expert/tx/${hash}`,
}));

describe("Responsive Layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("Dashboard includes responsive open-job-form container", () => {
    const { container } = render(
      <BrowserRouter>
        <Dashboard />
      </BrowserRouter>,
    );

    const form = container.querySelector(".open-job-form");
    expect(form).not.toBeNull();
  });

  it("PostJob uses fluid form controls without rigid fixed character width constraints", () => {
    render(
      <BrowserRouter>
        <PostJob />
      </BrowserRouter>,
    );

    const titleInput = screen.getByLabelText(/Title/i);
    const descInput = screen.getByLabelText(/Description/i);
    const freelancerInput = screen.getByLabelText(/Freelancer Stellar address/i);

    expect(titleInput.classList.contains("form-control")).toBe(true);
    expect(descInput.classList.contains("form-control")).toBe(true);
    expect(freelancerInput.classList.contains("form-control")).toBe(true);

    // Form inputs should not have rigid size=60 / cols=60 attributes that blowout mobile screens
    expect(titleInput.getAttribute("size")).toBeNull();
    expect(descInput.getAttribute("cols")).toBeNull();
    expect(freelancerInput.getAttribute("size")).toBeNull();
  });
});
