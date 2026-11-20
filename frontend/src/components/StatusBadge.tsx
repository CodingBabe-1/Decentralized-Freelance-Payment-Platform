/**
 * StatusBadge.tsx
 *
 * Renders an escrow status with a distinct colour per state. Unknown statuses
 * fall back to a neutral badge rather than throwing.
 *
 * Contributor Notes:
 * - The two sources disagree on case: the escrow contract returns
 *   `EscrowStatus`'s `Debug` form (`Active`), while `GET /api/jobs` serializes
 *   the Prisma enum (`ACTIVE`). Looking the status up case-insensitively means
 *   the dashboard's list is colour-coded too, instead of every row falling
 *   through to the neutral badge.
 * - The API has two statuses the on-chain escrow does not: `FUNDED` (the
 *   moment `fund` lands, before the first milestone release) and `CANCELLED`
 *   (an unfunded, off-chain job). Both are shown by the dashboard and profile,
 *   so they get their own colour instead of the neutral fallback.
 */

const STATUS_CLASS: Record<string, string> = {
  created: "badge badge-created",
  funded: "badge badge-funded",
  active: "badge badge-active",
  completed: "badge badge-completed",
  disputed: "badge badge-disputed",
  refunded: "badge badge-refunded",
  cancelled: "badge badge-cancelled",
  canceled: "badge badge-cancelled",
  verified: "badge badge-verified",
  "verified grant": "badge badge-verified",
  "scf funded": "badge badge-verified",
};

export default function StatusBadge({ status, label }: { status: string; label?: string }) {
  const lower = status.toLowerCase();
  let className = STATUS_CLASS[lower];
  if (!className) {
    if (lower.includes("verified") || lower.includes("scf") || lower.includes("grant")) {
      className = "badge badge-verified";
    } else {
      className = "badge badge-unknown";
    }
  }
  return <span className={className}>{label ?? status}</span>;
}
