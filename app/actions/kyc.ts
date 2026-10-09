"use server";
import { UPSTREAM_API_BASE } from "@/app/lib/upstream";

import { getServerSession, getAccessToken } from "@/app/lib/auth-service";

const API_BASE = UPSTREAM_API_BASE;

export type KYCResult = {
  success: true;
  data: Record<string, unknown>;
} | {
  success: false;
  error: string;
};

export async function getKYCResult(
  status?: string,
  limit: number = 10
): Promise<KYCResult> {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: "No access token" };
  }

  try {
    const res = await fetch(`${API_BASE}/Financial/GETKYC`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        UserId: Number(session.userId),
        Status: status || null,
        Limit: limit,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[KYC Action] API error:", res.status, errorText);
      return {
        success: false,
        error: `API returned ${res.status}: ${errorText}`,
      };
    }

    const data = await res.json();
    return { success: true, data };
  } catch (error) {
    console.error("[KYC Action] Failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch KYC data",
    };
  }
}

export async function checkKYCStatus(vendorData?: string): Promise<KYCResult> {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: "No access token" };
  }

  try {
    const params = new URLSearchParams({ token: accessToken });
    if (vendorData) {
      params.set("vendordata", vendorData);
    }

    const res = await fetch(`${API_BASE}/Financial/CheckKYCStatus?${params}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[CheckKYCStatus] API error:", res.status, errorText);
      return {
        success: false,
        error: `API returned ${res.status}: ${errorText}`,
      };
    }

    const data = await res.json();
    return { success: true, data };
  } catch (error) {
    console.error("[CheckKYCStatus] Failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to check KYC status",
    };
  }
}
