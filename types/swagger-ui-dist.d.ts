// Ambient typings for the swagger-ui-dist ESM sub-path import used by
// app/api-docs/SwaggerDocs.tsx. The package ships without a declaration
// file for this specific entry, so we declare the minimal surface we use.

declare module "swagger-ui-dist/swagger-ui-es-bundle.js" {
  type SwaggerUIOptions = Record<string, unknown>;
  type SwaggerUIInstance = { unmount?: () => void } | null;
  const SwaggerUIBundle: (config: SwaggerUIOptions) => SwaggerUIInstance;
  export default SwaggerUIBundle;
}
