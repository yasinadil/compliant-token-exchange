import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    resolveAlias: {
      // wagmi's Tempo connector does `await import('accounts')` on an
      // optional dep that isn't installed. Turbopack resolves it at build
      // time and fails; alias it to a stub since the connector is unused.
      accounts: "./stubs/accounts.ts",
    },
  },
};

export default nextConfig;
