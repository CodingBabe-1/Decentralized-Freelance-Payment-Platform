import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmModal from "./ConfirmModal";

describe("ConfirmModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not render when isOpen is false", () => {
    render(
      <ConfirmModal
        isOpen={false}
        title="Confirm Cancellation"
        description="Are you sure you want to cancel?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders title, description, amount, and handles confirm/cancel clicks", () => {
    const handleConfirm = vi.fn();
    const handleCancel = vi.fn();

    render(
      <ConfirmModal
        isOpen={true}
        title="Confirm Dispute Timelock Reclaim"
        description="The dispute timelock has elapsed. Funds will be refunded."
        amount="50.00"
        assetSymbol="USDC"
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Confirm Dispute Timelock Reclaim")).toBeTruthy();
    expect(screen.getByText("The dispute timelock has elapsed. Funds will be refunded.")).toBeTruthy();
    expect(screen.getByText("50.00 USDC")).toBeTruthy();

    // Click Cancel
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handleCancel).toHaveBeenCalledTimes(1);

    // Click Confirm
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(handleConfirm).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape key press", () => {
    const handleCancel = vi.fn();

    render(
      <ConfirmModal
        isOpen={true}
        title="Confirm Reclaim"
        description="Warning"
        onConfirm={vi.fn()}
        onCancel={handleCancel}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(handleCancel).toHaveBeenCalledTimes(1);
  });
});
