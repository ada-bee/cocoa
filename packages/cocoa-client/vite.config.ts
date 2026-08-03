import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: { eager: true },
    outDir: "dist",
    platform: "neutral",
    target: "es2022",
    sourcemap: false,
    minify: true,
    deps: {
      alwaysBundle: [/^@t3tools\/contracts(?:\/|$)/],
      neverBundle: [/^effect(?:\/|$)/],
      onlyBundle: false,
      dts: {
        alwaysBundle: [/^@t3tools\/contracts(?:\/|$)/],
        neverBundle: [/^effect(?:\/|$)/],
      },
    },
  },
  test: {
    environment: "node",
  },
});
