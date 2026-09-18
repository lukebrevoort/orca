import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // Keep framework and wire contracts independently cacheable. Group each
        // dependency family together so initialization never crosses a cycle.
        // Include dependencies with the feature to avoid back-imports into the
        // application entry (notably its shared guidance and top-layer context).
        onlyExplicitManualChunks: false,
        manualChunks(id) {
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) {
            return "react-vendor";
          }
          if (id.includes("/node_modules/zod/") || id.includes("/packages/shared/src/")) {
            return "mail-contracts";
          }
          if (id.endsWith("/apps/web/src/organization-views.tsx")) {
            return "organization-views";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
});
