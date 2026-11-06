import type { Source, SourceItem } from "../../src/source/source.js";

/** A Source that hands out whatever the test pushes, once. */
export class FakeSource implements Source {
  private pending: SourceItem[] = [];
  polls = 0;
  /** Logins with write access to every repo. */
  writers = new Set(["alice", "bob"]);

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

  async hasWriteAccess(_repo: string, login: string) {
    return this.writers.has(login);
  }
}

export const approved = (issue: number, labels: string[] = [], body = "Please do the thing."): SourceItem => ({
  kind: "approved",
  repo: "acme/web-app",
  issue: { number: issue, title: `Issue ${issue}`, body },
  labels: ["factory:ready", ...labels],
  by: "alice",
});

let comments = 0;
/** A comment on issue `issue`, by alice and written a second from now unless told otherwise. */
export const comment = (issue: number, body: string, over: { by?: string; created_at?: string; id?: string } = {}): SourceItem => ({
  kind: "comment",
  repo: "acme/web-app",
  issue,
  comment: { id: over.id ?? `comment-${++comments}`, body, by: over.by ?? "alice", created_at: over.created_at ?? new Date(Date.now() + 1000).toISOString() },
});
