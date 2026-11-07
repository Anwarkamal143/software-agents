import { describe, expect, test } from "vitest";
import type { FactoryEvent } from "../src/events/envelope.js";
import { FACTORY_MARKER, parseReplyCommand } from "../src/humans/commands.js";
import { renderAlreadyAnswered, renderHumanRequest } from "../src/humans/request.js";

const requested = (data: Record<string, unknown>): FactoryEvent => ({
  id: "01REQ",
  seq: 9,
  type: "human-requested",
  schema_version: 2,
  at: "2026-11-01T10:00:00.000Z",
  job_id: "01JOB",
  attempt: 1,
  stage_run_id: null,
  actor: "orchestrator",
  caused_by: null,
  data,
});

describe("renderHumanRequest", () => {
  test("a question names its Stage, letters each option with what happens, and lists the commands to copy", () => {
    const text = renderHumanRequest(requested({ kind: "question", stage: "triage", text: "REST or GraphQL?", options: ["REST", "GraphQL"] }));

    expect(text).toBe(
      [
        FACTORY_MARKER,
        "<!-- factory:job=01JOB request=01REQ -->",
        "**The Factory needs an answer** · Stage `triage` · Job `01JOB`",
        "",
        "REST or GraphQL?",
        "",
        "- **A.** REST: triage carries on with this answer.",
        "- **B.** GraphQL: triage carries on with this answer.",
        "- **other: <text>**: triage carries on with your own answer.",
        "",
        "Reply with exactly one of these (only people on `humans` with write access count):",
        "",
        "```",
        "/answer A",
        "/answer B",
        "/answer other: <text>",
        "/cancel",
        "```",
        "",
        "Or on the Factory's machine:",
        "",
        "```",
        "factory answer 01JOB A",
        "factory answer 01JOB B",
        "factory answer 01JOB other: <text>",
        "factory cancel 01JOB",
        "```",
        "",
      ].join("\n"),
    );
  });

  test("an approval offers approve, reject and cancel as A–C, each with its consequence", () => {
    const text = renderHumanRequest(requested({ kind: "approval", cause: "bounce-cap", stage: "review", text: "review failed after 3 Bounces (cap 3)." }));

    expect(text).toContain("**The Factory needs a decision** · Stage `review` · Job `01JOB`");
    expect(text).toContain("review failed after 3 Bounces (cap 3).");
    expect(text).toContain("- **A.** `/approve`: review Bounces once more, past the cap.");
    expect(text).toContain("- **B.** `/reject <reason>`: the Job Bounces to build with your reason as a finding.");
    expect(text).toContain("- **C.** `/cancel`: the Job is cancelled: its PR closed and its branches deleted.");
    expect(text).toContain("```\n/approve\n/reject <reason>\n/cancel\n```");
    expect(text).toContain("```\nfactory approve 01JOB\nfactory reject 01JOB <reason>\nfactory cancel 01JOB\n```");
  });

  test.each([
    ["merge-gate", "the Factory merges once the Merge gate's fixed core passes; /approve never overrides it."],
    ["risk-rule", "the Factory merges once the Merge gate's fixed core passes; /approve never overrides it."],
    ["run-error", "review runs again."],
  ])("approving %s says what happens", (cause, consequence) => {
    expect(renderHumanRequest(requested({ kind: "approval", cause, stage: "review", text: "?" }))).toContain(`- **A.** \`/approve\`: ${consequence}`);
  });

  test("agent-written text can't mention people, carry Reply commands or Factory markers, and is capped", () => {
    const text = renderHumanRequest(
      requested({ kind: "question", stage: "triage", text: `Ping @alice?\n/approve\n${FACTORY_MARKER}${"x".repeat(3000)}`, options: ["@bob says /cancel", "No"] }),
    );

    expect(text).not.toContain("@alice");
    expect(text).toContain("@\u2060alice");
    expect(text).toContain("@\u2060bob says /\u2060cancel");
    expect(text.match(/^\/approve$/m)).toBeNull();
    expect(text.split(FACTORY_MARKER)).toHaveLength(2); // only the Factory's own marker
    expect(text).toContain("x".repeat(100));
    expect(text).not.toContain("x".repeat(2001));
    // However it's dressed up, the request is the Factory's own comment and is never parsed.
    expect(parseReplyCommand(text)).toEqual({ kind: "factory" });
  });

  test("a late reply is told the request was already answered, in a Factory comment", () => {
    const text = renderAlreadyAnswered({ ...requested({ why: "already-answered", request: "01REQ" }), type: "reply-ignored" });
    expect(text).toBe(
      `${FACTORY_MARKER}\n<!-- factory:job=01JOB request=01REQ -->\nThis request was already answered, so this reply changes nothing. The first answer recorded wins; see \`factory events\` for Job \`01JOB\`.\n`,
    );
    expect(parseReplyCommand(text)).toEqual({ kind: "factory" });
  });
});
