import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        // Keep the browser's Host so the edge builds OAuth redirect URLs back to
        // this dev server (http://localhost:5173/api/auth/.../callback).
        changeOrigin: false,
      },
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
});
