// app/api-docs/SwaggerDocs.tsx
// Client-only wrapper around swagger-ui-dist. We intentionally use the
// vanilla JS bundle instead of swagger-ui-react because swagger-ui-react v5
// still uses UNSAFE_componentWillReceiveProps and friends, which React 19's
// strict mode warns about in dev. The dist bundle mounts itself into a
// plain <div> and manages its own DOM, bypassing React's lifecycle entirely.

"use client";

import { useEffect, useRef } from "react";
import "swagger-ui-dist/swagger-ui.css";

type SwaggerUIInstance = { unmount?: () => void } | null;

export default function SwaggerDocs({ specUrl }: { specUrl: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let instance: SwaggerUIInstance = null;

    (async () => {
      // Dynamic import keeps the ~1MB bundle off the server and out of the
      // initial RSC payload. `swagger-ui-es-bundle` is the single-file ESM
      // build that contains both the UI and its standalone preset.
      const mod = await import("swagger-ui-dist/swagger-ui-es-bundle.js");
      if (cancelled || !container) return;

      const SwaggerUIBundle =
        (mod as unknown as { default?: unknown }).default ?? mod;

      instance = (SwaggerUIBundle as (config: Record<string, unknown>) => SwaggerUIInstance)({
        domNode: container,
        url: specUrl,
        docExpansion: "list",
        deepLinking: true,
        tryItOutEnabled: true,
        persistAuthorization: true,
      });
    })();

    return () => {
      cancelled = true;
      // swagger-ui-dist doesn't expose a formal teardown API; clearing the
      // mount node is the documented way to fully unmount it.
      if (instance?.unmount) instance.unmount();
      if (container) container.innerHTML = "";
    };
  }, [specUrl]);

  return (
    <div className="api-docs-root bg-white min-h-screen">
      <div ref={containerRef} />
    </div>
  );
}
