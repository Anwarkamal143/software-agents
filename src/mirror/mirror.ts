import type { FactoryEvent } from "../events/envelope.js";
import type { JobState } from "../jobs/projection.js";

/** One recorded event and the Job's state after it. */
export interface MirrorUpdate {
  event: FactoryEvent;
  job: JobState;
}

/** A read-only copy of Job state kept for visibility. It never decides anything, and being down never blocks a Job. */
export interface Mirror {
  write(update: MirrorUpdate): Promise<void>;
}
