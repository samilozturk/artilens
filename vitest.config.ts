import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000
  },
  resolve: {
    alias: {
      "@artilens/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@artilens/guard": new URL("./packages/guard/src/index.ts", import.meta.url).pathname,
      "@artilens/lens": new URL("./packages/lens/src/index.ts", import.meta.url).pathname,
      "@artilens/git-viz": new URL("./packages/git-viz/src/index.ts", import.meta.url).pathname,
      "@artilens/session-viz": new URL("./packages/session-viz/src/index.ts", import.meta.url).pathname,
      "@artilens/docs-health": new URL("./packages/docs-health/src/index.ts", import.meta.url).pathname
    }
  }
});
