import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["skills/release-reader/tests/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
