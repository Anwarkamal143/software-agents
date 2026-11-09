import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Stage skills (ADR 0012): third-party skills pinned at an exact commit, shipped in
 * `stage-skills/` beside the Factory plugin. A Stage runs one as its main instructions, after its
 * Stage contract, with the supporting ones it lists after that. All are appended to the system
 * prompt, never called through the Skill tool, so every run has the same instructions.
 */
export const STAGE_SKILLS_DIR = fileURLToPath(new URL("../../stage-skills", import.meta.url));

export interface PinnedSkill {
  source: string;
  path: string;
  commit: string;
  license: string;
  hash: string;
}

export function stageSkillsLock(dir = STAGE_SKILLS_DIR): Record<string, PinnedSkill> {
  const file = join(dir, "skills-lock.json");
  if (!existsSync(file)) return {};
  return (JSON.parse(readFileSync(file, "utf8")) as { skills: Record<string, PinnedSkill> }).skills;
}

/** Every pinned Stage skill, by name. */
export function stageSkillNames(dir = STAGE_SKILLS_DIR): string[] {
  return Object.keys(stageSkillsLock(dir)).sort();
}

export function stageSkillDir(name: string, dir = STAGE_SKILLS_DIR): string {
  return join(dir, "skills", name);
}

/**
 * A Stage skill's text for the system prompt, after the Stage contract: its SKILL.md, or `entry`
 * inside it. Says where its other files are, since the skill names them by relative path. Throws
 * for a skill that isn't pinned, so a Stage never runs on instructions nobody reviewed.
 */
export function stageSkillText(name: string, role: "main" | "supporting", dir = STAGE_SKILLS_DIR, entry = "SKILL.md"): string {
  const pinned = stageSkillsLock(dir)[name];
  if (!pinned) throw new Error(`"${name}" isn't a pinned Stage skill (stage-skills/skills-lock.json).`);
  const problem = skillEntryProblem(name, entry, dir);
  if (problem) throw new Error(problem);
  const body = readFileSync(join(stageSkillDir(name, dir), entry), "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "");
  const from = entry === "SKILL.md" ? "" : `, starting from ${entry}`;
  return [
    role === "main" ? `# Stage skill: ${name}` : `# Supporting Stage skill: ${name}`,
    "",
    `From ${pinned.source} at ${pinned.commit.slice(0, 12)}${from}. Its other files are in ${stageSkillDir(name, dir)}. ${role === "main" ? "Follow it" : "Use it alongside your Stage skill"} where the Stage contract above allows; where they disagree, the Stage contract wins.`,
    "",
    body,
  ].join("\n");
}

/** Why `entry` can't be where a Stage starts in skill `name`, or null if it can. */
export function skillEntryProblem(name: string, entry: string, dir = STAGE_SKILLS_DIR): string | null {
  const root = stageSkillDir(name, dir);
  const file = resolve(root, entry);
  const rel = relative(root, file);
  if (!entry.endsWith(".md") || rel.startsWith("..") || isAbsolute(rel)) return `entry "${entry}" must be a Markdown file inside Stage skill "${name}".`;
  if (!existsSync(file)) return `Stage skill "${name}" has no ${entry}.`;
  return null;
}

/** Hash of a pinned skill's files: path and bytes, in path order. `scripts/pin-stage-skill.mjs` writes the same. */
export function skillHash(skillDir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const file of walk(skillDir).map((f) => relative(skillDir, f).split("\\").join("/")).sort()) {
    hash.update(`${file}\0`).update(readFileSync(join(skillDir, file))).update("\0");
  }
  return hash.digest("hex");
}
