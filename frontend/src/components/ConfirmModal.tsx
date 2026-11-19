/**
 * ConfirmModal.tsx
 *
 * Pre-flight confirmation modal for irreversible financial transactions
 * such as cancelling escrows or reclaiming disputed / expired funds (issue #259).
 */

import { useEffect } from "react";

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  description: string;
  amount?: string;
  assetSymbol?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDangerous?: boolean;
  isPending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  isOpen,
  title,
  description,
  amount,
  assetSymbol,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  isDangerous = true,
  isPending = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      aria-describedby="confirm-modal-description"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "1rem",
      }}
    >
      <div
        className="modal-card"
        style={{
          background: "var(--card-bg, #1e293b)",
          color: "var(--text, #f8fafc)",
          borderRadius: "0.75rem",
          padding: "1.5rem",
          maxWidth: "480px",
          width: "100%",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
          border: isDangerous ? "1px solid var(--danger, #ef4444)" : "1px solid var(--border, #334155)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1rem",
          }}
        >
          <h3
            id="confirm-modal-title"
            style={{
              margin: 0,
              fontSize: "1.25rem",
              color: isDangerous ? "var(--danger, #ef4444)" : "inherit",
            }}
          >
            {title}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close modal"
            style={{
              background: "none",
              border: "none",
              fontSize: "1.25rem",
              cursor: "pointer",
              color: "inherit",
              padding: "0.25rem",
            }}
          >
            ✕
          </button>
        </div>

        <p id="confirm-modal-description" style={{ margin: "0 0 1rem 0", lineHeight: 1.5 }}>
          {description}
        </p>

        {amount && (
          <div
            style={{
              padding: "0.75rem",
              borderRadius: "0.5rem",
              background: "var(--surface, #0f172a)",
              border: "1px solid var(--border, #334155)",
              marginBottom: "1rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontWeight: 500 }}>Refund Amount:</span>
            <strong style={{ fontSize: "1.1rem" }}>
              {amount} {assetSymbol ?? ""}
            </strong>
          </div>
        )}

        <div
          style={{
            fontSize: "0.85rem",
            color: "var(--muted, #94a3b8)",
            marginBottom: "1.25rem",
            padding: "0.5rem",
            borderLeft: "3px solid var(--danger, #ef4444)",
            background: "rgba(239, 68, 68, 0.1)",
          }}
        >
          <strong>Warning:</strong> This action is permanent and irrevocable on the Stellar blockchain.
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.75rem",
          }}
        >
          <button
            type="button"
            className="btn-secondary"
            onClick={onCancel}
            disabled={isPending}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={isDangerous ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={isPending}
            aria-busy={isPending}
            style={
              isDangerous
                ? {
                    backgroundColor: "var(--danger, #ef4444)",
                    color: "#ffffff",
                    border: "none",
                    padding: "0.5rem 1rem",
                    borderRadius: "0.375rem",
                    cursor: "pointer",
                    fontWeight: 600,
                  }
                : undefined
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
