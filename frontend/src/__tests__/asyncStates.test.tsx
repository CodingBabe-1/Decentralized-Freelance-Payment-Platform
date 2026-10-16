import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import Dashboard from "../pages/Dashboard";
import JobDetail from "../pages/JobDetail";

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
    getEscrow: vi.fn(),
    releaseMilestone: vi.fn(),
    openDispute: vi.fn(),
    reclaimDisputed: vi.fn(),
    submitRating: vi.fn(),
    getDisputeDeadline: vi.fn(),
    isPending: vi.fn(() => false),
    hasPendingWrite: vi.fn(() => false),
    error: null as string | null,
    lastFailure: null,
  },
  api: {
    fetchJobs: vi.fn(),
    authenticate: vi.fn(async () => "token"),
    createDispute: vi.fn(),
    linkDisputeId: vi.fn(),
    submitRating: vi.fn(),
    fetchReminders: vi.fn(async () => []),
  },
}));

vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
vi.mock("../hooks/useEscrow", () => ({ useEscrow: () => h.escrow }));
vi.mock("../lib/api", () => ({
  fetchJobs: h.api.fetchJobs,
  fetchReminders: h.api.fetchReminders,
  authenticate: h.api.authenticate,
  createDispute: h.api.createDispute,
  linkDisputeId: h.api.linkDisputeId,
  submitRating: h.api.submitRating,
}));
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ id: "123" }),
  };
});

describe("Loading skeletons and empty/error states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.escrow.error = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("Dashboard: shows skeleton placeholder while jobs are loading", () => {
    h.api.fetchJobs.mockImplementation(() => new Promise(() => {})); // Never resolves to keep loading

    const { container } = render(
      <BrowserRouter>
        <Dashboard />
      </BrowserRouter>,
    );

    const skeleton = container.querySelector(".skeleton-container");
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".skeleton-job-item").length).toBeGreaterThan(0);
  });

  it("Dashboard: shows distinct empty state card with action when no jobs exist", async () => {
    h.api.fetchJobs.mockResolvedValue([]);

    const { container } = render(
      <BrowserRouter>
        <Dashboard />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("No jobs found.")).toBeDefined();
    });

    const emptyCard = container.querySelector(".empty-state");
    expect(emptyCard).not.toBeNull();
    expect(emptyCard?.textContent).toContain("No jobs have been posted yet");
    expect(screen.getByRole("link", { name: /Post a job/i })).toBeDefined();
  });

  it("Dashboard: error state offers a retry action that triggers reload", async () => {
    h.api.fetchJobs
      .mockRejectedValueOnce(new Error("Network timeout"))
      .mockResolvedValueOnce([]);

    render(
      <BrowserRouter>
        <Dashboard />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });

    const retryButton = screen.getByRole("button", { name: /Retry/i });
    expect(retryButton).toBeDefined();

    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(h.api.fetchJobs).toHaveBeenCalledTimes(2);
    });
  });

  it("JobDetail: shows skeleton placeholder while escrow is loading", () => {
    h.escrow.getEscrow.mockImplementation(() => new Promise(() => {})); // Never resolves

    const { container } = render(
      <BrowserRouter>
        <JobDetail />
      </BrowserRouter>,
    );

    const skeleton = container.querySelector(".job-detail-skeleton");
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("aria-busy")).toBe("true");
  });

  it("JobDetail: error state offers a retry action", async () => {
    h.escrow.getEscrow.mockResolvedValueOnce(null);

    render(
      <BrowserRouter>
        <JobDetail />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });

    const retryBtn = screen.getByRole("button", { name: /Retry/i });
    expect(retryBtn).toBeDefined();

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(h.escrow.getEscrow).toHaveBeenCalledTimes(2);
    });
  });
});
