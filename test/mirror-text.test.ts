import { describe, expect, test } from "vitest";
import { FACTORY_MARKER, parseReplyCommand } from "../src/humans/commands.js";
import type { FactoryEvent } from "../src/events/envelope.js";
import { renderNotWaiting } from "../src/humans/request.js";
import type { JobState } from "../src/jobs/projection.js";
import { cleanAgentText } from "../src/mirror/clean.js";
import { renderPrLink, renderStatusComment, statusLabel } from "../src/mirror/status.js";

const job = (over: Partial<JobState> = {}): JobState => ({
  job_id: "01JOB",
  repo: "acme/web-app",
  issue: 7,
  status: "running",
  stage: "build",
  reason: null,
  resumed: false,
  attempt: 1,
  cost_usd: 1.234,
  last_seq: 9,
  updated_at: "2026-11-01T10:00:00.000Z",
  ...over,
});

/** What GitHub would treat as a mention: an @ followed straight away by a login. */
const MENTION = /@[A-Za-z0-9]/;
/** A Reply command as a person would type it. */
const COMMAND = /\/(answer|approve|reject|cancel)\b/i;

describe("cleanAgentText", () => {
  test("@mentions, Reply commands and Factory markers are all neutralised", () => {
    const text = cleanAgentText(`Ping @someone, then /approve ${FACTORY_MARKER} and @org/team`, 1000);

    expect(text).not.toMatch(MENTION);
    expect(text).not.toMatch(COMMAND);
    expect(text).not.toContain("<!--");
    // Still readable as what the agent wrote.
    expect(text.replaceAll("⁠", "")).toBe("Ping @someone, then /approve &lt;!-- factory --> and @org/team");
  });

  test("a mention can't escape by unbalancing the agent's own backticks", () => {
    expect(cleanAgentText("see `a @bob and `/cancel", 1000)).not.toMatch(MENTION);
    expect(cleanAgentText("see `a @bob and `/cancel", 1000)).not.toMatch(COMMAND);
  });

  test("text over the cap is cut, and the cut is marked", () => {
    const text = cleanAgentText("x".repeat(5000), 2000);
    expect(text).toHaveLength(2000);
    expect(text.endsWith("…")).toBe(true);
    expect(cleanAgentText("short", 2000)).toBe("short");
  });

  test("a cleaned command opening the text is not read as a Reply command", () => {
    expect(parseReplyCommand(cleanAgentText("/approve", 100))).toEqual({ kind: "none" });
  });
});

describe("renderStatusComment", () => {
  test("names the Stage, status, estimated cost so far and PR, under a marker that finds it again", () => {
    expect(renderStatusComment(job(), { number: 12 })).toBe(
      [
        FACTORY_MARKER,
        "<!-- factory:status job=01JOB -->",
        "**Factory status** · Job `01JOB`",
        "",
        "- **Stage:** `build`",
        "- **Status:** running",
        "- **Estimated cost so far:** $1.23",
        "- **PR:** #12",
        "",
      ].join("\n"),
    );
  });

  test("before any Stage or PR it says so, and a reason is cleaned like agent text", () => {
    const text = renderStatusComment(job({ stage: null, status: "failed", reason: "@bob broke it <!-- factory -->", cost_usd: 0 }), null);
    expect(text).toContain("- **Stage:** none yet");
    expect(text).toContain("- **Status:** failed (@\u2060bob broke it &lt;!-- factory -->)");
    expect(text).toContain("- **Estimated cost so far:** $0.00");
    expect(text).toContain("- **PR:** none yet");
    expect(text.split(FACTORY_MARKER)).toHaveLength(2);
  });

  test("is the Factory's own comment, never a reply", () => {
    expect(parseReplyCommand(renderStatusComment(job(), null))).toEqual({ kind: "factory" });
  });
});

describe("the other Factory posts", () => {
  test("one status label per Job status", () => {
    expect(statusLabel("waiting")).toBe("factory:waiting");
  });

  test("a PR gets one line linking it to its issue", () => {
    const text = renderPrLink(job());
    expect(text).toBe("<!-- factory --> Opened by the Factory for #7 (Job `01JOB`); its status is kept on the issue.");
    expect(text.split("\n")).toHaveLength(1);
  });

  test("a reply to a Job that isn't waiting is told so, in a Factory comment", () => {
    const ignored = { id: "01IGN", job_id: "01JOB", type: "reply-ignored", data: { why: "not-waiting" } } as unknown as FactoryEvent;
    const text = renderNotWaiting(ignored);
    expect(text).toBe(`${FACTORY_MARKER}\nThis Job isn't waiting for an answer, so this reply changes nothing. See \`factory status\` for Job \`01JOB\`.\n`);
    expect(parseReplyCommand(text)).toEqual({ kind: "factory" });
  });
});
