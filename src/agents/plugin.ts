import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Factory plugin shipped with the package: `plugin/` beside `src/` and `dist/`. */
export const FACTORY_PLUGIN_DIR = fileURLToPath(new URL("../../plugin", import.meta.url));

/** The Agent Stages of the default Pipeline, by skill name: `factory:<name>` in `factory.yaml`. */
export const DEFAULT_STAGE_SKILLS = ["triage", "build", "review", "security-review"] as const;

/** Every Stage's instructions the plugin has: one `skills/<name>/SKILL.md` each. */
export function pluginSkills(pluginDir = FACTORY_PLUGIN_DIR): string[] {
  const dir = join(pluginDir, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

/** The skill name in a `factory:<name>` reference, or null if it isn't one. */
export function skillName(ref: string): string | null {
  return /^factory:([a-z0-9][a-z0-9-]*)$/.exec(ref)?.[1] ?? null;
}

/**
 * The instructions a `factory:<name>` reference names: the skill's text without its frontmatter.
 * Throws for anything else, so a Stage never runs on instructions the plugin doesn't have.
 */
export function stageInstructions(ref: string, pluginDir = FACTORY_PLUGIN_DIR): string {
  const name = skillName(ref);
  if (!name) throw new Error(`Stage instructions "${ref}" must name a Factory plugin skill, as factory:<name>.`);
  const file = join(pluginDir, "skills", name, "SKILL.md");
  if (!existsSync(file)) throw new Error(`The Factory plugin has no instructions for ${ref} (no ${file}).`);
  return readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "");
}
