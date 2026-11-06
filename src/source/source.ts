import { createHash } from "node:crypto";

/** Where Jobs come from. A Source only reads; everything written back goes through a Mirror. */

export interface IssueText {
  number: number;
  title: string;
  body: string;
}

export type SourceItem =
  /** An allowed person applied the ready label. */
  | { kind: "approved"; repo: string; issue: IssueText; labels: string[]; by: string }
  /** An allowed person removed the ready label. */
  | { kind: "unapproved"; repo: string; issue: number; by: string }
  /** A comment on the issue, new or edited: maybe a Reply command (ADR 0006). */
  | { kind: "comment"; repo: string; issue: number; comment: IssueComment }
  /**
   * The issue's title or body changed. `hash` is of the new title and body; `by` is who edited
   * it, null if GitHub doesn't say. Only an edit by an allowed person counts as re-approval (ADR 0007).
   */
  | { kind: "edited"; repo: string; issue: IssueText; hash: string; by: string | null }
  | { kind: "closed"; repo: string; issue: number; by: string }
  | { kind: "reopened"; repo: string; issue: number; by: string }
  /** A pull request from `branch` was merged, or closed without merging. */
  | { kind: "pr-merged"; repo: string; pr: number; branch: string; by: string }
  | { kind: "pr-closed"; repo: string; pr: number; branch: string; by: string };

export interface IssueComment {
  id: string;
  body: string;
  /** The GitHub login that wrote it. */
  by: string;
  /** When it was created; an edit doesn't move this. */
  created_at: string;
}

/**
 * The Source refused the Factory's credentials (bad or revoked, an App uninstalled): a Factory
 * fault, not something to retry (ADR 0010). The Factory pauses until a poll gets through again.
 */
export class SourceCredentialsRefused extends Error {
  override name = "SourceCredentialsRefused";
}

/** The hash an approval is of: the issue's title and body as approved. Edits are compared by it. */
export function issueHash(issue: Pick<IssueText, "title" | "body">): string {
  return createHash("sha256").update(`${issue.title}\0${issue.body}`).digest("hex");
}

export interface Source {
  /** Items since `cursor`, and the cursor to pass next time. Throws SourceCredentialsRefused for a Factory fault. */
  poll(cursor: string | null): Promise<{ items: SourceItem[]; cursor: string | null }>;
  /** Whether `login` has write access to `repo` right now. */
  hasWriteAccess(repo: string, login: string): Promise<boolean>;
}
