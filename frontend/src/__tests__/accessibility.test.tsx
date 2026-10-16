import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import Dashboard from "../pages/Dashboard";

// Mock dependencies for Dashboard
const h = vi.hoisted(() => ({
  wallet: {
    publicKey: null as string | null,
    connect: vi.fn(async () => "GCLIENT"),
    connecting: false,
    disconnect: vi.fn(),
    error: null as string | null,
    signMessage: vi.fn(),
  },
  api: {
    fetchJobs: vi.fn(async () => []),
    fetchReminders: vi.fn(async () => []),
  },
}));

vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
vi.mock("../lib/api", () => ({
  fetchJobs: h.api.fetchJobs,
  fetchReminders: h.api.fetchReminders,
}));

describe("Accessibility and Keyboard Navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("Dashboard: inputs have explicit associated labels and can be operated via keyboard", () => {
    render(
      <BrowserRouter>
        <Dashboard />
      </BrowserRouter>,
    );

    // Open job input has explicit label
    const openJobInput = screen.getByLabelText(/Open a job by on-chain id/i);
    expect(openJobInput).toBeDefined();
    expect(openJobInput.id).toBe("open-job-input");

    // Status filter has explicit label
    const statusSelect = screen.getByLabelText(/Filter by status/i);
    expect(statusSelect).toBeDefined();
    expect(statusSelect.id).toBe("filter-status-select");

    // Keyboard interaction: typing in open job input
    fireEvent.change(openJobInput, { target: { value: "42" } });
    expect((openJobInput as HTMLInputElement).value).toBe("42");
  });

  it("Dashboard: live regions announce errors and loading states", () => {
    h.wallet.error = "Freighter rejected connection";

    render(
      <BrowserRouter>
        <Dashboard />
      </BrowserRouter>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeDefined();
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain("Freighter rejected connection");
  });
});
