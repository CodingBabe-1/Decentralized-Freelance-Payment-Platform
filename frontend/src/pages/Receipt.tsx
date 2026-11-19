/**
 * Receipt.tsx
 *
 * A printable, exportable record of one escrow (issue #77): the parties, the
 * milestone breakdown with what has been released, and every indexed action with
 * a link to its transaction.
 *
 * Contributor Notes:
 * - The route param is the on-chain escrow id, like `/jobs/:id`. The data comes
 *   from `GET /api/escrow/:escrowId/receipt`, which is built from indexed state,
 *   so a receipt can be opened and exported without a connected wallet.
 * - "Printable" is the browser's own print-to-PDF (`window.print()`); "exportable"
 *   is a self-contained HTML file (`buildReceiptHtml` in lib/receipt.ts), so the
 *   client keeps a copy that opens offline.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import StatusBadge from "../components/StatusBadge";
import { fetchReceipt, type EscrowReceiptApi } from "../lib/api";
import { actionLabel } from "../lib/activity";
import { explorerTxUrl } from "../lib/stellar";
import { formatDateTime } from "../lib/time";
import { buildReceiptHtml } from "../lib/receipt";

/** Save the receipt as a standalone HTML file the client can keep. */
function downloadReceipt(receipt: EscrowReceiptApi): void {
  const blob = new Blob([buildReceiptHtml(receipt)], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `escrow-${receipt.escrowId}-receipt.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function Receipt() {
  const { id } = useParams<{ id: string }>();
  const [receipt, setReceipt] = useState<EscrowReceiptApi | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    setError(null);
    try {
      setReceipt(await fetchReceipt(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!id) {
    return (
      <Layout>
        <p>Invalid escrow id.</p>
      </Layout>
    );
  }

  return (
    <Layout>
      <h1>Escrow receipt #{id}</h1>

      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}

      {!receipt && !error && <p>Loading receipt…</p>}

      {receipt && (
        <>
          {/*
            Buttons the browser's print flow and the file export use; the printed
            page itself is the receipt below them.
          */}
          <p className="receipt-actions">
            <button onClick={() => window.print()}>Print / Save as PDF</button>{" "}
            <button onClick={() => downloadReceipt(receipt)}>Download receipt</button>{" "}
            <Link to={`/jobs/${receipt.escrowId}`}>Back to job</Link>
          </p>

          <section className="receipt">
            <h2>{receipt.job.title}</h2>
            <p className="muted">
              Generated <time dateTime={receipt.generatedAt}>{formatDateTime(receipt.generatedAt)}</time>
            </p>
            <dl>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={receipt.job.status} />
              </dd>
              <dt>Client</dt>
              <dd>{receipt.job.client?.stellarAddress ?? "—"}</dd>
              <dt>Freelancer</dt>
              <dd>{receipt.job.freelancer?.stellarAddress ?? "—"}</dd>
              <dt>Total</dt>
              <dd>
                {receipt.job.totalAmount} {receipt.job.asset}
              </dd>
              <dt>Released</dt>
              <dd>
                {receipt.totals.released} {receipt.job.asset}
              </dd>
              <dt>Outstanding</dt>
              <dd>
                {receipt.totals.outstanding} {receipt.job.asset}
              </dd>
            </dl>

            <h3>Milestones</h3>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Released</th>
                </tr>
              </thead>
              <tbody>
                {receipt.milestones.map((milestone) => (
                  <tr key={milestone.index}>
                    <td>{milestone.index + 1}</td>
                    <td>{milestone.description ?? "—"}</td>
                    <td>
                      {milestone.amount} {receipt.job.asset}
                    </td>
                    <td>{milestone.status}</td>
                    <td>
                      {milestone.releasedAt ? (
                        <time dateTime={milestone.releasedAt}>
                          {formatDateTime(milestone.releasedAt)}
                        </time>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Transactions</h3>
            {receipt.events.length === 0 ? (
              <p className="muted">No indexed transactions for this escrow yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Action</th>
                    <th>Amount</th>
                    <th>Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {receipt.events.map((event) => (
                    <tr key={event.id}>
                      <td>
                        <time dateTime={event.createdAt}>
                          {formatDateTime(event.createdAt)}
                        </time>
                      </td>
                      <td>{actionLabel(event.action)}</td>
                      <td>{event.amount === null ? "—" : `${event.amount} ${receipt.job.asset}`}</td>
                      <td>
                        {event.txHash ? (
                          <a
                            href={explorerTxUrl(event.txHash)}
                            target="_blank"
                            rel="noreferrer"
                            title={event.txHash}
                          >
                            <code>{event.txHash.slice(0, 16)}…</code>
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </Layout>
  );
}
