/**
 * First 4 bytes of keccak256(errorSignature) for PermissionedAMM + common dependencies.
 * Bundlers often return only these hex selectors (e.g. UserOperation simulation).
 */
const REVERT_SELECTOR_MESSAGES: Record<string, string> = {
  // OpenZeppelin Pausable (PermissionedAMM)
  "0xd93c0665": "The liquidity pool is paused. Swaps are temporarily disabled.",
  // ImpactPolicy.validateImpact when policy is paused (separate from vault pause)
  "0x52a39d6a": "Price impact rules are paused. Swaps are temporarily disabled.",
  // PermissionedAMM (canonical Solidity signatures)
  "0x11ce188a":
    "The pool is not in the correct phase for this action (e.g. not ACTIVE).",
  "0xb56e0117": "Compliance check failed for this swap.",
  "0x43f4d600": "Treasury accounts cannot perform this swap.",
  "0xb320a4da": "Insufficient liquidity in the pool for this trade size.",
  "0xf341b523":
    "Price impact is too high for this trade size under the pool’s tiered rules (stricter limits for larger notionals). Try a smaller trade, split the order, or retry when liquidity is deeper.",
  "0x0ff58908": "Invalid swap amount.",
  "0xe0a0dff0":
    "Output amount below your minimum (slippage or price impact). Try a smaller trade or higher slippage.",
  "0x9eced65d": "A contract address was zero — configuration error.",
  "0x01bd3e9b": "Invalid fee parameter.",
  "0xc4ccf4bb": "This trade would exceed the user’s daily trading limit.",
  "0x17f11789":
    "Direct swaps via swap() are disabled on the pool. Operator swaps use a different path — contact support if this persists.",
  // OpenZeppelin AccessControl
  "0xe2517d3f":
    "On-chain authorization failed (e.g. missing OPERATOR_ROLE on the vault for the smart account).",
};

function messageFromRevertSelectors(message: string): string | null {
  const lower = message.toLowerCase();
  /** Prefer more specific / common failures first */
  const priority: string[] = [
    "0xd93c0665",
    "0x52a39d6a",
    "0xe2517d3f",
    "0xb56e0117",
    "0x11ce188a",
    "0xb320a4da",
    "0xe0a0dff0",
    "0xf341b523",
    "0x17f11789",
    "0x43f4d600",
    "0x0ff58908",
    "0x9eced65d",
    "0x01bd3e9b",
    "0xc4ccf4bb",
  ];
  for (const sel of priority) {
    if (lower.includes(sel)) {
      return REVERT_SELECTOR_MESSAGES[sel] ?? null;
    }
  }
  for (const [sel, human] of Object.entries(REVERT_SELECTOR_MESSAGES)) {
    if (lower.includes(sel)) return human;
  }
  return null;
}

/** Pimlico / bundler errors dump callData and repeat the same line — collapse to one user-facing line. */
const USER_OP_SIMULATION_BLOB_PREFIX =
  /^Execution reverted with reason:\s*UserOperation reverted during simulation/i;

const GENERIC_USER_OP_SIMULATION_MESSAGE =
  "We couldn't complete this trade. Please try again later.";

/**
 * Normalize on-chain / operator execution errors for trade_orders.failure_reason
 * and client-facing ProcessResult.error strings.
 */
export function formatTradeExecutionError(error: unknown): string {
  if (error === null || error === undefined) {
    return "Trade execution failed.";
  }

  let combined = "";
  if (typeof error === "string") {
    combined = error;
  } else if (error instanceof Error) {
    const short = (error as { shortMessage?: string }).shortMessage;
    const details = (error as { details?: string }).details;
    combined = [short, error.message, details].filter(Boolean).join(" ");
  } else {
    combined = String(error);
  }

  const m = combined.trim();
  if (!m) {
    return "Trade execution failed on-chain.";
  }

  /** Bundler dumps callData; still decode embedded 4-byte revert selectors when present. */
  const fromSelector = messageFromRevertSelectors(m);
  if (fromSelector) {
    return fromSelector;
  }

  if (USER_OP_SIMULATION_BLOB_PREFIX.test(m)) {
    return GENERIC_USER_OP_SIMULATION_MESSAGE;
  }

  if (/EnforcedPause|ExpectedPause|contract paused|is paused|Pausable/i.test(m)) {
    return "The liquidity pool is paused. Swaps are temporarily disabled.";
  }
  if (/PermissionedAMM__InvalidPhase|InvalidPhase/i.test(m)) {
    return "The pool is not in an active trading state right now.";
  }
  if (/PermissionedAMM__DirectSwapDisabled|DirectSwapDisabled/i.test(m)) {
    return "Direct swaps are disabled; operator execution should still apply — contact support if this persists.";
  }
  if (/PermissionedAMM__InsufficientLiquidity|InsufficientLiquidity/i.test(m)) {
    return "Insufficient liquidity in the pool for this trade size.";
  }
  if (/InsufficientOutput|SlippageExceeded|PermissionedAMM__InsufficientOutput|PermissionedAMM__SlippageExceeded/i.test(m)) {
    return m;
  }
  if (/AccessControlUnauthorizedAccount|AccessControlUnauthorized/i.test(m)) {
    return "On-chain authorization failed (missing operator role or admin permission).";
  }
  if (/PermissionedAMM__NotCompliant|NotCompliant/i.test(m)) {
    return "Compliance check failed for this swap.";
  }

  return m;
}
