import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import StatusBadge from "./StatusBadge";


// Every escrow state the contracts can emit has its own colour, so a status is
// never rendered as an unstyled (or blank) label.
const KNOWN: Array<[string, string]> = [
  ["Created", "badge badge-created"],
  ["Funded", "badge badge-funded"],
  ["Active", "badge badge-active"],
  ["Completed", "badge badge-completed"],
  ["Disputed", "badge badge-disputed"],
  ["Refunded", "badge badge-refunded"],
  ["Cancelled", "badge badge-cancelled"],
];

afterEach(() => cleanup());

describe("StatusBadge", () => {
  it.each(KNOWN)("renders %s with its own class", (status, className) => {
    render(<StatusBadge status={status} />);

    expect(screen.getByText(status).className).toBe(className);
  });

  it("spells the American cancelled alias the same way", () => {
    render(<StatusBadge status="CANCELED" />);
    expect(screen.getByText("CANCELED").className).toBe("badge badge-cancelled");
  });

  it("falls back to the neutral badge for a status it does not know", () => {
    // A status added to the contracts before the UI must not render unstyled or
    // blank — the neutral badge plus the raw label is the safe default.
    render(<StatusBadge status="PENDING_REVIEW" />);

    const badge = screen.getByText("PENDING_REVIEW");
    expect(badge.className).toBe("badge badge-unknown");
    expect(badge.textContent).toBe("PENDING_REVIEW");
  });

  it("colours a status from the API and from the contract the same way", () => {
    // `GET /api/jobs` serializes the Prisma enum (`ACTIVE`, `CANCELLED`); the
    // escrow contract returns `Active`. Both have to end up with the same badge.
    const { container } = render(
      <>
        <StatusBadge status="ACTIVE" />
        <StatusBadge status="Active" />
        <StatusBadge status="CANCELLED" />
      </>,
    );

    const classes = [...container.querySelectorAll("span")].map((el) => el.className);
    expect(classes).toEqual([
      "badge badge-active",
      "badge badge-active",
      "badge badge-cancelled",
    ]);
  });

  it("renders verified grant badges with badge-verified class", () => {
    const { rerender } = render(<StatusBadge status="Verified Grant" />);
    expect(screen.getByText("Verified Grant").className).toBe("badge badge-verified");

    rerender(<StatusBadge status="SCF Funded" />);
    expect(screen.getByText("SCF Funded").className).toBe("badge badge-verified");

    rerender(<StatusBadge status="verified" label="Custom Grant" />);
    expect(screen.getByText("Custom Grant").className).toBe("badge badge-verified");
  });
});
