// app/lib/kyc-helper.ts
// Parses Didit KYC data from the identity provider's KYC API and maps it to
// Transak's userData format for pre-filling widget screens.

import { UPSTREAM_API_BASE } from "@/app/lib/upstream";
import { getAccessToken } from "./auth-service";

const API_BASE = UPSTREAM_API_BASE;

// Transak userData shape (used to skip Lite KYC screen)
export interface TransakUserData {
  firstName: string;
  lastName: string;
  mobileNumber: string;
  dob: string;
  address: {
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state: string;
    postCode: string;
    countryCode: string;
  };
}

export interface TransakKYCPrefill {
  email: string;
  userData: TransakUserData;
}

interface DiditIdVerification {
  first_name?: string;
  last_name?: string;
  date_of_birth?: string;
  status?: string;
  parsed_address?: {
    street_1?: string;
    street_2?: string;
    city?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  };
}

interface DiditDecision {
  status?: string;
  id_verification?: DiditIdVerification;
  email?: { email?: string; status?: string };
  phone?: { full_number?: string; status?: string };
}

interface DiditKYCRecord {
  ID: number;
  content: string;
  created_at: string;
  session_id: string;
  vendor_data: string;
  workflow_id: string;
}

interface GETKYCResponse {
  DateTime: string;
  Status: string;
  Msg: string;
  Result: DiditKYCRecord[];
}

// In-memory cache: userId -> { data, fetchedAt }
const kycCache = new Map<string, { data: TransakKYCPrefill; fetchedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch the user's Didit KYC data from the identity provider API and map it
 * to the Transak userData format. Returns null when no approved
 * KYC session is available or mandatory fields are missing.
 */
export async function getTransakKYCPrefill(
  userId: string
): Promise<TransakKYCPrefill | null> {
  const cached = kycCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const accessToken = await getAccessToken();
  if (!accessToken) return null;

  try {
    const res = await fetch(`${API_BASE}/Financial/GETKYC`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        UserId: Number(userId),
        Status: null,
        Limit: 5,
      }),
    });

    if (!res.ok) {
      console.error("[KYC Helper] API error:", res.status);
      return null;
    }

    const body: GETKYCResponse = await res.json();

    if (body.Status !== "OK" || !body.Result?.length) {
      return null;
    }

    const prefill = parseLatestApprovedSession(body.Result);
    if (prefill) {
      kycCache.set(userId, { data: prefill, fetchedAt: Date.now() });
    }
    return prefill;
  } catch (error) {
    console.error("[KYC Helper] Failed to fetch KYC data:", error);
    return null;
  }
}

/**
 * Iterate through KYC records (newest first) and extract
 * Transak-compatible userData from the first Approved session
 * that has all mandatory fields.
 */
function parseLatestApprovedSession(
  records: DiditKYCRecord[]
): TransakKYCPrefill | null {
  for (const record of records) {
    try {
      const content = JSON.parse(record.content);
      const decision: DiditDecision = content.decision ?? content;

      if (decision.status !== "Approved") continue;

      const idv = decision.id_verification;
      if (!idv || idv.status !== "Approved") continue;

      const firstName = idv.first_name?.trim();
      const lastName = idv.last_name?.trim();
      const dob = idv.date_of_birth; // "YYYY-MM-DD"
      const addr = idv.parsed_address;

      if (!firstName || !lastName || !dob || !addr?.street_1 || !addr?.city || !addr?.country) {
        continue;
      }

      const phone = decision.phone;
      const mobileNumber = phone?.status === "Approved" ? phone.full_number : undefined;
      if (!mobileNumber) continue;

      const email = decision.email;
      const verifiedEmail = email?.status === "Approved" ? email.email : undefined;
      if (!verifiedEmail) continue;

      return {
        email: verifiedEmail,
        userData: {
          firstName,
          lastName,
          mobileNumber,
          dob,
          address: {
            addressLine1: addr.street_1,
            addressLine2: addr.street_2 || undefined,
            city: addr.city,
            state: addr.region || addr.city,
            postCode: addr.postal_code || "",
            countryCode: addr.country,
          },
        },
      };
    } catch {
      console.warn("[KYC Helper] Failed to parse record ID:", record.ID);
      continue;
    }
  }

  return null;
}
