import { defineConfig } from "vitest/config";

export default defineConfig({
  // Next preserves JSX for its own compiler; Vitest must transform it for SSR.
  oxc: { jsx: { runtime: "automatic" } },
});
