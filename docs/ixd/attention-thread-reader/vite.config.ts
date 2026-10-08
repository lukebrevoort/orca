import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ root: new URL("../../../apps/web", import.meta.url).pathname, plugins: [react()], server: { host: "127.0.0.1", port: 4320, strictPort: true, proxy: { "/v1": "http://127.0.0.1:4319", "/health": "http://127.0.0.1:4319" } } });
