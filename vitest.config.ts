import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/renderer/src/stores/__tests__/**/*.test.ts", "src/main/__tests__/**/*.test.ts", "src/shared/__tests__/**/*.test.ts"],
  },
});
