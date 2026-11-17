import { defineConfig } from "vite";

// `npm run build:engine`: bundles the engine CLI (src/engine/cli.ts) into one
// self-contained ES module that the API runs under Node to index and check
// sheets (FSDP_ENGINE_CLI). No plugins, no externals, no runtime dependencies.
export default defineConfig({
  build: {
    ssr: "src/engine/cli.ts",
    outDir: "dist-engine",
    emptyOutDir: true,
    target: "node18",
    minify: false,
    rollupOptions: {
      output: { format: "es", entryFileNames: "engine-cli.mjs" }
    }
  },
  ssr: { noExternal: true }
});
