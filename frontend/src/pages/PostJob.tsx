/**
 * PostJob.tsx
 *
 * Client form to create a new escrow job with a milestone breakdown.
 *
 * Flow:
 *   1. Choose the payment asset, then enter the title, freelancer address,
 *      milestone amounts and expiry.
 *   2. `createAndFund` runs escrow.create() then escrow.fund() on-chain.
 *   3. Persist the off-chain job record via POST /api/jobs (authenticating the
 *      wallet first) so the job — and the asset it pays in — appears in the
 *      Dashboard list, then link the on-chain escrow id.
 *
 * The escrow contract is asset-agnostic; `lib/assets.ts` maps the chosen symbol
 * to its SAC contract id and decimals.
 *
 * Milestone sets can be saved as templates and re-applied here, so a client who
 * posts the same shape of job repeatedly does not retype it (issue #75).
 * Templates live in the browser, keyed per wallet (`lib/templates.ts`).
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import FiatEstimate from "../components/FiatEstimate";
import { useEscrow, type CreateAndFundResult } from "../hooks/useEscrow";
import { useWallet } from "../hooks/wallet-context";
import { ASSETS, formatAmount, getAsset, toBaseUnits } from "../lib/assets";
import { authenticate, createJob, linkEscrowId } from "../lib/api";
import { freelancerFromInvite } from "../lib/invite";
import { MAX_JOB_TAGS, tagsByCategory } from "../lib/tags";
import { CONTRACT_ADDRESSES, explorerTxUrl } from "../lib/stellar";
import {
  deleteTemplate,
  listTemplates,
  saveTemplate,
  type MilestoneTemplate,
} from "../lib/templates";

/** Key used to persist a pending escrow result across page reloads. */
const PENDING_ESCROW_KEY = "postjob_pending_escrow";

/** Key used to persist the job draft form state. */
const DRAFT_KEY = "postjob_draft";

interface PendingEscrow {
  id: string;
  escrowId: number;
  hash: string;
}

interface JobDraft {
  title: string;
  description: string;
  freelancer: string;
  assetSymbol: string;
  expiryDays: string;
  selectedTags: string[];
  rows: MilestoneRow[];
}

interface MilestoneRow {
  amount: string;
  deadline?: string;
}

/** Maximum milestones per escrow — must match `MAX_MILESTONES` in the contract. */
const MAX_MILESTONES = 20;

/**
 * Base units for one row's raw input, treating anything that is not a plain
 * decimal (empty or mid-typing like `.`) as zero so the live total never throws.
 */
function amountToBaseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d*\.?\d+$/.test(trimmed)) return 0n;
  return toBaseUnits(trimmed, decimals);
}

export default function PostJob() {
  const { createAndFund, isPending, error } = useEscrow();
  const { publicKey, connect, connecting, signMessage } = useWallet();

  // Load draft from localStorage or use defaults
  const loadDraft = (): JobDraft => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? (JSON.parse(raw) as JobDraft) : {
        title: "",
        description: "",
        freelancer: "",
        assetSymbol: ASSETS.find((a) => a.contractId)?.symbol ?? ASSETS[0]?.symbol ?? "USDC",
        expiryDays: "30",
        selectedTags: [],
        rows: [{ amount: "" }],
      };
    } catch {
      return {
        title: "",
        description: "",
        freelancer: "",
        assetSymbol: ASSETS.find((a) => a.contractId)?.symbol ?? ASSETS[0]?.symbol ?? "USDC",
        expiryDays: "30",
        selectedTags: [],
        rows: [{ amount: "" }],
      };
    }
  };

  const draft = loadDraft();

  // A freelancer invite link (`?freelancer=G...`, issue #80) wins over a stale
  // draft: opening the link is a deliberate choice, and pre-filling the address
  // is the whole point of it. An invalid value is ignored by the parser.
  const invitedFreelancer = freelancerFromInvite(window.location.search);

  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);
  const [freelancer, setFreelancer] = useState(
    invitedFreelancer ?? draft.freelancer,
  );
  const [assetSymbol, setAssetSymbol] = useState(draft.assetSymbol);
  const [expiryDays, setExpiryDays] = useState(draft.expiryDays);
  const [selectedTags, setSelectedTags] = useState<string[]>(draft.selectedTags);
  const [rows, setRows] = useState<MilestoneRow[]>(draft.rows);
  const [created, setCreated] = useState<CreateAndFundResult | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [pendingEscrow, setPendingEscrow] = useState<PendingEscrow | null>(() => {
    try {
      const raw = localStorage.getItem(PENDING_ESCROW_KEY);
      return raw ? (JSON.parse(raw) as PendingEscrow) : null;
    } catch {
      return null;
    }
  });
  const [isRetrying, setIsRetrying] = useState(false);
  const [templates, setTemplates] = useState<MilestoneTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateNote, setTemplateNote] = useState<string | null>(null);

  const asset = getAsset(assetSymbol);

  // Save draft to localStorage whenever form state changes
  useEffect(() => {
    const currentDraft: JobDraft = {
      title,
      description,
      freelancer,
      assetSymbol,
      expiryDays,
      selectedTags,
      rows,
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(currentDraft));
  }, [title, description, freelancer, assetSymbol, expiryDays, selectedTags, rows]);

  // Warn before unload if the draft has unsaved changes
  useEffect(() => {
    const hasDraftData =
      title.trim() ||
      description.trim() ||
      freelancer.trim() ||
      selectedTags.length > 0 ||
      rows.some((r) => r.amount.trim());

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasDraftData) {
        e.preventDefault();
        e.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [title, description, freelancer, selectedTags, rows]);

  // Templates belong to the connected wallet, so they change when it does.
  useEffect(() => {
    setTemplates(publicKey ? listTemplates(publicKey) : []);
    setSelectedTemplate("");
    setTemplateNote(null);
  }, [publicKey]);

  const updateRow = (i: number, amount: string) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, amount } : row)));

  const updateDeadline = (i: number, deadline: string) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, deadline } : row)));

  const getDeadlineError = (deadlineStr?: string): string | null => {
    if (!deadlineStr || !deadlineStr.trim()) return null;
    const deadlineMs = new Date(deadlineStr).getTime();
    if (isNaN(deadlineMs)) return "Invalid deadline date";
    const nowSec = Math.floor(Date.now() / 1000);
    const deadlineSec = Math.floor(deadlineMs / 1000);
    const expirySec = nowSec + Number(expiryDays) * 86400;
    if (deadlineSec <= nowSec) {
      return "Milestone deadline must be in the future";
    }
    if (deadlineSec >= expirySec) {
      return "Milestone deadline must be earlier than the job expiry date";
    }
    return null;
  };

  /** Toggle a skill tag, never exceeding the cap the API enforces. */
  const toggleTag = (slug: string) =>
    setSelectedTags((prev) =>
      prev.includes(slug)
        ? prev.filter((entry) => entry !== slug)
        : [...prev, slug].slice(0, MAX_JOB_TAGS),
    );

  // Sum in base units and format once, so the on-screen total is the exact value
  // the API stores. Adding decimals as JavaScript numbers shows
  // 0.1 + 0.1 + 0.1 = 0.30000000000000004 and would disagree with the record.
  const total = formatAmount(
    rows.reduce((sum, r) => sum + amountToBaseUnits(r.amount, asset.decimals), 0n),
    asset.decimals,
  );

  /** Milestones with a usable amount, in the asset's base units. */
  const pricedRows = () =>
    rows.filter((row) => amountToBaseUnits(row.amount, asset.decimals) > 0n);

  const canSaveTemplate = publicKey !== null && rows.some((r) => Number(r.amount) > 0);

  /**
   * Restore a saved milestone set: the amounts and, when this build has a SAC
   * for it, the asset they were written in. An asset without a configured SAC
   * is left alone rather than selected — a disabled option would block submit.
   */
  function applyTemplate(id: string) {
    const template = templates.find((entry) => entry.id === id);
    if (!template) return;

    const savedAsset = ASSETS.find((entry) => entry.symbol === template.asset);
    if (savedAsset?.contractId) setAssetSymbol(savedAsset.symbol);
    setRows(
      template.milestones.length > 0
        ? template.milestones.map((milestone) => ({ amount: milestone.amount, deadline: "" }))
        : [{ amount: "" }],
    );
    setTemplateNote(`Applied “${template.name}”.`);
  }

  function handleSaveTemplate() {
    if (!publicKey || !canSaveTemplate) return;
    const saved = saveTemplate(publicKey, {
      name: templateName,
      asset: asset.symbol,
      milestones: pricedRows().map((row) => ({ amount: row.amount })),
    });
    if (!saved) {
      setTemplateNote("Could not save the template — give it a name first.");
      return;
    }
    setTemplates(listTemplates(publicKey));
    setSelectedTemplate(saved.id);
    setTemplateName("");
    setTemplateNote(`Saved template “${saved.name}”.`);
  }

  function handleDeleteTemplate() {
    if (!publicKey || !selectedTemplate) return;
    deleteTemplate(publicKey, selectedTemplate);
    setTemplates(listTemplates(publicKey));
    setSelectedTemplate("");
    setTemplateNote("Template deleted.");
  }

  /**
   * Links the off-chain job record to an already-funded on-chain escrow.
   * Called both from handleSubmit (first attempt) and the retry button.
   */
  async function linkOffChain(
    result: CreateAndFundResult,
    formData: {
      title: string;
      description: string;
      expirySeconds: number;
      milestones: Array<{ description: string; amount: string; deadline: string }>;
    },
  ) {
    setRecordError(null);
    try {
      const token = await authenticate(publicKey!, signMessage);
      const expiresAt = new Date(formData.expirySeconds * 1000).toISOString();
      const job = await createJob(
        {
          title: formData.title,
          description: formData.description,
          asset: asset.symbol,
          tags: selectedTags,
          expiresAt,
          milestones: formData.milestones,
        },
        token,
      );
      await linkEscrowId(job.id, Number(result.id), token);
      // Success — remove the recovery entry so the retry banner disappears.
      localStorage.removeItem(PENDING_ESCROW_KEY);
      setPendingEscrow(null);
      // Clear the draft since the job was successfully created
      localStorage.removeItem(DRAFT_KEY);
    } catch (e) {
      setRecordError(
        e instanceof Error ? e.message : "Could not save the job record",
      );
    }
  }

  /** Retry linking an already-funded escrow whose off-chain record was not saved. */
  async function handleRetryLink() {
    if (!pendingEscrow || !publicKey) return;
    setIsRetrying(true);
    try {
      const token = await authenticate(publicKey, signMessage);
      await linkEscrowId(pendingEscrow.id, pendingEscrow.escrowId, token);
      localStorage.removeItem(PENDING_ESCROW_KEY);
      setPendingEscrow(null);
      setRecordError(null);
    } catch (e) {
      setRecordError(
        e instanceof Error ? e.message : "Retry failed — please try again",
      );
    } finally {
      setIsRetrying(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) {
      await connect();
      return;
    }
    if (!asset.contractId) return;
    if (rows.some((r) => !(Number(r.amount) > 0))) return;
    if (rows.some((r) => getDeadlineError(r.deadline) !== null)) return;

    setRecordError(null);
    const expirySeconds = Math.floor(Date.now() / 1000) + Number(expiryDays) * 86400;
    const expiry = BigInt(expirySeconds);

    // 1. On-chain: create + fund the escrow.
    const result = await createAndFund(
      freelancer.trim(),
      asset.contractId,
      rows.map((r) => {
        let deadline = 0n;
        if (r.deadline && r.deadline.trim()) {
          const sec = Math.floor(new Date(r.deadline).getTime() / 1000);
          if (!isNaN(sec) && sec > 0) {
            deadline = BigInt(sec);
          }
        }
        return {
          amount: toBaseUnits(r.amount, asset.decimals),
          deadline,
        };
      }),
      expiry,
    );
    if (!result) return;
    setCreated(result);

    // Persist the escrow result to localStorage immediately so the user can
    // recover if the off-chain step fails and the page is closed or refreshed.
    const pending: PendingEscrow = {
      id: result.id.toString(),
      escrowId: Number(result.id),
      hash: result.hash,
    };
    localStorage.setItem(PENDING_ESCROW_KEY, JSON.stringify(pending));

    // 2. Off-chain: store the job record (and its asset) and link the escrow.
    const expiresAt = new Date(expirySeconds * 1000).toISOString();
    await linkOffChain(result, {
      title: title.trim(),
      description: description.trim(),
      expirySeconds,
      milestones: rows.map((r, i) => {
        let milestoneDeadline = expiresAt;
        if (r.deadline && r.deadline.trim()) {
          const d = new Date(r.deadline);
          if (!isNaN(d.getTime())) {
            milestoneDeadline = d.toISOString();
          }
        }
        return {
          description: `Milestone ${i + 1}`,
          amount: formatAmount(
            amountToBaseUnits(r.amount, asset.decimals),
            asset.decimals,
          ),
          deadline: milestoneDeadline,
        };
      }),
    });
  }

  return (
    <Layout>
      <h1>Post a Job</h1>

      {!CONTRACT_ADDRESSES.escrow && (
        <p role="alert" className="alert alert-error">
          No escrow contract configured. Run <code>scripts/deploy_testnet.sh</code> or
          set <code>VITE_ESCROW_CONTRACT_ID</code> in <code>.env</code>.
        </p>
      )}
      {!asset.contractId && (
        <p role="alert" className="alert alert-error">
          No contract configured for {asset.symbol}. Set{" "}
          <code>VITE_{asset.symbol}_CONTRACT_ID</code> in <code>.env</code>.
        </p>
      )}

      <form onSubmit={handleSubmit}>
        <p>
          <label htmlFor="post-job-title">
            Title
            <input
              id="post-job-title"
              className="form-control"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Landing page redesign"
              minLength={3}
              maxLength={120}
              required
            />
          </label>
        </p>

        <p>
          <label htmlFor="post-job-description">
            Description
            <textarea
              id="post-job-description"
              className="form-control"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What needs to be delivered…"
              minLength={10}
              rows={3}
              required
            />
          </label>
        </p>

        <fieldset>
          <legend>
            Skills ({selectedTags.length}/{MAX_JOB_TAGS})
          </legend>
          <p className="muted">
            Tag the work so clients and freelancers can filter for it. Selection is
            optional.
          </p>
          {tagsByCategory().map(({ category, tags }) => (
            <div key={category} className="tag-group">
              <strong>{category}</strong>
              <div>
                {tags.map((skill) => {
                  const checked = selectedTags.includes(skill.slug);
                  return (
                    <label key={skill.slug} className="tag-option">
                      <input
                        type="checkbox"
                        checked={checked}
                        // At the cap the remaining boxes lock, so the selection
                        // can never be rejected by the API on submit.
                        disabled={!checked && selectedTags.length >= MAX_JOB_TAGS}
                        onChange={() => toggleTag(skill.slug)}
                      />{" "}
                      {skill.label}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </fieldset>

        <p>
          <label htmlFor="post-job-asset">
            Payment asset{" "}
            <select
              id="post-job-asset"
              value={assetSymbol}
              onChange={(e) => setAssetSymbol(e.target.value)}
            >
              {ASSETS.map((a) => (
                <option key={a.symbol} value={a.symbol} disabled={!a.contractId}>
                  {a.symbol}
                  {a.contractId ? "" : " (not configured)"}
                </option>
              ))}
            </select>
          </label>
          <br />
          <span className="muted">
            This job will be escrowed in <strong>{asset.symbol}</strong> via token{" "}
            <code>{asset.contractId || "(not configured)"}</code>.
          </span>
        </p>

        {invitedFreelancer && freelancer === invitedFreelancer && (
          <p className="alert" role="status">
            Freelancer address pre-filled from an invite link. You can edit it
            before creating the job.
          </p>
        )}

        <p>
          <label htmlFor="post-job-freelancer">
            Freelancer Stellar address
            <input
              id="post-job-freelancer"
              className="form-control"
              value={freelancer}
              onChange={(e) => setFreelancer(e.target.value)}
              placeholder="G..."
              required
            />
          </label>
        </p>

        <fieldset>
          <legend>Templates</legend>
          {!publicKey ? (
            <p className="muted">Connect your wallet to save and reuse milestone templates.</p>
          ) : (
            <>
              {templates.length === 0 ? (
                <p className="muted">No saved templates yet.</p>
              ) : (
                <p>
                  <label>
                    Saved template{" "}
                    <select
                      value={selectedTemplate}
                      onChange={(e) => setSelectedTemplate(e.target.value)}
                    >
                      <option value="">Choose…</option>
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name} ({template.milestones.length} milestones,{" "}
                          {template.asset})
                        </option>
                      ))}
                    </select>
                  </label>{" "}
                  <button
                    type="button"
                    onClick={() => applyTemplate(selectedTemplate)}
                    disabled={!selectedTemplate}
                  >
                    Apply template
                  </button>{" "}
                  <button
                    type="button"
                    onClick={handleDeleteTemplate}
                    disabled={!selectedTemplate}
                  >
                    Delete
                  </button>
                </p>
              )}

              <p>
                <label>
                  Save these milestones as{" "}
                  <input
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="Weekly retainer"
                    maxLength={60}
                  />
                </label>{" "}
                <button
                  type="button"
                  onClick={handleSaveTemplate}
                  disabled={templateName.trim().length === 0 || !canSaveTemplate}
                >
                  Save template
                </button>
              </p>
              {templateNote && (
                <p className="muted" role="status">
                  {templateNote}
                </p>
              )}
            </>
          )}
        </fieldset>

        <fieldset>
          <legend>Milestones ({asset.symbol})</legend>
          {rows.map((row, i) => (
            <div key={i} className="milestone-row" style={{ marginBottom: "1rem" }}>
              <label htmlFor={`milestone-amount-${i}`}>
                Amount #{i + 1}{" "}
                <input
                  id={`milestone-amount-${i}`}
                  type="number"
                  min="0"
                  step={`0.${"0".repeat(asset.decimals - 1)}1`}
                  value={row.amount}
                  onChange={(e) => updateRow(i, e.target.value)}
                  required
                />
              </label>{" "}
              <label htmlFor={`milestone-deadline-${i}`} style={{ marginLeft: "0.5rem" }}>
                Target deadline #{i + 1}{" "}
                <input
                  id={`milestone-deadline-${i}`}
                  type="date"
                  value={row.deadline || ""}
                  onChange={(e) => updateDeadline(i, e.target.value)}
                />
              </label>{" "}
              {rows.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove milestone ${i + 1}`}
                  onClick={() => setRows((r) => r.filter((_, x) => x !== i))}
                >
                  Remove
                </button>
              )}
              {getDeadlineError(row.deadline) && (
                <div
                  className="error"
                  role="alert"
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--danger, #ef4444)",
                    marginTop: "0.25rem",
                  }}
                >
                  {getDeadlineError(row.deadline)}
                </div>
              )}
            </div>
          ))}
          <button type="button" onClick={() => setRows((r) => [...r, { amount: "" }])} disabled={rows.length >= MAX_MILESTONES}>
            Add milestone
          </button>
          {rows.length >= MAX_MILESTONES && (
            <p className="muted">Maximum of {MAX_MILESTONES} milestones reached.</p>
          )}
          <p>
            Total: <strong>{total}</strong> {asset.symbol}{" "}
            <FiatEstimate amount={total} asset={asset.symbol} />
          </p>
        </fieldset>

        <p>
          <label htmlFor="post-job-expiry">
            Expiry (days from now){" "}
            <input
              id="post-job-expiry"
              type="number"
              min="1"
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)}
            />
          </label>
        </p>

        <button
          type="submit"
          className="btn-primary"
          disabled={isPending("create") || connecting || !asset.contractId}
          aria-busy={isPending("create")}
        >
          {isPending("create")
            ? "Submitting…"
            : publicKey
              ? "Create & Fund Escrow"
              : "Connect & Continue"}
        </button>
      </form>

      {error && (
        <p role="alert" aria-live="assertive" className="alert alert-error">
          {error}
        </p>
      )}

      {created && (
        <p role="status" aria-live="polite" className="alert">
          Escrow #{created.id.toString()} created and funded. Transaction{" "}
          <a
            href={explorerTxUrl(created.hash)}
            target="_blank"
            rel="noreferrer"
            title={created.hash}
          >
            <code>{created.hash.slice(0, 12)}…</code>
          </a>{" "}
          <Link to={`/jobs/${created.id}`}>Open job →</Link>
        </p>
      )}

      {recordError && (
        <p role="alert" aria-live="assertive" className="alert alert-error">
          On-chain escrow created, but the job record was not saved: {recordError}
          {pendingEscrow && publicKey && (
            <>
              {" "}
              <button
                type="button"
                className="btn-primary"
                onClick={handleRetryLink}
                disabled={isRetrying}
                aria-busy={isRetrying}
              >
                {isRetrying ? "Retrying…" : "Retry Linking"}
              </button>{" "}
              <span className="muted">
                (escrow #{pendingEscrow.escrowId}, tx{" "}
                <a
                  href={explorerTxUrl(pendingEscrow.hash)}
                  target="_blank"
                  rel="noreferrer"
                  title={pendingEscrow.hash}
                >
                  <code>{pendingEscrow.hash.slice(0, 12)}…</code>
                </a>
                )
              </span>
            </>
          )}
        </p>
      )}

      {/* Recovery banner shown on page reload when a previous funding succeeded
          but the off-chain linking step was not completed. */}
      {pendingEscrow && !recordError && !created && (
        <div role="alert" aria-live="polite" className="alert alert-error">
          <strong>Unlinked escrow detected.</strong> A previous funding transaction
          (escrow #{pendingEscrow.escrowId},{" "}
          <a
            href={explorerTxUrl(pendingEscrow.hash)}
            target="_blank"
            rel="noreferrer"
            title={pendingEscrow.hash}
          >
            <code>{pendingEscrow.hash.slice(0, 12)}…</code>
          </a>
          ) was not linked to a job record. Connect your wallet and click{" "}
          <strong>Retry Linking</strong> to recover.
          {publicKey && (
            <>
              {" "}
              <button
                type="button"
                className="btn-primary"
                onClick={handleRetryLink}
                disabled={isRetrying}
                aria-busy={isRetrying}
              >
                {isRetrying ? "Retrying…" : "Retry Linking"}
              </button>
            </>
          )}
        </div>
      )}
    </Layout>
  );
}
