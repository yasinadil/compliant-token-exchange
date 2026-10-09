"use client";

// components/Toast.tsx
//
// Bottom-right stacked toast viewport used by the Exchange and Staking
// pages for post-action messages and in-flight order indicators.
//
// Two flavours:
//   • Transient toasts (default): 15 s auto-close + X button → dismiss
//   • Collapsible toasts (in-flight indicators): stay expanded indefinitely
//     so the user always sees live status. X collapses to a compact pill
//     (icon + title) that re-expands on click. They only fully disappear
//     when the parent removes them from the array (e.g. order completes
//     and polling clears its state).
//
// No context provider — pages own their `Toast[]` state and pass it in.

import { useEffect, useRef, useState } from "react";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface Toast {
  /** Stable id so React can track per-card timers across re-renders. */
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  /**
   * If true, the X button + 15 s timer collapse the toast to a compact
   * pill instead of dismissing it. The pill re-expands on click. The
   * toast only fully disappears when the parent removes its id from
   * the array.
   */
  collapsible?: boolean;
  /**
   * Optional inline action button shown beneath the description. Use
   * for toasts that offer the user a single-click follow-up — e.g. the
   * in-flight cashout toast exposing "Cancel sale" so users can trigger
   * the refund immediately instead of waiting for the 2-hour timeout
   * sweep. Set `loading` to true while the action is in flight to
   * disable the button and show a "Working…" label.
   */
  action?: {
    label: string;
    onClick: () => void | Promise<void>;
    loading?: boolean;
    /**
     * Visual weight. "primary" (default) is the solid blue CTA;
     * "secondary" is a quieter white button with a grey border for the
     * lower-emphasis choice when two actions sit side by side.
     */
    tone?: "primary" | "secondary";
  };
  /**
   * Optional secondary action rendered alongside `action`. Defaults to
   * the same blue primary look as `action`; pass `tone` on either button
   * to differentiate them (e.g. on the in-flight cashout toast "Cancel
   * sale" stays blue while "Reopen tutorial" uses the quieter
   * white/grey-border `tone: "secondary"`).
   */
  secondaryAction?: {
    label: string;
    onClick: () => void | Promise<void>;
    loading?: boolean;
    tone?: "primary" | "secondary";
  };
}

const AUTO_CLOSE_MS = 15_000;

// Inline action-button styling. `primary` (default) is the solid blue
// CTA; `secondary` is a quieter white button with a grey border, used
// when one of two adjacent actions should read as the lower-emphasis
// choice. Loading state overrides both with a disabled grey look.
function actionButtonClass(
  loading: boolean | undefined,
  tone: "primary" | "secondary" = "primary"
): string {
  const base =
    "inline-flex h-7 items-center rounded-md px-3 text-[12px] font-semibold transition-colors";
  if (loading) {
    return `${base} bg-[#D8DEE7] text-[#738094] cursor-not-allowed`;
  }
  if (tone === "secondary") {
    return `${base} border-2 border-[#E5E7EB] bg-white text-[#374151] hover:bg-[#F9FAFB] cursor-pointer`;
  }
  return `${base} bg-[#0EA5E9] text-white hover:bg-[#0284C7] cursor-pointer`;
}

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col-reverse gap-3 sm:max-w-sm"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const [shown, setShown] = useState(false);
  const [expanded, setExpanded] = useState(true);

  // Stash `onDismiss` in a ref so the timer effect below doesn't need
  // it in its dep array. Parents on this app re-render frequently (the
  // Exchange page polls in-flight orders every 6–15 s) which would
  // otherwise reset the 15 s timer on every parent render → toast
  // would never reach the auto-close / auto-collapse point.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  // Slide-in transition on mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Auto-dismiss timer for transient toasts only. In-flight indicators
  // (collapsible toasts) stay expanded indefinitely — the user keeps
  // visibility on the live status until they explicitly press X to
  // collapse, or until the parent clears the toast on order completion.
  useEffect(() => {
    if (!expanded) return;
    if (toast.collapsible) return;
    const id = setTimeout(() => {
      onDismissRef.current(toast.id);
    }, AUTO_CLOSE_MS);
    return () => clearTimeout(id);
  }, [expanded, toast.id, toast.collapsible]);

  // If the description text changes while we're collapsed (e.g. an
  // in-flight order transitions awaiting_transak → crypto_sent), pop
  // back open so the user notices the new status.
  useEffect(() => {
    if (toast.collapsible && !expanded) {
      setExpanded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.description]);

  const handleXClick = () => {
    if (toast.collapsible) {
      setExpanded(false);
    } else {
      onDismissRef.current(toast.id);
    }
  };

  // Collapsible toasts are the in-flight order indicators — show an animated
  // spinner instead of the static info circle so it's immediately visually
  // obvious that something is still happening. Transient (post-action) toasts
  // keep their variant icons (success / warning / error / info).
  const leadingIcon = toast.collapsible ? (
    <SpinnerIcon />
  ) : (
    <VariantIcon variant={toast.variant} />
  );

  if (!expanded) {
    // Compact pill — only collapsible toasts ever reach this branch.
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={`Expand ${toast.title}`}
        className={
          "pointer-events-auto flex items-center gap-2 self-end rounded-full border border-[#E5E7EB] bg-white px-3 py-2 shadow-md transition-all duration-300 ease-out hover:bg-[#F9FAFB] " +
          (shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0")
        }
      >
        {leadingIcon}
        <span className="font-sans text-[13px] font-semibold text-[#111827]">
          {toast.title}
        </span>
      </button>
    );
  }

  return (
    <div
      role={toast.variant === "error" ? "alert" : "status"}
      className={
        "pointer-events-auto flex items-start gap-3 rounded-[10px] border border-[#E5E7EB] bg-white px-4 py-3 shadow-lg transition-all duration-300 ease-out " +
        (shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0")
      }
    >
      {leadingIcon}
      <div className="min-w-0 flex-1">
        <p className="font-sans text-[14px] font-semibold leading-tight text-[#111827]">
          {toast.title}
        </p>
        {toast.description && (
          <div className="mt-1 space-y-2 text-[13px] leading-snug text-[#6B7280]">
            {toast.description.split("\n").map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
        )}
        {(toast.action || toast.secondaryAction) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {toast.action && (
              <button
                type="button"
                onClick={() => void toast.action!.onClick()}
                disabled={toast.action.loading}
                className={actionButtonClass(
                  toast.action.loading,
                  toast.action.tone
                )}
              >
                {toast.action.loading ? "Working…" : toast.action.label}
              </button>
            )}
            {toast.secondaryAction && (
              <button
                type="button"
                onClick={() => void toast.secondaryAction!.onClick()}
                disabled={toast.secondaryAction.loading}
                className={actionButtonClass(
                  toast.secondaryAction.loading,
                  toast.secondaryAction.tone
                )}
              >
                {toast.secondaryAction.loading ? "Working…" : toast.secondaryAction.label}
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={handleXClick}
        aria-label={
          toast.collapsible ? "Collapse notification" : "Dismiss notification"
        }
        className="shrink-0 rounded p-0.5 text-[#9CA3AF] transition-colors hover:bg-[#F3F4F6] hover:text-[#4B5563]"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function VariantIcon({ variant }: { variant: ToastVariant }) {
  const fill =
    variant === "success"
      ? "#10B981"
      : variant === "warning"
      ? "#F59E0B"
      : variant === "error"
      ? "#EF4444"
      : "#111827";

  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="mt-0.5 shrink-0"
      aria-hidden
    >
      <circle cx="10" cy="10" r="10" fill={fill} />
      {variant === "success" && (
        <path
          d="M6 10.5l2.5 2.5L14 7.5"
          stroke="white"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {variant === "warning" && (
        <>
          <rect x="9.1" y="5.5" width="1.8" height="6" rx="0.9" fill="white" />
          <circle cx="10" cy="13.6" r="1" fill="white" />
        </>
      )}
      {variant === "error" && (
        <path
          d="M6.5 6.5l7 7M13.5 6.5l-7 7"
          stroke="white"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
      {variant === "info" && (
        <>
          <circle cx="10" cy="6.5" r="1" fill="white" />
          <rect x="9.1" y="8.5" width="1.8" height="6" rx="0.9" fill="white" />
        </>
      )}
    </svg>
  );
}

/**
 * Animated circular spinner used as the leading icon on in-flight toasts.
 * Sized + positioned to match `VariantIcon` (20×20, `mt-0.5 shrink-0`) so
 * swapping between the two doesn't shift the toast's layout. Uses the
 * app's primary accent so it reads as "active progress" rather than
 * generic info.
 */
function SpinnerIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="mt-0.5 shrink-0 animate-spin text-[#0EA5E9]"
      aria-hidden
    >
      {/* Faded full ring + bright leading arc give the rotation a clear
          direction of travel without the spinner looking gappy when paused. */}
      <circle
        cx="10"
        cy="10"
        r="8"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <path
        d="M18 10a8 8 0 0 0-8-8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
