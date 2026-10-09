// app/lib/auth-service.ts
import { cookies } from "next/headers";

export interface UserSession {
  name: string;
  image: string;
  roles: string[];
  userId: string;
  email: string;
}

/**
 * Get the current user session from cookies (READ ONLY)
 * Note: Token refresh is handled by proxy.ts on each request
 */
export async function getServerSession(): Promise<UserSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("accessToken")?.value;
  const userInfo = cookieStore.get("user_info")?.value;

  if (!token || !userInfo) return null;

  try {
    const parsed = JSON.parse(userInfo);
    // Ensure userId is always a string — the API may return it as a number,
    // which breaks MySQL VARCHAR comparisons when passed via prepared statements.
    if (parsed.userId != null) {
      parsed.userId = String(parsed.userId);
    }
    return parsed as UserSession;
  } catch {
    return null;
  }
}

/**
 * Get the access token from cookies
 */
export async function getAccessToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get("accessToken")?.value || null;
}

/**
 * Check if user is authenticated (has valid tokens)
 * Note: Token refresh is handled automatically by proxy.ts
 */
export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get("accessToken")?.value;
  const refreshToken = cookieStore.get("refreshToken")?.value;
  
  // User is authenticated if they have either token
  // (proxy.ts will refresh access token if needed)
  return !!(accessToken || refreshToken);
}
