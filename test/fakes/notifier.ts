import type { Notifier } from "../../src/humans/notify.js";

/** Records every notification instead of showing it. */
export class FakeNotifier implements Notifier {
  notes: { title: string; body: string }[] = [];

  async notify(note: { title: string; body: string }) {
    this.notes.push(note);
  }
}
