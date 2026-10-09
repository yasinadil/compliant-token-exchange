// scripts/test-sync-endpoint.mjs
// One-off smoke test against the downstream sync endpoint. Validates:
//   1. reachability + TLS
//   2. API-key auth (valid -> success, invalid -> 401)
//   3. payload validation (bad schema_version -> 400)
// Mirrors the exact request the app's sync-api-client sends.
//
// Run (Node 22+, loads .env.local automatically):
//   node --env-file=.env.local scripts/test-sync-endpoint.mjs
//
// NOTE: the success case creates a clearly-labelled TEST row on the downstream
// (entity=user, source_id=user:conn-test-<ts>). Ask the developer to purge it.

const BASE = process.env.SYNC_API_BASE_URL || "";
const KEY = process.env.SYNC_API_KEY || "";
const KEY_HEADER = process.env.SYNC_API_KEY_HEADER || "X-Api-Key";
const PATH = process.env.SYNC_API_UPSERT_PATH || "/api/sync/upsert";
const TIMEOUT_MS = Number(process.env.SYNC_API_TIMEOUT_MS) || 15000;

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

const URL_FULL = joinUrl(BASE, PATH);

function uuid() {
  return crypto.randomUUID();
}

function makeEnvelope({ schemaVersion = 1 } = {}) {
  const id = uuid();
  const ts = new Date().toISOString();
  return {
    idempotency_key: id,
    source_system: process.env.SYNC_SOURCE_SYSTEM || "nextjs-app",
    source_id: `user:conn-test-${Date.now()}`,
    entity: "user",
    operation: "UPDATE",
    version: 1,
    occurred_at: ts,
    schema_version: schemaVersion,
    data: {
      userId: `conn-test-${Date.now()}`,
      email: "connectivity-test@example.com",
      updatedAt: ts,
    },
  };
}

async function send(envelope, { apiKey } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": envelope.idempotency_key,
    };
    if (apiKey) headers[KEY_HEADER] = apiKey;

    const res = await fetch(URL_FULL, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: true, status: res.status, body: text.slice(0, 400), ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function line(label, expected, r) {
  if (!r.ok) {
    console.log(`  [NETWORK ERROR] ${label}: ${r.error} (${r.ms}ms)`);
    return false;
  }
  const pass = expected.includes(r.status);
  const tag = pass ? "PASS" : "FAIL";
  console.log(
    `  [${tag}] ${label}: HTTP ${r.status} (expected ${expected.join("/")}) ${r.ms}ms`
  );
  if (r.body) console.log(`         body: ${r.body}`);
  return pass;
}

async function main() {
  console.log("Sync endpoint smoke test");
  console.log("========================");
  console.log(`URL        : ${URL_FULL}`);
  console.log(`Key header : ${KEY_HEADER}`);
  console.log(`Key set    : ${KEY ? `yes (len ${KEY.length})` : "NO — aborting"}`);
  console.log("");
  if (!BASE) return console.error("SYNC_API_BASE_URL is empty. Aborting.");
  if (!KEY) return console.error("SYNC_API_KEY is empty. Aborting.");

  const results = [];

  console.log("Test 1 — valid upsert with real key (expect 200/201):");
  results.push(line("valid+key", [200, 201], await send(makeEnvelope(), { apiKey: KEY })));
  console.log("");

  console.log("Test 2 — same request with WRONG key (expect 401):");
  results.push(line("bad-key", [401], await send(makeEnvelope(), { apiKey: "wrong-key-000" })));
  console.log("");

  console.log("Test 3 — real key but bad schema_version=999 (expect 400):");
  results.push(
    line("bad-schema", [400], await send(makeEnvelope({ schemaVersion: 999 }), { apiKey: KEY }))
  );
  console.log("");

  const passed = results.filter(Boolean).length;
  console.log("========================");
  console.log(`${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
