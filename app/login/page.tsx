// app/login/page.tsx
"use client";

import { useActionState, useState } from "react";
import { login, register } from "@/app/actions/auth";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function AuthForms() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loginState, loginAction, loginPending] = useActionState(login, null);
  const [registerState, registerAction, registerPending] = useActionState(register, null);
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl");
  const justRegistered = searchParams.get("registered") === "true";

  const state = mode === "login" ? loginState : registerState;
  const isPending = mode === "login" ? loginPending : registerPending;
  const formAction = mode === "login" ? loginAction : registerAction;

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--ex-bg)] px-6 py-8 sm:px-8">
      <div className="ex-card relative w-full max-w-2xl px-6 py-7 sm:px-12 sm:py-10">
        {/* Mode Toggle */}
        <div className="flex gap-6 mb-8 border-b border-gray-200">
          <button
            type="button"
            onClick={() => setMode("login")}
            className={`pb-3 -mb-px font-semibold text-sm transition-all border-b-2 ${
              mode === "login"
                ? "text-sky-500 border-sky-500"
                : "text-gray-400 border-transparent hover:text-gray-600"
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => setMode("register")}
            className={`pb-3 -mb-px font-semibold text-sm transition-all border-b-2 ${
              mode === "register"
                ? "text-sky-500 border-sky-500"
                : "text-gray-400 border-transparent hover:text-gray-600"
            }`}
          >
            Create Account
          </button>
        </div>

        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-3">
            {mode === "login" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="text-gray-500">
            {mode === "login"
              ? "Sign in to your account to continue"
              : "Get started with your free account"}
          </p>
        </div>

        {/* Just-registered banner */}
        {justRegistered && mode === "login" && (
          <div className="mb-5 p-4 bg-sky-50 border border-sky-100 rounded-xl">
            <p className="text-sm text-sky-600 flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Account created successfully. Please sign in.
            </p>
          </div>
        )}

        <form action={formAction} className="space-y-6">
          {/* Name (register only) */}
          {mode === "register" && (
            <div>
              <label
                htmlFor="name"
                className="block text-sm font-medium text-gray-500 mb-2"
              >
                Full name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                placeholder="John Doe"
                className="w-full px-1 py-2 bg-transparent border-0 border-b border-gray-300 text-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:border-sky-500 transition-all"
              />
            </div>
          )}

          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-500 mb-2"
            >
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="text"
              required
              autoComplete="email"
              placeholder="you@example.com"
              className="w-full px-1 py-2 bg-transparent border-0 border-b border-gray-300 text-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:border-sky-500 transition-all"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-500 mb-2"
            >
              Password
            </label>
            <div className="relative">
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder="••••••••"
              className="w-full px-1 py-2 pr-10 bg-transparent border-0 border-b border-gray-300 text-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:border-sky-500 transition-all"
            />
              <PasswordVisibilityButton
                visible={showPassword}
                onClick={() => setShowPassword((visible) => !visible)}
              />
            </div>
          </div>

          {/* Confirm password (register only) */}
          {mode === "register" && (
            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-gray-500 mb-2"
              >
                Confirm password
              </label>
              <div className="relative">
              <input
                id="confirmPassword"
                name="confirmPassword"
                type={showConfirmPassword ? "text" : "password"}
                required
                autoComplete="new-password"
                placeholder="••••••••"
                className="w-full px-1 py-2 pr-10 bg-transparent border-0 border-b border-gray-300 text-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:border-sky-500 transition-all"
              />
                <PasswordVisibilityButton
                  visible={showConfirmPassword}
                  onClick={() => setShowConfirmPassword((visible) => !visible)}
                />
              </div>
            </div>
          )}

          {/* Error message */}
          {state?.error && (
            <div className="p-4 bg-red-50 border border-red-100 rounded-xl">
              <p className="text-sm text-red-500 flex items-center gap-2">
                <svg
                  className="w-4 h-4 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                {state.error}
              </p>
            </div>
          )}

          {/* Callback URL info */}
          {callbackUrl && callbackUrl !== "/" && mode === "login" && (
            <p className="text-xs text-gray-400 text-center">
              You&apos;ll be redirected to {callbackUrl} after login
            </p>
          )}

          <button
            type="submit"
            disabled={isPending}
            className="w-full py-4 px-4 bg-sky-500 hover:bg-sky-600 disabled:bg-gray-300 text-white font-semibold rounded-lg shadow-sm transition-all duration-200 flex items-center justify-center gap-2"
          >
            {isPending ? (
              <>
                <svg
                  className="animate-spin w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                {mode === "login" ? "Signing in..." : "Creating account..."}
              </>
            ) : mode === "login" ? (
              "Sign in"
            ) : (
              "Create account"
            )}
          </button>
        </form>

        {/* Toggle link */}
        <p className="mt-6 text-center text-sm text-gray-500">
          {mode === "login" ? (
            <>
              Don&apos;t have an account?{" "}
              <button
                type="button"
                onClick={() => setMode("register")}
                className="text-sky-500 hover:text-sky-600 font-medium transition-colors"
              >
                Create one
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => setMode("login")}
                className="text-sky-500 hover:text-sky-600 font-medium transition-colors"
              >
                Sign in
              </button>
            </>
          )}
        </p>

        {/* Footer */}
        <p className="mt-6 text-center text-sm text-gray-400">
          Powered by{" "}
          <span className="text-sky-500 font-medium">the platform</span>
        </p>
      </div>
    </div>
  );
}

function PasswordVisibilityButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={visible ? "Hide password" : "Show password"}
      aria-pressed={visible}
      className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-gray-400 transition-colors hover:text-sky-500 focus:outline-none focus:text-sky-500"
    >
      {visible ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  );
}

function EyeIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M2.25 12s3.5-6 9.75-6 9.75 6 9.75 6-3.5 6-9.75 6-9.75-6-9.75-6Z" />
      <circle cx="12" cy="12" r="2.75" strokeWidth={1.7} />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="m3 3 18 18M10.6 6.1A11.6 11.6 0 0 1 12 6c6.25 0 9.75 6 9.75 6a17.9 17.9 0 0 1-3.2 3.75M6.2 6.6C3.65 8.45 2.25 12 2.25 12s3.5 6 9.75 6c1.55 0 2.9-.37 4.07-.92M9.95 9.95a2.75 2.75 0 0 0 3.9 3.9" />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[var(--ex-bg)] px-4">
          <div className="ex-card flex h-20 w-20 items-center justify-center">
            <div className="animate-spin w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full" />
          </div>
        </div>
      }
    >
      <AuthForms />
    </Suspense>
  );
}
