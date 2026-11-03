import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Fixture projects carry their own (foreign) tests; they are data, not ours to run.
    exclude: ["**/node_modules/**", "src/test/fixtures/**"],
  },
});
