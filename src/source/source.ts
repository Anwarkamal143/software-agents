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
  | { kind: "unapproved"; repo: string; issue: number; by: string };

export interface Source {
  /** Items since `cursor`, and the cursor to pass next time. */
  poll(cursor: string | null): Promise<{ items: SourceItem[]; cursor: string | null }>;
}
