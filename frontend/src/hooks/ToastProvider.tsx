/**
 * ToastProvider.tsx
 *
 * Holds the live toast list and the transitions between stages. See
 * `toast-context.ts` for the context object and the `useToasts` hook.
 *
 * Contributor Notes:
 * - Terminal stages (confirmed / failed) auto-dismiss on a timer, while the
 *   in-flight stages stay until the operation settles — a toast that vanished
 *   mid-signature would defeat the point of surfacing it.
 * - Timers are tracked per id so a manual dismiss (or a second update) cancels
 *   the pending one instead of removing a toast the user is still reading.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  TOAST_AUTO_DISMISS_MS,
  ToastContext,
  type Toast,
  type ToastMeta,
  type ToastStatus,
} from "./toast-context";

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, number>());
  // A counter, not `crypto.randomUUID`: jsdom (the test environment) does not
  // implement `randomUUID`, and the ids only need to be unique within the page.
  const counter = useRef(0);

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const start = useCallback((message: string, meta?: ToastMeta) => {
    counter.current += 1;
    const id = `toast-${counter.current}`;
    setToasts((prev) => [...prev, { id, status: "building", message, ...meta }]);
    return id;
  }, []);

  const update = useCallback(
    (
      id: string,
      status: ToastStatus,
      message?: string,
      hash?: string,
      xdr?: string,
      meta?: ToastMeta,
    ) => {
      setToasts((prev) =>
        prev.map((toast) =>
          toast.id === id
            ? {
                ...toast,
                status,
                message: message ?? toast.message,
                ...(hash ? { hash } : {}),
                ...(xdr !== undefined ? { xdr } : {}),
                ...(meta?.assetSymbol !== undefined ? { assetSymbol: meta.assetSymbol } : {}),
                ...(meta?.amount !== undefined ? { amount: meta.amount } : {}),
                ...(meta?.assetContractId !== undefined ? { assetContractId: meta.assetContractId } : {}),
              }
            : toast,
        ),
      );
      const autoDismiss = TOAST_AUTO_DISMISS_MS[status];
      if (autoDismiss !== null) {
        clearTimer(id);
        timers.current.set(id, window.setTimeout(() => dismiss(id), autoDismiss));
      }
    },
    [clearTimer, dismiss],
  );

  // Timers outlive an unmount otherwise, and removing a toast from a torn-down
  // provider would set state on a component the user already navigated away from.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo(
    () => ({ toasts, start, update, dismiss }),
    [toasts, start, update, dismiss],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}
