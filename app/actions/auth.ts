// app/actions/auth.ts
"use server";
import { UPSTREAM_API_BASE } from "@/app/lib/upstream";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { recordUserEmail } from "@/app/lib/user-email-service";

export type ActionState = { error?: string } | null;

// Auth cookies must be `Secure` in production (HTTPS) so they aren't sent
// in plaintext. But a `Secure` cookie is silently dropped by the browser
// over plain HTTP — which breaks login entirely when the app is reached by
// a bare IP without TLS. `COOKIE_SECURE=false` opts out for that HTTP-only
// testing phase; leave it unset (or "true") for any HTTPS deployment.
const COOKIE_SECURE =
  process.env.COOKIE_SECURE === "false"
    ? false
    : process.env.NODE_ENV === "production";

export async function login(prevState: ActionState, formData: FormData) {
  const email = formData.get("email");
  const password = formData.get("password");

  const res = await fetch(
    `${UPSTREAM_API_BASE}/Auth/login`,
    {
      method: "POST",
      body: JSON.stringify({ email, password }),
      headers: { "Content-Type": "application/json" },
    }
  );

  if (!res.ok) {
    const errorData = await res.text();
    console.error("Login failed:", errorData);
    return { error: "Login failed. Please check your credentials." };
  }

  const data = await res.json();
  const cookieStore = await cookies();

  // Set Access Token
  cookieStore.set("accessToken", data.AccessToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    expires: new Date(data.AccessTokenExpiresAt),
    path: "/",
  });

  // Store access token expiry for checking
  cookieStore.set("accessTokenExpiresAt", data.AccessTokenExpiresAt, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
  });

  // Set Refresh Token (longer lived)
  if (data.RefreshToken) {
    cookieStore.set("refreshToken", data.RefreshToken, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "lax",
      expires: new Date(data.RefreshTokenExpiresAt),
      path: "/",
    });

    cookieStore.set("refreshTokenExpiresAt", data.RefreshTokenExpiresAt, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "lax",
      path: "/",
    });
  }

  // Store user info (non-httpOnly so client can read)
  cookieStore.set(
    "user_info",
    JSON.stringify({
      name: data.Name,
      image: data.ImageURL,
      roles: data.Roles,
      userId: data.UserId,
      email: data.Email,
    }),
    {
      secure: COOKIE_SECURE,
      sameSite: "lax",
      path: "/",
      // User info cookie expires with access token for now
      // The middleware/session check will refresh this along with access token
      expires: new Date(data.RefreshTokenExpiresAt || data.AccessTokenExpiresAt),
    }
  );

  // Denormalise user_id -> email for the Admin Panel feed (best-effort).
  try {
    await recordUserEmail(data.UserId, data.Email);
  } catch (e) {
    console.error("[auth] recordUserEmail (login) failed:", e);
  }

  redirect("/");
}

export async function register(prevState: ActionState, formData: FormData) {
  const name = formData.get("name") as string | null;
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const confirmPassword = formData.get("confirmPassword") as string;

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  if (password !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  try {
    const res = await fetch(
      `${UPSTREAM_API_BASE}/Auth/register`,
      {
        method: "POST",
        body: JSON.stringify({
          Email: email,
          Password: password,
          Name: name || undefined,
        }),
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!res.ok) {
      const errorData = await res.json().catch(() => null);
      const detail = errorData?.detail || errorData?.title;
      return {
        error: detail || "Registration failed. The email may already be in use.",
      };
    }

    // Registration succeeded — auto-login
    const loginRes = await fetch(
      `${UPSTREAM_API_BASE}/Auth/login`,
      {
        method: "POST",
        body: JSON.stringify({ Email: email, Password: password }),
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!loginRes.ok) {
      // Registration worked but auto-login failed; redirect to login
      redirect("/login?registered=true");
    }

    const data = await loginRes.json();
    const cookieStore = await cookies();

    cookieStore.set("accessToken", data.AccessToken, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "lax",
      expires: new Date(data.AccessTokenExpiresAt),
      path: "/",
    });

    cookieStore.set("accessTokenExpiresAt", data.AccessTokenExpiresAt, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "lax",
      path: "/",
    });

    if (data.RefreshToken) {
      cookieStore.set("refreshToken", data.RefreshToken, {
        httpOnly: true,
        secure: COOKIE_SECURE,
        sameSite: "lax",
        expires: new Date(data.RefreshTokenExpiresAt),
        path: "/",
      });

      cookieStore.set("refreshTokenExpiresAt", data.RefreshTokenExpiresAt, {
        httpOnly: true,
        secure: COOKIE_SECURE,
        sameSite: "lax",
        path: "/",
      });
    }

    cookieStore.set(
      "user_info",
      JSON.stringify({
        name: data.Name,
        image: data.ImageURL,
        roles: data.Roles,
        userId: data.UserId,
        email: data.Email,
      }),
      {
        secure: COOKIE_SECURE,
        sameSite: "lax",
        path: "/",
        expires: new Date(data.RefreshTokenExpiresAt || data.AccessTokenExpiresAt),
      }
    );

    // Denormalise user_id -> email for the Admin Panel feed (best-effort).
    try {
      await recordUserEmail(data.UserId, data.Email);
    } catch (e) {
      console.error("[auth] recordUserEmail (register) failed:", e);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") throw error;
    console.error("Registration error:", error);
    return { error: "An unexpected error occurred. Please try again." };
  }

  redirect("/");
}

export async function logoutAction() {
  const cookieStore = await cookies();
  cookieStore.delete("accessToken");
  cookieStore.delete("refreshToken");
  cookieStore.delete("accessTokenExpiresAt");
  cookieStore.delete("refreshTokenExpiresAt");
  cookieStore.delete("user_info");
  redirect("/login");
}

/**
 * Server action to refresh tokens manually
 */
export async function refreshTokensAction(): Promise<{ success: boolean; error?: string }> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get("refreshToken")?.value;

  if (!refreshToken) {
    return { success: false, error: "No refresh token available" };
  }

  try {
    const res = await fetch(
      `${UPSTREAM_API_BASE}/Auth/refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ RefreshToken: refreshToken }),
      }
    );

    if (!res.ok) {
      return { success: false, error: "Failed to refresh token" };
    }

    const data = await res.json();

    // Update all cookies
    cookieStore.set("accessToken", data.AccessToken, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "lax",
      expires: new Date(data.AccessTokenExpiresAt),
      path: "/",
    });

    cookieStore.set("accessTokenExpiresAt", data.AccessTokenExpiresAt, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "lax",
      path: "/",
    });

    if (data.RefreshToken) {
      cookieStore.set("refreshToken", data.RefreshToken, {
        httpOnly: true,
        secure: COOKIE_SECURE,
        sameSite: "lax",
        expires: new Date(data.RefreshTokenExpiresAt),
        path: "/",
      });

      cookieStore.set("refreshTokenExpiresAt", data.RefreshTokenExpiresAt, {
        httpOnly: true,
        secure: COOKIE_SECURE,
        sameSite: "lax",
        path: "/",
      });
    }

    if (data.UserId) {
      cookieStore.set(
        "user_info",
        JSON.stringify({
          name: data.Name,
          image: data.ImageURL,
          roles: data.Roles,
          userId: data.UserId,
          email: data.Email,
        }),
        {
          secure: COOKIE_SECURE,
          sameSite: "lax",
          path: "/",
          expires: new Date(data.RefreshTokenExpiresAt || data.AccessTokenExpiresAt),
        }
      );
    }

    return { success: true };
  } catch (error) {
    console.error("Token refresh error:", error);
    return { success: false, error: "Network error during refresh" };
  }
}
