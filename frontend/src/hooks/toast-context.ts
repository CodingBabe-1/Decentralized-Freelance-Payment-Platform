/**
 * toast-context.ts
 *
 * Toast context object + hook, kept separate from the provider component so
 * Fast Refresh works when editing the provider (same split as
 * `wallet-context.ts` / `WalletProvider.tsx`).
 *
 * A toast follows a transaction through its lifecycle:
 *
 *   building → signing → confirmed / failed
 *
 * `building` is the build + simulate call, `signing` is the wallet prompt, and
 * the terminal stages are the submitted transaction or the error the caller
 * would otherwise only see inline. Feedback used to be inline only, so it was
 * easy to miss after navigation (issue #60).
 */

import { createContext, useContext } from "react";

/** The stage a transaction toast is in. */
export type ToastStatus = "building" | "signing" | "confirmed" | "failed";

export interface ToastMeta {
  /** Human-readable asset symbol (e.g. XLM, USDC). */
  assetSymbol?: string;
  /** Formatted human-readable amount (e.g. 100.00). */
  amount?: string;
  /** Token contract ID for linking to contract on stellar.expert. */
  assetContractId?: string;
}

export interface Toast extends ToastMeta {
  id: string;
  status: ToastStatus;
  /** Human-readable line, e.g. `Awaiting signature for release milestone…`. */
  message: string;
  /** Transaction hash, known once the transaction has been submitted. */
  hash?: string;
  /** Unsigned or in-flight transaction XDR for mobile signing fallback (SEP-0007). */
  xdr?: string;
}

/** How long a toast stays on screen once it reaches a terminal stage. */
export const TOAST_AUTO_DISMISS_MS: Record<ToastStatus, number | null> = {
  building: null,
  signing: null,
  confirmed: 8_000,
  failed: 12_000,
};

export interface ToastContextValue {
  toasts: Toast[];
  /** Start a toast and return the id used to advance it through the stages. */
  start: (message: string, meta?: ToastMeta) => string;
  /** Advance a toast; `hash` is recorded once the transaction exists. */
  update: (
    id: string,
    status: ToastStatus,
    message?: string,
    hash?: string,
    xdr?: string,
    meta?: ToastMeta,
  ) => void;
  /** Remove a toast. */
  dismiss: (id: string) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be used within a ToastProvider");
  return ctx;
}
