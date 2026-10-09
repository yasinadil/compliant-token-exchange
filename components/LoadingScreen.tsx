// components/LoadingScreen.tsx
//
// Shared loading screen used across Dashboard / Exchange / Staking so
// the initial-load UX is identical: a centered spinner + a short label
// describing what's loading.

export function LoadingScreen({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-[var(--ex-accent)] border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-[var(--ex-text-muted)]">{text}</p>
      </div>
    </div>
  );
}
