#!/usr/bin/env node
/* eslint-disable */
// scripts/check-key-exposure.mjs
// ----------------------------------------------------------------------------
// Build-time guard. Fails the build if `getPlatformWalletPrivateKey` is
// referenced outside the small allowlist of server-internal files that
// actually need to sign transactions.
// ----------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const SYMBOL = "getPlatformWalletPrivateKey";

// Paths relative to repo root. Use forward slashes; normalized on compare.
const ALLOWLIST = new Set(
  [
    "app/lib/platform-wallet-service.ts",
    "app/lib/operator-service.ts",
    "app/lib/staking-service.ts",
    "app/lib/treasury-service.ts",
    "scripts/check-key-exposure.mjs",
  ].map((p) => p.split("/").join(sep))
);

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "sql",
  "config",
]);

const SCAN_EXTS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

const offenders = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full);
      continue;
    }
    if (!SCAN_EXTS.some((ext) => name.endsWith(ext))) continue;

    const rel = relative(ROOT, full);
    let contents;
    try {
      contents = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!contents.includes(SYMBOL)) continue;
    if (ALLOWLIST.has(rel)) continue;

    offenders.push(rel.split(sep).join("/"));
  }
}

walk(ROOT);

if (offenders.length > 0) {
  console.error(
    `\n[check-key-exposure] ${SYMBOL} referenced outside allowlist:\n` +
      offenders.map((f) => `  - ${f}`).join("\n") +
      `\n\nAllowed files:\n` +
      [...ALLOWLIST]
        .map((p) => `  - ${p.split(sep).join("/")}`)
        .join("\n") +
      "\n"
  );
  process.exit(1);
}

console.log(`[check-key-exposure] OK (${SYMBOL} only referenced in allowlist)`);
