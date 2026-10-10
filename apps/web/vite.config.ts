import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Split the vendor libraries out so the app chunk stays readable in a diff
    // and the browser caches them across deploys.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          tanstack: ["@tanstack/react-query", "@tanstack/react-router"],
          motion: ["motion/react"],
          baseui: ["@base-ui/react/dialog", "@base-ui/react/select"],
          anvia: ["@anvia/react-ui/stream", "@anvia/react", "@anvia/client"],
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
