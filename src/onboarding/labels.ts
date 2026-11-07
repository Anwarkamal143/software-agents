import type { GitHubClient } from "../github/client.js";
import { JOB_STATUSES } from "../jobs/projection.js";
import { statusLabel } from "../mirror/status.js";

/** The labels the Factory uses on a Target repo: the ready label that approves a Job, and one per Job status. */
export function factoryLabels(readyLabel: string): { name: string; color: string; description: string }[] {
  return [
    { name: readyLabel, color: "0e8a16", description: "Approved for the Software Factory" },
    ...JOB_STATUSES.map((status) => ({ name: statusLabel(status), color: "c5def5", description: `Software Factory: Job ${status}` })),
  ];
}

/** Creates whichever Factory labels the repo doesn't have yet; returns their names. Running it again creates none. */
export async function ensureLabels(client: GitHubClient, repo: string, readyLabel: string): Promise<string[]> {
  const existing = new Set((await client.all<{ name: string }>(`/repos/${repo}/labels?per_page=100`, { repo })).map((l) => l.name.toLowerCase()));
  const created: string[] = [];
  for (const label of factoryLabels(readyLabel)) {
    if (existing.has(label.name.toLowerCase())) continue;
    await client.request("POST", `/repos/${repo}/labels`, { repo, body: label });
    created.push(label.name);
  }
  return created;
}
