import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "src/features/cloud/**",
      "src/features/agent-awareness/**",
      "src/features/connection/environmentSections.test.ts",
      "src/features/observability/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
