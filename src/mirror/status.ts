import { FACTORY_MARKER } from "../humans/commands.js";
import { JOB_STATUSES, type JobState, type JobStatus } from "../jobs/projection.js";
import { cleanAgentText } from "./clean.js";

/** Reasons can carry text a Stage wrote, such as a failure summary. */
const MAX_REASON = 300;

/** The one label that shows a Job's status on its issue. */
export function statusLabel(status: JobStatus): string {
  return `factory:${status}`;
}

/** Every status label, so a stale one can be found and taken off. */
export const STATUS_LABELS = new Set<string>(JOB_STATUSES.map(statusLabel));

/** The hidden marker that finds a Job's status comment again, even if the Mirror's own record of it is lost. */
export function statusMarker(job_id: string): string {
  return `<!-- factory:status job=${job_id} -->`;
}

/** The status comment, edited in place on the issue for the whole Job. */
export function renderStatusComment(job: JobState, pr: { number: number } | null): string {
  const reason = job.reason ? ` (${cleanAgentText(job.reason, MAX_REASON)})` : "";
  return [
    FACTORY_MARKER,
    statusMarker(job.job_id),
    `**Factory status** · Job \`${job.job_id}\``,
    "",
    `- **Stage:** ${job.stage ? `\`${job.stage}\`` : "none yet"}`,
    `- **Status:** ${job.status}${reason}`,
    `- **Estimated cost so far:** $${job.cost_usd.toFixed(2)}`,
    `- **PR:** ${pr ? `#${pr.number}` : "none yet"}`,
    "",
  ].join("\n");
}

/** The one line the Factory posts on a PR it opened. */
export function renderPrLink(job: JobState): string {
  return `${FACTORY_MARKER} Opened by the Factory for #${job.issue} (Job \`${job.job_id}\`); its status is kept on the issue.`;
}
