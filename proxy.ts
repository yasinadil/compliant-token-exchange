// proxy.ts (at the root of your project)
import { UPSTREAM_API_BASE } from "@/app/lib/upstream";
import { NextRequest, NextResponse } from "next/server";

// Routes that don't require authentication
const publicRoutes = ["/login", "/register", "/forgot-password"];

// See app/actions/auth.ts for the rationale: `Secure` cookies are dropped
// by the browser over plain HTTP, so set COOKIE_SECURE=false when serving
// the app on a bare IP without TLS. Leave unset/"true" for HTTPS.
const COOKIE_SECURE =
  process.env.COOKIE_SECURE === "false"
    ? false
    : process.env.NODE_ENV === "production";

interface RefreshedSession {
  AccessToken: string;
  AccessTokenExpiresAt: string;
  RefreshToken?: string;
  RefreshTokenExpiresAt: string;
  Name?: string;
  ImageURL?: string;
  Roles?: string[];
  UserId?: string | number;
  Email?: string;
}

const REFRESH_REUSE_MS = 5_000;
let inFlightRefresh:
  | { refreshToken: string; promise: Promise<RefreshedSession | null> }
  | null = null;
let recentRefresh:
  | { refreshToken: string; data: RefreshedSession; expiresAt: number }
  | null = null;

function authenticatedDestination(request: NextRequest): string {
  const callbackUrl = request.nextUrl.searchParams.get("callbackUrl");
  return callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//")
    ? callbackUrl
    : "/";
}

async function refreshSession(
  refreshToken: string
): Promise<RefreshedSession | null> {
  if (
    recentRefresh?.refreshToken === refreshToken &&
    recentRefresh.expiresAt > Date.now()
  ) {
    return recentRefresh.data;
  }

  if (inFlightRefresh?.refreshToken === refreshToken) {
    return inFlightRefresh.promise;
  }

  const promise = (async () => {
    const response = await fetch(
      `${UPSTREAM_API_BASE}/Auth/refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ RefreshToken: refreshToken }),
      }
    );

    if (!response.ok) return null;

    const data = (await response.json()) as RefreshedSession;
    return data.AccessToken && data.AccessTokenExpiresAt ? data : null;
  })();

  inFlightRefresh = { refreshToken, promise };
  try {
    const data = await promise;
    if (data) {
      recentRefresh = {
        refreshToken,
        data,
        expiresAt: Date.now() + REFRESH_REUSE_MS,
      };
    }
    return data;
  } finally {
    if (inFlightRefresh?.promise === promise) {
      inFlightRefresh = null;
    }
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Unauthenticated surfaces (no app session required):
  // - /api/*      : API routes enforce their own auth (checkout key, CRON_SECRET, ...)
  // - /_next/*    : framework assets
  // - /api-docs   : public API reference (Swagger UI); the spec is /api/openapi
  // - /user/*     : public user profile (must not bounce logged-in users to /)
  // Note /api-docs already matches the /api prefix, but it is listed explicitly
  // so the docs stay public even if the /api check is ever narrowed.
  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname === "/api-docs" ||
    pathname.startsWith("/api-docs/") ||
    pathname === "/user" ||
    pathname.startsWith("/user/")
  ) {
    return NextResponse.next();
  }

  // Check for authentication cookies
  const accessToken = request.cookies.get("accessToken")?.value;
  const refreshToken = request.cookies.get("refreshToken")?.value;
  const accessTokenExpiresAt = request.cookies.get("accessTokenExpiresAt")?.value;
  const userInfo = request.cookies.get("user_info")?.value;

  const isPublicRoute = publicRoutes.some((route) => pathname.startsWith(route));
  
  // User is authenticated only if they have both accessToken AND user_info
  const isAuthenticated = !!accessToken && !!userInfo;

  // Restore the requested protected destination after an auth bounce.
  if (isPublicRoute && isAuthenticated) {
    return NextResponse.redirect(
      new URL(authenticatedDestination(request), request.url)
    );
  }

  // If user is on public route and NOT authenticated, let them through
  if (isPublicRoute) {
    return NextResponse.next();
  }

  // From here on, we're on a protected route

  // If fully authenticated and token not expired, let them through
  if (isAuthenticated && accessTokenExpiresAt) {
    const expiryTime = new Date(accessTokenExpiresAt).getTime();
    const now = Date.now();
    const bufferTime = 60 * 1000; // 1 minute buffer

    // Token is still valid
    if (now < expiryTime - bufferTime) {
      return NextResponse.next();
    }
  }

  // Try to refresh if we have a refresh token
  if (refreshToken) {
    try {
      const data = await refreshSession(refreshToken);

      if (data) {
        const refreshedUserInfo = data.UserId
          ? JSON.stringify({
              name: data.Name,
              image: data.ImageURL,
              roles: data.Roles,
              userId: data.UserId,
              email: data.Email,
            })
          : undefined;

        // Make refreshed credentials available to the page rendered by this
        // request, not only to subsequent browser requests.
        request.cookies.set("accessToken", data.AccessToken);
        request.cookies.set("accessTokenExpiresAt", data.AccessTokenExpiresAt);

        if (data.RefreshToken) {
          request.cookies.set("refreshToken", data.RefreshToken);
          request.cookies.set("refreshTokenExpiresAt", data.RefreshTokenExpiresAt);
        }

        if (refreshedUserInfo) {
          request.cookies.set("user_info", refreshedUserInfo);
        }

        const requestHeaders = new Headers(request.headers);
        requestHeaders.set("cookie", request.cookies.toString());

        const response = NextResponse.next({
          request: {
            headers: requestHeaders,
          },
        });

        // Set new access token
        response.cookies.set("accessToken", data.AccessToken, {
          httpOnly: true,
          secure: COOKIE_SECURE,
          sameSite: "lax",
          expires: new Date(data.AccessTokenExpiresAt),
          path: "/",
        });

        response.cookies.set("accessTokenExpiresAt", data.AccessTokenExpiresAt, {
          httpOnly: true,
          secure: COOKIE_SECURE,
          sameSite: "lax",
          path: "/",
        });

        // Update refresh token if provided
        if (data.RefreshToken) {
          response.cookies.set("refreshToken", data.RefreshToken, {
            httpOnly: true,
            secure: COOKIE_SECURE,
            sameSite: "lax",
            expires: new Date(data.RefreshTokenExpiresAt),
            path: "/",
          });

          response.cookies.set("refreshTokenExpiresAt", data.RefreshTokenExpiresAt, {
            httpOnly: true,
            secure: COOKIE_SECURE,
            sameSite: "lax",
            path: "/",
          });
        }

        // Update user info if provided
        if (refreshedUserInfo) {
          response.cookies.set(
            "user_info",
            refreshedUserInfo,
            {
              secure: COOKIE_SECURE,
              sameSite: "lax",
              path: "/",
              expires: new Date(data.RefreshTokenExpiresAt || data.AccessTokenExpiresAt),
            }
          );
        }

        return response;
      }
    } catch (error) {
      console.error("Proxy token refresh failed:", error);
    }
  }

  // No valid session - clear all auth cookies and redirect to login
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("callbackUrl", `${pathname}${request.nextUrl.search}`);
  
  const response = NextResponse.redirect(loginUrl);
  response.cookies.delete("accessToken");
  response.cookies.delete("refreshToken");
  response.cookies.delete("accessTokenExpiresAt");
  response.cookies.delete("refreshTokenExpiresAt");
  response.cookies.delete("user_info");
  
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder assets
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
