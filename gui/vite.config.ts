import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // /api is the local server (npm run server); the GUI falls back to sample mode when it is not running.
  server: { fs: { allow: [".."] }, port: 5173, strictPort: true, proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
