import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: process.env.HW_LOCAL_API ?? "http://127.0.0.1:5000",
        changeOrigin: false,
      },
    },
  },
  preview: { host: "127.0.0.1" },
});
