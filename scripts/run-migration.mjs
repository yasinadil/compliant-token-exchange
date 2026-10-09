// scripts/run-migration.mjs
//
// One-shot migration runner. Reads a .sql file and executes it against the
// MySQL database whose credentials live in .env.local.
//
// Usage:
//   node scripts/run-migration.mjs sql/migrations/021_add_onramp_target_token.sql
//
// Safe to re-run: the migration's ALTER TABLE statements will error out the
// second time (column already exists) — that error tells you it's already
// applied. To avoid the error noise, only run this against any given
// migration file once.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// Hand-roll a tiny .env.local parser so we don't pull in a new dependency
// just for one script. Supports `KEY="value"` and `KEY=value`.
function loadEnvLocal() {
  const envPath = path.join(projectRoot, ".env.local");
  if (!fs.existsSync(envPath)) {
    console.error(`[migration] .env.local not found at ${envPath}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const env = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnvLocal();

const sqlPathArg = process.argv[2];
if (!sqlPathArg) {
  console.error(
    "[migration] Usage: node scripts/run-migration.mjs <path-to-sql-file>"
  );
  process.exit(1);
}

const sqlPath = path.isAbsolute(sqlPathArg)
  ? sqlPathArg
  : path.join(projectRoot, sqlPathArg);

if (!fs.existsSync(sqlPath)) {
  console.error(`[migration] SQL file not found: ${sqlPath}`);
  process.exit(1);
}

const sql = fs.readFileSync(sqlPath, "utf8");

// Split on `;` followed by newline so multi-statement migration files run
// statement-by-statement (mysql2 disables multi-statement by default unless
// you opt in, which we won't — safer).
//
// `stripComments` peels off leading `-- …` lines (and any blank lines
// between them) so a chunk like:
//     -- some explanatory header
//     -- still header
//     ALTER TABLE foo ADD …
// is recognised as having SQL to run, instead of being dropped as
// "purely a comment."
function stripComments(s) {
  const lines = s.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("--")) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n").trim();
}

const statements = sql
  .split(/;\s*\r?\n/)
  .map((s) => stripComments(s))
  .filter((s) => s !== "");

const connection = await mysql.createConnection({
  host: env.MYSQL_HOST,
  port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
  ssl:
    env.MYSQL_SSL && env.MYSQL_SSL !== "disabled"
      ? { rejectUnauthorized: false }
      : undefined,
});

console.log(
  `[migration] Connected to ${env.MYSQL_HOST}:${env.MYSQL_PORT} (db: ${env.MYSQL_DATABASE})`
);
console.log(`[migration] Running ${path.basename(sqlPath)} (${statements.length} statements)\n`);

let ok = 0;
let failed = 0;
for (const stmt of statements) {
  // Trim inline comments off the end so the preview line is readable.
  const preview = stmt.replace(/\s+/g, " ").slice(0, 100);
  try {
    await connection.query(stmt);
    console.log(`  ✓ ${preview}${stmt.length > 100 ? "…" : ""}`);
    ok++;
  } catch (err) {
    console.log(`  ✗ ${preview}${stmt.length > 100 ? "…" : ""}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

await connection.end();

console.log(`\n[migration] Done. ${ok} ok, ${failed} failed.`);
if (failed > 0) {
  process.exit(2);
}
