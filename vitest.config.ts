import { defineConfig } from "vitest/config";

export default defineConfig({
  // End-to-end Orchestrator tests run real git and the real Sandbox; in a full parallel run the
  // longest (several Bounces, two Attempts) need more than 30s.
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000 },
});
