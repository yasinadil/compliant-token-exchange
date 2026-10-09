// Stub for wagmi's optional "accounts" dependency (Tempo connector).
// The connector is never instantiated in this app, but wagmi's
// `await import('accounts')` makes Turbopack try to resolve it at
// build time. Aliasing to this stub keeps the build working.
export {};
