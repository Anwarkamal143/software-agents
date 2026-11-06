import type { Mirror, MirrorUpdate } from "../../src/mirror/mirror.js";

/** Records every write, as [event type, Job status, Stage]. */
export class FakeMirror implements Mirror {
  writes: MirrorUpdate[] = [];

  async write(update: MirrorUpdate) {
    this.writes.push(update);
  }

  summary() {
    return this.writes.map((w) => [w.event.type, w.job.status, w.job.stage] as const);
  }
}
