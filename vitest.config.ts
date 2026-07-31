import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Isolated store: tests must never write into the dev data/ directory.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfc-test-"));

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    env: {
      CFC_DATA_DIR: testDataDir,
      OPERATOR_BRAIN: "fixture",
      NOTIFY: "off",
    },
  },
});
