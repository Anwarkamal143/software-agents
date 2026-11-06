/** The fixed moments the Orchestrator evaluates Policies at. */
export const CHECKPOINTS = ["before-stage-run", "after-stage-result", "merge-gate", "after-merge"] as const;

export type Checkpoint = (typeof CHECKPOINTS)[number];
