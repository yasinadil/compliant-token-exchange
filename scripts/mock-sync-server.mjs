// scripts/mock-sync-server.mjs
//
// Zero-dependency mock of the external MS SQL Server sync API, implementing the
// exact contract from SQL_SERVER_SYNC_HANDOFF.md: X-Api-Key auth, Idempotency-Key
// replay, natural-key upsert with a version guard, and the status-code contract.
// Use it to test the outbox end-to-end before the real SQL Server API exists.
//
// Usage (PowerShell):
//   node scripts/mock-sync-server.mjs
//   $env:MOCK_MODE="flaky"; node scripts/mock-sync-server.mjs   # fail first N attempts then succeed
//   $env:MOCK_MODE="fatal"; node scripts/mock-sync-server.mjs   # always 400 (-> dead_letter)
//   $env:MOCK_MODE="ratelimit"; node scripts/mock-sync-server.mjs # always 429 + Retry-After
//
// Env:
//   PORT             (default 4000)
//   MOCK_API_KEY     (default "test-key")  — must match SYNC_API_KEY
//   MOCK_MODE        ok | flaky | fatal | ratelimit   (default ok)
//   MOCK_FLAKY_FAILS (default 2)  — attempts to fail per job before succeeding in flaky mode
//
// Inspect state:  GET  http://localhost:4000/_state
// Reset state:    POST http://localhost:4000/_reset

import http from "node:http";

const PORT = Number(process.env.PORT) || 4000;
const API_KEY = process.env.MOCK_API_KEY || "test-key";
const MODE = (process.env.MOCK_MODE || "ok").toLowerCase();
const FLAKY_FAILS = Number(process.env.MOCK_FLAKY_FAILS) || 2;

// In-memory "database".
const records = new Map(); // sourceId -> { version, remoteRef, data, entity }
const idempotency = new Map(); // idempotencyKey -> { remoteRef, duplicate }
const attempts = new Map(); // idempotencyKey -> count (for flaky mode)
let refCounter = 0;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // --- Introspection helpers ------------------------------------------------
  if (method === "GET" && path === "/_state") {
    return json(res, 200, {
      mode: MODE,
      records: [...records.values()],
      idempotencyKeys: [...idempotency.keys()],
    });
  }
  if (method === "POST" && path === "/_reset") {
    records.clear();
    idempotency.clear();
    attempts.clear();
    refCounter = 0;
    return json(res, 200, { ok: true });
  }

  const isUpsert = method === "POST" && path === "/api/sync/upsert";
  if (!isUpsert) {
    return json(res, 404, { error: "not found" });
  }

  // --- Auth (401 = permanent) ----------------------------------------------
  if (req.headers["x-api-key"] !== API_KEY) {
    log(method, "-", "-", "-", 401, "bad api key");
    return json(res, 401, { error: "unauthorized" });
  }

  // --- Parse + validate (400 = permanent) -----------------------------------
  let env;
  try {
    env = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "invalid json" });
  }
  const key = req.headers["idempotency-key"] || env.idempotency_key;
  const { entity, source_id, version, data } = env;
  if (!key || !entity || !source_id || typeof version !== "number" || !data) {
    log(method, entity, source_id, version, 400, "missing fields");
    return json(res, 400, { error: "missing required fields" });
  }

  // --- Idempotency replay ---------------------------------------------------
  if (idempotency.has(key)) {
    const prior = idempotency.get(key);
    log(method, entity, source_id, version, 200, "duplicate replay");
    return json(res, 200, { remote_ref: prior.remoteRef, duplicate: true });
  }

  // --- Failure injection ----------------------------------------------------
  if (MODE === "fatal") {
    log(method, entity, source_id, version, 400, "MODE=fatal");
    return json(res, 400, { error: "simulated permanent validation error" });
  }
  if (MODE === "ratelimit") {
    log(method, entity, source_id, version, 429, "MODE=ratelimit");
    return json(res, 429, { error: "rate limited" }, { "Retry-After": "2" });
  }
  if (MODE === "flaky") {
    const n = (attempts.get(key) || 0) + 1;
    attempts.set(key, n);
    if (n <= FLAKY_FAILS) {
      log(method, entity, source_id, version, 503, `MODE=flaky attempt ${n}/${FLAKY_FAILS}`);
      return json(res, 503, { error: "simulated transient error" });
    }
  }

  // --- Upsert with version guard (MERGE semantics) --------------------------
  const existing = records.get(source_id);
  if (existing && existing.version >= version) {
    // Stale/reordered write: keep newer data, but still succeed idempotently.
    idempotency.set(key, { remoteRef: existing.remoteRef, duplicate: false });
    log(method, entity, source_id, version, 200, `stale (stored v${existing.version})`);
    return json(res, 200, { remote_ref: existing.remoteRef, duplicate: false });
  }

  const isNew = !existing;
  const remoteRef = existing ? existing.remoteRef : String(++refCounter);
  records.set(source_id, { entity, source_id, version, remoteRef, data });
  idempotency.set(key, { remoteRef, duplicate: false });

  const status = isNew ? 201 : 200;
  log(method, entity, source_id, version, status, isNew ? "created" : "updated");
  return json(res, status, { remote_ref: remoteRef, duplicate: false });
});

function log(method, entity, sourceId, version, status, note) {
  const ts = new Date().toISOString();
  console.log(
    `[mock ${ts}] ${method} ${entity} ${sourceId} v${version} -> ${status} (${note})`
  );
}

server.listen(PORT, () => {
  console.log(
    `[mock] sync server listening on http://localhost:${PORT}  mode=${MODE}  apiKey=${API_KEY}`
  );
  console.log(`[mock]   POST /api/sync/upsert`);
  console.log(`[mock]   GET  /_state   POST /_reset`);
});
