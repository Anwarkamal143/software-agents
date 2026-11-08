import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunRequest } from "../src/agents/adapter.js";
import { sessionOptions } from "../src/agents/claude.js";
import { DEFAULT_STAGE_SKILLS, FACTORY_PLUGIN_DIR, pluginSkills, stageInstructions } from "../src/agents/plugin.js";
import { skillHash, stageSkillText, STAGE_SKILLS_DIR, stageSkillDir, stageSkillNames, stageSkillsLock } from "../src/agents/stage-skills.js";
import { STARTER_STAGES } from "../src/onboarding/config-edit.js";
import { STAGE_RESULT_SCHEMA } from "../src/stages/result.js";

const request = (instructions: string, tools: "read-only" | "write-branch" = "read-only", skills: { skill?: string; supporting?: string[] } = {}): AgentRunRequest => ({
  job_id: "job-1",
  stage_run_id: "run-1",
  brief: { stage: "review", instructions, tools, ...skills } as AgentRunRequest["brief"],
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

  test("a Stage with no Stage skills gets its Stage contract as system prompt and no Skill listing", () => {
    const options = sessionOptions(request("factory:review"), ctx);
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: stageInstructions("factory:review") });
    expect(options.skills).toEqual([]);
    expect(options.plugins).toEqual([{ type: "local", path: FACTORY_PLUGIN_DIR }]);
    expect(options.managedSettings).toEqual({ disableAllHooks: true });
  });

  test("the Stage contract comes first, then the main Stage skill, then the supporting ones, with no Skill listing (ADR 0012)", () => {
    const options = sessionOptions(request("factory:review", "read-only", { skill: "super-review", supporting: ["ponytail-review", "blast-radius"] }), ctx);
    const append = (options.systemPrompt as { append: string }).append;
    const at = (s: string) => append.indexOf(s);
    expect(append.startsWith(stageInstructions("factory:review"))).toBe(true);
    expect(at("# Stage skill: super-review")).toBeGreaterThan(stageInstructions("factory:review").length);
    expect(at("# Supporting Stage skill: ponytail-review")).toBeGreaterThan(at("# Stage skill: super-review"));
    expect(at("# Supporting Stage skill: blast-radius")).toBeGreaterThan(at("# Supporting Stage skill: ponytail-review"));
    expect(append.match(/the Stage contract wins/g)).toHaveLength(3);
    expect(append).not.toMatch(/^name: super-review$/m);
    expect(options.skills).toEqual([]);
    expect(options.allowedTools).not.toContain("Skill");
  });

  test("a Stage skill that isn't pinned is refused", () => {
    expect(() => stageSkillText("unpinned-skill", "main")).toThrow(/isn't a pinned Stage skill/);
  });

  test("a main Stage skill can start from a Markdown file inside it, never outside", () => {
    const text = stageSkillText("triage", "main", STAGE_SKILLS_DIR, "AGENT-BRIEF.md");
    expect(text).toMatch(/starting from AGENT-BRIEF\.md/);
    expect(text).toContain("# Writing Agent Briefs");
    expect(() => stageSkillText("triage", "main", STAGE_SKILLS_DIR, "../super-build/SKILL.md")).toThrow(/inside Stage skill "triage"/);
    expect(() => stageSkillText("triage", "main", STAGE_SKILLS_DIR, "LICENSE")).toThrow(/Markdown file/);
    expect(() => stageSkillText("triage", "main", STAGE_SKILLS_DIR, "NOPE.md")).toThrow(/has no NOPE\.md/);
  });

  test("every starter Stage with a Stage skill has a contract that wins over it and rules out control steps (ADR 0012)", () => {
    const withSkills = Object.entries(STARTER_STAGES).filter(([, s]) => s.kind === "agent" && s.skill);
    expect(withSkills.map(([id]) => id)).toEqual(expect.arrayContaining(["triage", "build"]));
    for (const [id, stage] of withSkills) {
      if (stage.kind !== "agent") continue;
      const contract = stageInstructions(stage.instructions);
      expect(contract, id).toMatch(/Where a Stage skill disagrees with this contract, this contract wins\./);
      for (const step of ["pushing", "merging pull requests", "calling GitHub", "starting subagents", "stopping to ask a human mid-run"]) expect(contract, `${id}: ${step}`).toContain(step);
      expect(() => stageSkillText(stage.skill!, "main", STAGE_SKILLS_DIR, stage.entry)).not.toThrow();
      for (const s of stage.supporting ?? []) expect(() => stageSkillText(s, "supporting"), `${id}: ${s}`).not.toThrow();
    }
  });
});

describe("the Stage skills (ADR 0012)", () => {
  test("are instructions only: no plugin, hooks, MCP servers, agents or scripts", () => {
    expect(readdirSync(STAGE_SKILLS_DIR).sort()).toEqual(["NOTICE", "skills", "skills-lock.json"]);
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [e.name]));
    for (const name of stageSkillNames()) {
      for (const file of files(stageSkillDir(name))) expect(file, `${name}/${file}`).toMatch(/\.md$|^LICENSE$/);
    }
  });

  test("every pinned skill matches its lock entry, so nobody edits one by hand", () => {
    const lock = stageSkillsLock();
    expect(readdirSync(join(STAGE_SKILLS_DIR, "skills")).sort()).toEqual(stageSkillNames());
    for (const [name, pinned] of Object.entries(lock)) {
      expect(pinned.commit, name).toMatch(/^[0-9a-f]{40}$/);
      expect(skillHash(stageSkillDir(name)), name).toBe(pinned.hash);
      expect(existsSync(join(stageSkillDir(name), "LICENSE")), name).toBe(true);
      expect(readFileSync(join(stageSkillDir(name), "SKILL.md"), "utf8"), name).toMatch(new RegExp(`^---\\n[\\s\\S]*?^name: ${name}$`, "m"));
    }
  });

  test("every pinned skill is credited in the NOTICE", () => {
    const notice = readFileSync(join(STAGE_SKILLS_DIR, "NOTICE"), "utf8");
    for (const [name, pinned] of Object.entries(stageSkillsLock())) {
      expect(notice, name).toContain(`${name}: ${pinned.source}`);
    }
  });
});
