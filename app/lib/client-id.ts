// Generate a unique client-side id (used for toast keys, etc.).
//
// `crypto.randomUUID()` is only defined in a "secure context" — HTTPS or
// localhost. When the app is served over plain HTTP (e.g. a bare IP with
// no TLS), `crypto.randomUUID` is undefined and calling it throws
// "crypto.randomUUID is not a function", crashing the page. This helper
// falls back to a timestamp+random id so non-secure contexts keep working.
export function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
