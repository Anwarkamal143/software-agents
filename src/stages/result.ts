import { Ajv, type ErrorObject } from "ajv";

/** A Stage's claim. It decides where the Pipeline goes next and is never proof (ADR 0003). */
export type Verdict = "pass" | "fail" | "needs-human";

export interface Finding {
  severity: "error" | "warning" | "info";
  file?: string;
  message: string;
  /** Identifies the underlying problem, so the same failure twice stops Bouncing early. */
  root_cause: string;
}

export interface StageResult {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  /** Present when the Verdict is needs-human. */
  question?: { text: string; options: string[] };
  /** Paths, relative to the Working copy, of files the Stage wants kept. */
  artifacts: string[];
}

/**
 * The JSON Schema a Stage result must match. The Agent adapter hands it to the
 * session as its structured output format.
 */
export const STAGE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "artifacts"],
  properties: {
    verdict: { enum: ["pass", "fail", "needs-human"] },
    summary: { type: "string", maxLength: 4000 },
    findings: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "message", "root_cause"],
        properties: {
          severity: { enum: ["error", "warning", "info"] },
          file: { type: "string" },
          message: { type: "string", maxLength: 2000 },
          root_cause: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
    question: {
      type: "object",
      additionalProperties: false,
      required: ["text", "options"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 2000 },
        options: { type: "array", minItems: 2, maxItems: 3, items: { type: "string", minLength: 1, maxLength: 500 } },
      },
    },
    artifacts: { type: "array", items: { type: "string" } },
  },
} as const;

const validate = new Ajv({ allErrors: true }).compile<StageResult>(STAGE_RESULT_SCHEMA);

function describe(e: ErrorObject): string {
  const where = e.instancePath ? e.instancePath.slice(1).replaceAll("/", ".") : "result";
  if (e.keyword === "additionalProperties") {
    return `${where} has an unexpected field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
  }
  if (e.keyword === "enum") return `${where} must be one of ${(e.params as { allowedValues: string[] }).allowedValues.join(", ")}`;
  return `${where} ${e.message}`;
}

/** Checks raw Stage output against the schema. Anything that fails is not a Verdict. */
export function parseStageResult(raw: unknown): { ok: true; result: StageResult } | { ok: false; errors: string[] } {
  if (!validate(raw)) return { ok: false, errors: (validate.errors ?? []).map(describe) };
  if (raw.verdict === "needs-human" && !raw.question) {
    return { ok: false, errors: ["a needs-human Verdict must come with a question"] };
  }
  return { ok: true, result: raw };
}
