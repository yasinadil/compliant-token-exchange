// instrumentation.ts
// Next.js calls `register()` exactly once per server process, at startup
// (see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation).
//
// We use it to emit deprecation / security warnings that must surface even
// if nothing else in the process has imported the relevant module yet.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.OPERATOR_WALLET_PRIVATE_KEY) {
    console.warn(
      "[startup] OPERATOR_WALLET_PRIVATE_KEY is set in the environment but is " +
        "no longer used. The operator wallet is now managed in the Admin Panel " +
        "(platform_wallets table, AES-256-GCM encrypted). Remove this env var " +
        "to avoid leaving a stale private key in process state."
    );
  }

  // Optional in-process outbox worker (OUTBOX_INPROCESS_WORKER=1). No-op unless
  // both the feature and the outbox are enabled. Dynamically imported so the
  // server-only module never loads in the edge runtime.
  try {
    const { startInProcessOutboxWorker } = await import(
      "./app/lib/sync-outbox-worker"
    );
    startInProcessOutboxWorker();
  } catch (err) {
    console.error("[startup] failed to start in-process outbox worker:", err);
  }
}
