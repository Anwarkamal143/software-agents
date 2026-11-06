import type { Source, SourceItem } from "../../src/source/source.js";

/** A Source that hands out whatever the test pushes, once. */
export class FakeSource implements Source {
  private pending: SourceItem[] = [];
  polls = 0;

  push(...items: SourceItem[]): this {
    this.pending.push(...items);
    return this;
  }

  async poll(cursor: string | null) {
    this.polls++;
    const items = this.pending;
    this.pending = [];
    return { items, cursor: String(Number(cursor ?? 0) + items.length) };
  }
}

export const approved = (issue: number, labels: string[] = [], body = "Please do the thing."): SourceItem => ({
  kind: "approved",
  repo: "acme/web-app",
  issue: { number: issue, title: `Issue ${issue}`, body },
  labels: ["factory:ready", ...labels],
  by: "alice",
});
