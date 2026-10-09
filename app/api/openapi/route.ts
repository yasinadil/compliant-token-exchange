// Serves the OpenAPI spec as JSON from an `/api/*` path. This route exists so
// the spec is fetched from a path the auth proxy skips (see proxy.ts, which
// bypasses `/api/*`). Serving it from `/openapi.json` instead sent Swagger UI
// through the auth redirect and returned the login page's HTML, which the UI
// cannot parse. The source of truth is still public/openapi.json.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-static";

export async function GET() {
  const file = path.join(process.cwd(), "public", "openapi.json");
  const json = await readFile(file, "utf8");
  return new NextResponse(json, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
