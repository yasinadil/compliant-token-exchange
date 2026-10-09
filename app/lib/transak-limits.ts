// Single source of truth for Transak payment bounds and fee schedule.
// Imported by both the client (live status chip in BuyForm) and the
// server (min gate in trade-order-service, fallback fee estimation in
// cashout-service and trade-order-service). Keeping them in one file
// avoids the drift class of bugs where the UI and server disagree.
//
// Naming: Transak's widget surfaces this tier as "Lite KYC" (their docs
// call it "Light KYC" — we mirror the in-widget label since that's what
// users actually see).
//
// Fee schedule sourced from:
// https://support.transak.com/en/articles/7845942-how-does-transak-calculate-prices-and-fees

import type { FiatCurrency } from "./payment-service";

// Transak's per-currency widget MINIMUMS. Empirically determined by
// driving the widget directly — they do NOT follow a USD-equivalent
// formula (BRL 25 ≈ $4.50 is far below the USD 5 floor). Hard floors:
// Transak rejects below these regardless of KYC level.
export const TRANSAK_MIN_PER_CURRENCY: Record<FiatCurrency, number> = {
  USD: 5,
  EUR: 17,
  GBP: 4,
  BRL: 25,
};

// Transak's per-currency Lite-KYC MAXIMUMS. Above these, the widget
// prompts the user to upgrade to Standard KYC (Level 2) — they're NOT
// hard rejections, just KYC-tier ceilings. The client surfaces this as
// an informational green chip ("KYC upgrade required for this amount")
// instead of blocking submit. The server doesn't gate on these at all
// (Transak owns that prompt).
export const TRANSAK_LITE_MAX_PER_CURRENCY: Record<FiatCurrency, number> = {
  USD: 50,
  EUR: 86,
  GBP: 186,
  BRL: 252,
};

// ============================================================================
// TRANSAK FEE SCHEDULE (fallback when pricing API is unreachable)
// ============================================================================
// On-ramp and off-ramp fees by payment method and currency region.
// The pricing API is the source of truth when available; these constants
// are used ONLY as a fallback when the API times out or returns an error.
// Transak also applies a 2.5% spread on top of the CoinGecko market rate
// which is baked into the exchange rate (not surfaced as a separate fee).

export type TransakPaymentMethod =
  | "credit_debit_card"
  | "apple_pay"
  | "google_pay"
  | "sepa_bank_transfer";

interface TransakFeeRule {
  feePct: number;
  minFeeEur: number;
  flatFeeEur: number;
}

// On-ramp (BUY) fee schedule
const ONRAMP_FEE_SCHEDULE: Record<TransakPaymentMethod, { eur: TransakFeeRule; nonEur: TransakFeeRule }> = {
  credit_debit_card: {
    eur:    { feePct: 3.5, minFeeEur: 0,   flatFeeEur: 1 },
    nonEur: { feePct: 5.5, minFeeEur: 0,   flatFeeEur: 1 },
  },
  apple_pay: {
    eur:    { feePct: 3.5, minFeeEur: 1,   flatFeeEur: 0 },
    nonEur: { feePct: 5.5, minFeeEur: 1,   flatFeeEur: 0 },
  },
  google_pay: {
    eur:    { feePct: 3.5, minFeeEur: 1,   flatFeeEur: 0 },
    nonEur: { feePct: 5.5, minFeeEur: 1,   flatFeeEur: 0 },
  },
  sepa_bank_transfer: {
    eur:    { feePct: 0.99, minFeeEur: 1,  flatFeeEur: 0 },
    nonEur: { feePct: 0.99, minFeeEur: 1,  flatFeeEur: 0 },
  },
};

// Off-ramp (SELL) fee schedule
const OFFRAMP_FEE_SCHEDULE: Record<string, { eur: TransakFeeRule; nonEur: TransakFeeRule }> = {
  credit_debit_card: {
    eur:    { feePct: 0.99, minFeeEur: 3.49, flatFeeEur: 0 },
    nonEur: { feePct: 4.99, minFeeEur: 5.99, flatFeeEur: 0 },
  },
  sepa_bank_transfer: {
    eur:    { feePct: 0.6,  minFeeEur: 3,    flatFeeEur: 0 },
    nonEur: { feePct: 0.6,  minFeeEur: 3,    flatFeeEur: 0 },
  },
};

function isEurCurrency(fiat: string): boolean {
  return fiat.toUpperCase() === "EUR";
}

/**
 * Estimate Transak on-ramp (BUY) fee when the pricing API is unreachable.
 * Returns the estimated total fee in the fiat currency.
 */
export function estimateOnRampFee(
  fiatAmount: number,
  fiatCurrency: string,
  paymentMethod: TransakPaymentMethod = "credit_debit_card"
): { feePct: number; totalFee: number } {
  const schedule = ONRAMP_FEE_SCHEDULE[paymentMethod] ?? ONRAMP_FEE_SCHEDULE.credit_debit_card;
  const rule = isEurCurrency(fiatCurrency) ? schedule.eur : schedule.nonEur;

  const percentFee = fiatAmount * (rule.feePct / 100);
  const totalFee = Math.max(percentFee, rule.minFeeEur) + rule.flatFeeEur;
  return { feePct: rule.feePct, totalFee };
}

/**
 * Estimate Transak off-ramp (SELL) fee when the pricing API is unreachable.
 * Returns the estimated total fee in the fiat currency.
 */
export function estimateOffRampFee(
  fiatAmount: number,
  fiatCurrency: string,
  paymentMethod: string = "credit_debit_card"
): { feePct: number; totalFee: number; minFee: number } {
  const schedule = OFFRAMP_FEE_SCHEDULE[paymentMethod] ?? OFFRAMP_FEE_SCHEDULE.credit_debit_card;
  const rule = isEurCurrency(fiatCurrency) ? schedule.eur : schedule.nonEur;

  const percentFee = fiatAmount * (rule.feePct / 100);
  const totalFee = Math.max(percentFee, rule.minFeeEur) + rule.flatFeeEur;
  return { feePct: rule.feePct, totalFee, minFee: rule.minFeeEur };
}
