import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunRequest } from "../src/agents/adapter.js";
import { sessionOptions } from "../src/agents/claude.js";
import { DEFAULT_STAGE_SKILLS, FACTORY_PLUGIN_DIR, pluginSkills, stageInstructions } from "../src/agents/plugin.js";
import { STAGE_RESULT_SCHEMA } from "../src/stages/result.js";

const request = (instructions: string, tools: "read-only" | "write-branch" = "read-only"): AgentRunRequest => ({
  job_id: "job-1",
  stage_run_id: "run-1",
  brief: { stage: "review", instructions, tools } as AgentRunRequest["brief"],
  renderedBrief: "brief",
  model: "claude-sonnet-5-5",
  workingCopy: { dir: "/w/repo", env: { HOME: "/w/home", XDG_CONFIG_HOME: "/w/home/.config", XDG_CACHE_HOME: "/w/cache", npm_config_cache: "/w/cache/npm", TMPDIR: "/w/tmp" }, objects: "/factory/repos/acme/app.git/objects" },
  network: [],
  budget: { usd: 5, turns: 100, minutes: 30 },
  resultSchema: STAGE_RESULT_SCHEMA,
  events: { activity() {}, session() {}, guardBlocked() {}, rateLimit() {} },
});
const ctx = { home: "/factory", userHome: "/Users/me", pluginDir: FACTORY_PLUGIN_DIR, env: {} };

describe("the Factory plugin", () => {
  test("carries no hooks, MCP servers or agents: behaviour only (ADR 0001, ADR 0007)", () => {
    const manifest = JSON.parse(readFileSync(join(FACTORY_PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")) as Record<string, unknown>;
    for (const key of ["hooks", "mcpServers", "agents", "commands", "lspServers"]) expect(manifest).not.toHaveProperty(key);
    for (const path of ["hooks", ".mcp.json", "agents", "commands", "bin"]) expect(existsSync(join(FACTORY_PLUGIN_DIR, path)), path).toBe(false);
    expect(readdirSync(FACTORY_PLUGIN_DIR).sort()).toEqual([".claude-plugin", "skills"]);
  });

  test("has instructions for every default Agent Stage", () => {
    expect(DEFAULT_STAGE_SKILLS).toEqual(["triage", "build", "review", "security-review"]);
    expect(pluginSkills()).toEqual(expect.arrayContaining([...DEFAULT_STAGE_SKILLS]));
  });

  test("every Stage's instructions treat issue text as data and end in a Stage result", () => {
    for (const skill of pluginSkills()) {
      const text = stageInstructions(`factory:${skill}`);
      expect(text, skill).toMatch(/untrusted/i);
      expect(text, skill).toMatch(/Stage result/);
      expect(text, skill).not.toMatch(/^---/);
    }
  });

  test("build commits locally and never pushes; the read-only Stages never change the Working copy", () => {
    expect(stageInstructions("factory:build")).toMatch(/never push/i);
    for (const skill of ["triage", "review", "security-review"]) expect(stageInstructions(`factory:${skill}`), skill).toMatch(/read-only/i);
  });

  test("a reference to a skill the plugin doesn't have is refused", () => {
    expect(() => stageInstructions("factory:ui-review")).toThrow(/factory:ui-review/);
    expect(() => stageInstructions("build")).toThrow(/factory:<name>/);
  });

  test("the session gets its Stage's instructions as system prompt and no Skill listing", () => {
    const options = sessionOptions(request("factory:review"), ctx);
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: stageInstructions("factory:review") });
    expect(options.skills).toEqual([]);
    expect(options.plugins).toEqual([{ type: "local", path: FACTORY_PLUGIN_DIR }]);
    expect(options.managedSettings).toEqual({ disableAllHooks: true });
  });
});
