import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    // Aurora ships as a Tauri app; macOS min is 11.0 (tauri.conf.json ->
    // bundle.macOS.minimumSystemVersion), i.e. Safari 14 WebKit. Pin that
    // floor explicitly. Output is byte-identical to Vite's default here, but
    // this documents the invariant and stops anyone bumping to `esnext`, which
    // would risk shipping syntax Safari 14 (macOS 11) can't parse.
    target: "safari14",
    // No source maps in the production bundle (this is Vite's default; kept
    // explicit so it can't be turned on by accident and bloat the app).
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing vendors out of the app chunk.
        // Better long-term caching (a vendor stays byte-identical across app
        // updates) and lets WebKit parse/compile the chunks in parallel.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@xterm")) return "xterm";
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "react";
          }
          return "vendor";
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
