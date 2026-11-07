import { defineConfig } from "vitest/config";

export default defineConfig({
  // End-to-end Orchestrator tests run real git and the real Sandbox; in a full parallel run the
  // longest (several Bounces, two Attempts, a rebase and re-check) take up to about 50s.
  test: { include: ["test/**/*.test.ts"], testTimeout: 120_000 },
});
