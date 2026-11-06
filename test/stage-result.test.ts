import { describe, expect, test } from "vitest";
import { parseStageResult } from "../src/stages/result.js";

const ok = { verdict: "pass", summary: "Looks good.", findings: [], artifacts: [] };

describe("parseStageResult", () => {
  test("accepts a well-formed result", () => {
    const finding = { severity: "error", file: "src/a.ts", message: "Null deref", root_cause: "null-deref:a.ts" };
    expect(parseStageResult({ ...ok, verdict: "fail", findings: [finding] })).toEqual({
      ok: true,
      result: { ...ok, verdict: "fail", findings: [finding] },
    });
  });

  test("a needs-human result carries a question with 2 or 3 options", () => {
    const question = { text: "REST or GraphQL?", options: ["REST", "GraphQL"] };
    expect(parseStageResult({ ...ok, verdict: "needs-human", question }).ok).toBe(true);
    expect(parseStageResult({ ...ok, verdict: "needs-human", question: { text: "?", options: ["only one"] } })).toEqual({
      ok: false,
      errors: ["question.options must NOT have fewer than 2 items"],
    });
    expect(parseStageResult({ ...ok, verdict: "needs-human" })).toEqual({
      ok: false,
      errors: ["a needs-human Verdict must come with a question"],
    });
  });

  test("a Verdict that isn't pass, fail or needs-human is not accepted", () => {
    const r = parseStageResult({ ...ok, verdict: "probably-fine" });
    expect(r).toEqual({ ok: false, errors: ["verdict must be one of pass, fail, needs-human"] });
  });

  test("findings need a root-cause key, and extra fields are refused", () => {
    const r = parseStageResult({ ...ok, verdict: "fail", findings: [{ severity: "error", message: "x" }], confidence: 0.99 });
    expect(r.ok ? [] : r.errors).toEqual([
      'result has an unexpected field "confidence"',
      "findings.0 must have required property 'root_cause'",
    ]);
  });

  test("something that isn't an object at all is not accepted", () => {
    expect(parseStageResult("PASS")).toEqual({ ok: false, errors: ["result must be object"] });
  });
});
