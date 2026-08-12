// Vite `?raw` imports used by adapter tests to load trimmed HTML fixtures as
// strings (vitest.config.ts runs the edge-runtime environment, so node:fs is
// not available inside tests — bundler-time raw imports are).
declare module "*.html?raw" {
  const content: string;
  export default content;
}
