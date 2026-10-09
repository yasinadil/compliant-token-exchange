// app/api-docs/page.tsx
// Swagger UI for the HTTP API. The spec is served from `/api/openapi` (which
// reads public/openapi.json) rather than `/openapi.json` directly: the auth
// proxy skips `/api/*`, so the spec fetch is never redirected to the login
// page. The UI itself is rendered entirely client-side — swagger-ui touches
// `window` on mount and ships its own CSS, so SSR is disabled in the wrapper.

import type { Metadata } from "next";
import SwaggerDocs from "./SwaggerDocs";

export const metadata: Metadata = {
  title: "API Reference",
  description: "Exchange HTTP API — checkout and ops endpoints.",
};

export default function ApiDocsPage() {
  return <SwaggerDocs specUrl="/api/openapi" />;
}
