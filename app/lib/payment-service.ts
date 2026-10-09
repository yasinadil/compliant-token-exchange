// app/lib/payment-service.ts
// Shared fiat-payment domain types.
//
// The pluggable PaymentProvider abstraction and its MockPaymentProvider were
// removed together with the mock-backed /api/webhooks/payment route: buys and
// cashouts flow through Transak, which owns the fiat rail and delivers a
// signature-verified webhook (see app/api/webhooks/transak).
//
// MAINNET: when a direct card/bank processor is added, build a real provider
// with genuine webhook signature verification against that processor's API.
// Do NOT reintroduce a mock verifier that trusts every request.

export type FiatCurrency = "USD" | "BRL" | "GBP" | "EUR";

export interface BankDetails {
  accountHolderName: string;
  bankName?: string;
  // USD (ACH)
  routingNumber?: string;
  accountNumber?: string;
  // GBP
  sortCode?: string;
  // EUR (SEPA)
  iban?: string;
  bic?: string;
  // BRL (PIX)
  pixKey?: string;
  cpf?: string;
}
