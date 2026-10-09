// app/lib/sync-entities.ts
// Declarative registry of the business entities mirrored downstream. The CDC
// scanner (sync-cdc-service) reads this to build its per-entity SELECT, so
// adding/changing a synced table is a one-place edit here — no per-write-site
// instrumentation.
//
// SECURITY: mirror every non-sensitive business column for full downstream
// auditability. Excluded regardless: secrets (encrypted_private_key, public_key,
// api-key secret_hash), PII (bank_details_encrypted, ip_address, user_agent),
// raw provider blobs (webhook_payload), internal idempotency keys, freeform
// operational notes, and the admin identity (processed_by). Cross-entity ledger
// linkage ids ARE included so the mirror can reconcile trades <-> ledger rows.

import "server-only";

export interface SyncEntityDescriptor {
  /** Routing key sent as `entity` (and used as aggregate_type in the outbox). */
  entity: string;
  /** FROM clause: a table name, or a derived table `(SELECT ...) s`. */
  from: string;
  /** Numeric, monotonic tiebreaker expression (paged after the watermark). */
  idExpr: string;
  /** Change watermark expression: `updated_at` for mutable, `created_at` for append-only. */
  watermarkExpr: string;
  /** SQL expression producing the stable natural key (downstream MERGE key). */
  naturalKeyExpr: string;
  /** field name in `data` -> SQL expression selected from `from`. */
  fields: Record<string, string>;
}

export const SYNC_ENTITIES: SyncEntityDescriptor[] = [
  {
    entity: "trade_order",
    from: "trade_orders",
    idExpr: "id",
    watermarkExpr: "updated_at",
    naturalKeyExpr: "order_id",
    fields: {
      orderId: "order_id",
      userId: "user_id",
      orderType: "order_type",
      status: "status",
      // Convert-direction columns. NULL for buy/sell; populated for converts
      // (PLAT <-> stablecoin) where the real economic detail lives here.
      fromToken: "from_token",
      toToken: "to_token",
      fromAmount: "from_amount",
      toAmount: "to_amount",
      // Fiat leg only exists for buy/sell. Converts carry hard-coded placeholder
      // fiat values in the source table (schema requires NOT NULL), so we send
      // NULL downstream rather than mirror fabricated amounts.
      fiatCurrency:
        "CASE WHEN order_type = 'convert' THEN NULL ELSE fiat_currency END",
      payoutCurrency:
        "CASE WHEN order_type = 'convert' THEN NULL ELSE payout_currency END",
      fiatAmount:
        "CASE WHEN order_type = 'convert' THEN NULL ELSE fiat_amount END",
      fiatToTusdRate: "fiat_to_tusd_rate",
      tusdAmount: "tusd_amount",
      payoutAmount: "payout_amount",
      tglobalAmount: "tglobal_amount",
      ammQuotePrice: "amm_quote_price",
      executedPrice: "executed_price",
      slippageBps: "slippage_bps",
      maxSlippageBps: "max_slippage_bps",
      operatorTxHash: "operator_tx_hash",
      paymentReference: "payment_reference",
      debitTransactionId: "debit_transaction_id",
      creditTransactionId: "credit_transaction_id",
      payoutSwapTransactionId: "payout_swap_transaction_id",
      failureReason: "failure_reason",
      createdAt: "created_at",
      executedAt: "executed_at",
      completedAt: "completed_at",
    },
  },
  {
    entity: "cashout_order",
    from: "cashout_orders",
    idExpr: "id",
    watermarkExpr: "updated_at",
    naturalKeyExpr: "cashout_id",
    fields: {
      cashoutId: "cashout_id",
      userId: "user_id",
      token: "token",
      tokenAmount: "token_amount",
      tusdAmount: "tusd_amount",
      conversionRate: "conversion_rate",
      ammExecutedPrice: "amm_executed_price",
      ammSlippageBps: "amm_slippage_bps",
      operatorTxHash: "operator_tx_hash",
      fiatCurrency: "fiat_currency",
      fiatAmount: "fiat_amount",
      status: "status",
      transakOrderId: "transak_order_id",
      transakDepositAddress: "transak_deposit_address",
      cryptoSendAmount: "crypto_send_amount",
      treasuryTxHash: "treasury_tx_hash",
      paymentReference: "payment_reference",
      debitTransactionId: "debit_transaction_id",
      failureReason: "failure_reason",
      createdAt: "created_at",
      processedAt: "processed_at",
      updatedAt: "updated_at",
    },
  },
  {
    entity: "onramp_order",
    from: "onramp_orders",
    idExpr: "id",
    watermarkExpr: "updated_at",
    naturalKeyExpr: "order_id",
    fields: {
      orderId: "order_id",
      partnerOrderId: "partner_order_id",
      transakOrderId: "transak_order_id",
      userId: "user_id",
      fiatCurrency: "fiat_currency",
      fiatAmount: "fiat_amount",
      cryptoCurrency: "crypto_currency",
      cryptoAmount: "crypto_amount",
      tusdAmount: "tusd_amount",
      status: "status",
      transakStatus: "transak_status",
      treasuryTxHash: "treasury_tx_hash",
      creditTransactionId: "credit_transaction_id",
      failureReason: "failure_reason",
      createdAt: "created_at",
      completedAt: "completed_at",
      updatedAt: "updated_at",
    },
  },
  {
    entity: "staking_order",
    from: "staking_orders",
    idExpr: "id",
    watermarkExpr: "updated_at", // added in migration 023
    naturalKeyExpr: "order_id",
    fields: {
      orderId: "order_id",
      userId: "user_id",
      userSmartAccount: "user_smart_account",
      orderType: "order_type",
      status: "status",
      amount: "amount",
      rewardAmount: "reward_amount",
      operatorTxHash: "operator_tx_hash",
      debitTransactionId: "debit_transaction_id",
      creditTransactionId: "credit_transaction_id",
      rewardCreditTransactionId: "reward_credit_transaction_id",
      failureReason: "failure_reason",
      createdAt: "created_at",
      executedAt: "executed_at",
      completedAt: "completed_at",
    },
  },
  {
    entity: "ledger_transaction",
    from: "ledger_transactions",
    idExpr: "id",
    watermarkExpr: "created_at", // append-only ledger
    naturalKeyExpr: "transaction_id",
    fields: {
      transactionId: "transaction_id",
      userId: "user_id",
      type: "type",
      tokenSymbol: "token_symbol",
      amount: "amount",
      balanceBefore: "balance_before",
      balanceAfter: "balance_after",
      relatedTxHash: "related_tx_hash",
      createdBy: "created_by",
      createdAt: "created_at",
    },
  },
  {
    entity: "balance",
    from: "internal_balances",
    idExpr: "id",
    watermarkExpr: "updated_at",
    naturalKeyExpr: "CONCAT(user_id, ':', token_symbol)",
    fields: {
      userId: "user_id",
      tokenSymbol: "token_symbol",
      balance: "balance",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  {
    entity: "swap_transaction",
    from: "swap_transactions",
    idExpr: "id",
    watermarkExpr: "created_at", // append-only
    naturalKeyExpr: "transaction_id",
    fields: {
      transactionId: "transaction_id",
      userId: "user_id",
      fromToken: "from_token",
      fromAmount: "from_amount",
      fromBalanceBefore: "from_balance_before",
      fromBalanceAfter: "from_balance_after",
      toToken: "to_token",
      toAmount: "to_amount",
      toBalanceBefore: "to_balance_before",
      toBalanceAfter: "to_balance_after",
      fromUsdRate: "from_usd_rate",
      toUsdRate: "to_usd_rate",
      effectiveRate: "effective_rate",
      fromOracleSource: "from_oracle_source",
      toOracleSource: "to_oracle_source",
      oracleFromFeedId: "oracle_from_feed_id",
      oracleToFeedId: "oracle_to_feed_id",
      oracleBlockNumber: "oracle_block_number",
      oracleTimestamp: "oracle_timestamp",
      feeAmount: "fee_amount",
      feeToken: "fee_token",
      status: "status",
      createdAt: "created_at",
    },
  },
  {
    entity: "checkout_charge",
    from: "checkout_charges",
    idExpr: "id",
    watermarkExpr: "updated_at", // added in migration 023
    naturalKeyExpr: "charge_id",
    fields: {
      chargeId: "charge_id",
      userId: "user_id",
      amount: "amount",
      currency: "currency",
      status: "status",
      reference: "reference",
      description: "description",
      refundedAmount: "refunded_amount",
      ledgerTransactionId: "ledger_transaction_id",
      createdAt: "created_at",
    },
  },
  {
    entity: "checkout_refund",
    from: "checkout_refunds",
    idExpr: "id",
    watermarkExpr: "created_at", // set-once
    naturalKeyExpr: "refund_id",
    fields: {
      refundId: "refund_id",
      chargeId: "charge_id",
      amount: "amount",
      reason: "reason",
      status: "status",
      ledgerTransactionId: "ledger_transaction_id",
      createdAt: "created_at",
    },
  },
  {
    entity: "collected_fee",
    from: "collected_fees",
    idExpr: "id",
    watermarkExpr: "created_at", // append-only, surrogate id as natural key
    naturalKeyExpr: "CAST(id AS CHAR)",
    fields: {
      feeId: "id",
      orderId: "order_id",
      userId: "user_id",
      orderType: "order_type",
      feeBps: "fee_bps",
      grossUsdx: "gross_usdx",
      feeUsdx: "fee_usdx",
      netUsdx: "net_usdx",
      createdAt: "created_at",
    },
  },
  {
    // Identity: email (user_emails) + wallet addresses (internal_wallets),
    // joined into a derived table so the watermark tracks whichever changed.
    // NEVER selects encrypted_private_key / public_key.
    entity: "user",
    from: `(
      SELECT
        iw.id AS id,
        iw.user_id AS user_id,
        ue.email AS email,
        iw.wallet_address AS wallet_address,
        iw.smart_account_address AS smart_account_address,
        iw.created_at AS created_at,
        GREATEST(
          COALESCE(iw.updated_at, '1970-01-01'),
          COALESCE(ue.updated_at, '1970-01-01')
        ) AS wm
      FROM internal_wallets iw
      LEFT JOIN user_emails ue
        -- user_emails was created without an explicit collation (server default
        -- utf8mb4_0900_ai_ci) while internal_wallets is utf8mb4_unicode_ci.
        -- Force a collation or the join errors ("illegal mix of collations")
        -- and the whole user scan silently fails.
        ON ue.user_id = iw.user_id COLLATE utf8mb4_unicode_ci
    ) s`,
    idExpr: "id",
    watermarkExpr: "wm",
    naturalKeyExpr: "user_id",
    fields: {
      userId: "user_id",
      email: "email",
      walletAddress: "wallet_address",
      smartAccountAddress: "smart_account_address",
      createdAt: "created_at",
      updatedAt: "wm",
    },
  },
];

export function getSyncEntity(entity: string): SyncEntityDescriptor | undefined {
  return SYNC_ENTITIES.find((e) => e.entity === entity);
}
