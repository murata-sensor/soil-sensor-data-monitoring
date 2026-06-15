import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const rawBase = process.env.VITE_BASE_PATH?.trim() || "/";
  const base = rawBase === "/" ? "/" : rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
  return {
    plugins: [react()],
    base,
    define: {
      "process.env.DRAGGABLE_DEBUG": "undefined",
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
    },
  };
});
