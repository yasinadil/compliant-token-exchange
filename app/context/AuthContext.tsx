// app/context/AuthContext.tsx
"use client";

import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from "react";
import { logoutAction, refreshTokensAction } from "@/app/actions/auth";
import type { UserSession } from "@/app/lib/auth-service";

type AuthContextType = {
  user: UserSession | null;
  setUser: (user: UserSession | null) => void;
  logout: () => Promise<void>;
  isRefreshing: boolean;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Refresh token 1 minute before expiry
const REFRESH_BUFFER_MS = 60 * 1000;
// Check every 30 seconds
const CHECK_INTERVAL_MS = 30 * 1000;

export function AuthProvider({
  children,
  initialUser,
}: {
  children: ReactNode;
  initialUser: UserSession | null;
}) {
  const [user, setUser] = useState<UserSession | null>(initialUser);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const logout = useCallback(async () => {
    setUser(null);
    await logoutAction();
  }, []);

  // Set up automatic token refresh on the client side
  useEffect(() => {
    if (!user) return;

    const checkAndRefreshToken = async () => {
      // Get expiry from cookie (it's not httpOnly)
      const cookies = document.cookie.split(";").reduce((acc, cookie) => {
        const [key, value] = cookie.trim().split("=");
        acc[key] = value;
        return acc;
      }, {} as Record<string, string>);

      const expiresAt = cookies["accessTokenExpiresAt"];
      if (!expiresAt) return;

      const expiryTime = new Date(decodeURIComponent(expiresAt)).getTime();
      const now = Date.now();

      // If token expires within buffer time, refresh it
      if (now >= expiryTime - REFRESH_BUFFER_MS) {
        setIsRefreshing(true);
        try {
          const result = await refreshTokensAction();
          if (!result.success) {
            console.error("Token refresh failed:", result.error);
            // If refresh fails, logout
            await logout();
          }
        } catch (error) {
          console.error("Token refresh error:", error);
        } finally {
          setIsRefreshing(false);
        }
      }
    };

    // Check immediately and then periodically
    checkAndRefreshToken();
    const interval = setInterval(checkAndRefreshToken, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [user, logout]);

  // Sync user state with cookie on visibility change (e.g., tab focus)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Re-read user info from cookie when tab becomes visible
        const cookies = document.cookie.split(";").reduce((acc, cookie) => {
          const [key, value] = cookie.trim().split("=");
          acc[key] = value;
          return acc;
        }, {} as Record<string, string>);

        const userInfo = cookies["user_info"];
        if (userInfo) {
          try {
            const parsed = JSON.parse(decodeURIComponent(userInfo));
            setUser(parsed);
          } catch {
            // Invalid cookie, clear user
            setUser(null);
          }
        } else if (user) {
          // Cookie was cleared, logout
          setUser(null);
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, setUser, logout, isRefreshing }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
};
