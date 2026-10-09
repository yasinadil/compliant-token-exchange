/**
 * Base URL of the upstream identity / KYC service (auth, registration, token refresh, KYC lookup).
 * Server-side only.
 */
export const UPSTREAM_API_BASE = process.env.UPSTREAM_API_BASE ?? "https://identity.example.com/api";
