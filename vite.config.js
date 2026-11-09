import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/recharts")) return "recharts";
          if (id.includes("node_modules/d3-")) return "d3-vendor";
        }
      }
    }
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4000",
      "/uploads": "http://127.0.0.1:4000"
    }
  }
});
