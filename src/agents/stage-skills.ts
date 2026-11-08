import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Stage skills (ADR 0012): third-party skills pinned at an exact commit, shipped as their
 * own plugin beside the Factory plugin. A Stage runs one as its main instructions, after its
 * Stage contract, and may call the supporting ones it lists.
 */
export const STAGE_SKILLS_DIR = fileURLToPath(new URL("../../stage-skills", import.meta.url));

/** The plugin's name, so a skill is `stage-skills:<name>` in a session's Skill listing. */
export const STAGE_SKILLS_PLUGIN = "stage-skills";

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
 * A main Stage skill's text for the system prompt, after the Stage contract. Says where its
 * other files are, since the skill names them by relative path. Throws for a skill that isn't
 * pinned, so a Stage never runs on instructions nobody reviewed.
 */
export function mainSkillText(name: string, dir = STAGE_SKILLS_DIR): string {
  const pinned = stageSkillsLock(dir)[name];
  const file = join(stageSkillDir(name, dir), "SKILL.md");
  if (!pinned || !existsSync(file)) throw new Error(`"${name}" isn't a pinned Stage skill (stage-skills/skills-lock.json).`);
  const body = readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "");
  return [
    `# Stage skill: ${name}`,
    "",
    `From ${pinned.source} at ${pinned.commit.slice(0, 12)}. Its other files are in ${stageSkillDir(name, dir)}. Follow it where the Stage contract above allows; where they disagree, the Stage contract wins.`,
    "",
    body,
  ].join("\n");
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
