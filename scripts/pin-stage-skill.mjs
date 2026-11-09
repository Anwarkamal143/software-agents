#!/usr/bin/env node
// Pins one third-party skill into stage-skills/ at an exact commit (ADR 0012).
//
//   node scripts/pin-stage-skill.mjs <owner/repo> <path/to/skill> [name] [--ref <commit>]
//   node scripts/pin-stage-skill.mjs --unpin <name>
//
// Copies the skill's Markdown files and the nearest LICENSE at that commit, and records
// source, commit and hash in stage-skills/skills-lock.json. Scripts and other files are left
// out: a Stage skill is instructions, never code to run. The copies are review material, so
// open a PR with them; nothing fetches a skill while a Job runs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "stage-skills");
const LOCK = join(ROOT, "skills-lock.json");

const args = process.argv.slice(2);
if (args[0] === "--unpin") {
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  if (!lock.skills[args[1]]) throw new Error(`"${args[1]}" isn't pinned.`);
  delete lock.skills[args[1]];
  rmSync(join(ROOT, "skills", args[1]), { recursive: true, force: true });
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  writeNotice(lock.skills);
  console.log(`Unpinned ${args[1]}. Check no Stage still names it: npx factory config check.`);
  process.exit(0);
}
const refAt = args.indexOf("--ref");
const ref = refAt === -1 ? null : args.splice(refAt, 2)[1];
const [repo, path, name = path?.split("/").pop()] = args;
if (!repo || !path || !/^[a-z0-9][a-z0-9-]*$/.test(name ?? "")) {
  console.error("usage: pin-stage-skill.mjs <owner/repo> <path/to/skill> [name] [--ref <commit>]");
  process.exit(2);
}

const gh = (endpoint) => JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 64 << 20 }));
const commit = ref ?? gh(`repos/${repo}/commits/HEAD`).sha;
const tree = gh(`repos/${repo}/git/trees/${commit}?recursive=1`).tree.filter((e) => e.type === "blob");
const blob = (sha) => Buffer.from(gh(`repos/${repo}/git/blobs/${sha}`).content, "base64");

const files = tree.filter((e) => e.path.startsWith(`${path}/`) && e.path.endsWith(".md"));
if (!files.some((e) => e.path === `${path}/SKILL.md`)) throw new Error(`${repo}@${commit} has no ${path}/SKILL.md`);

// The skill's own LICENSE, else the nearest one above it.
const dirs = path.split("/").map((_, i, parts) => parts.slice(0, parts.length - i).join("/")).concat("");
const license = dirs.map((d) => tree.find((e) => e.path === (d ? `${d}/LICENSE` : "LICENSE"))).find(Boolean);
if (!license) throw new Error(`${repo}@${commit} has no LICENSE for ${path}; only licensed skills are pinned (ADR 0012).`);

const out = join(ROOT, "skills", name);
rmSync(out, { recursive: true, force: true });
for (const e of files) {
  const to = join(out, relative(path, e.path));
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, blob(e.sha));
}
if (!files.some((e) => e.path === license.path)) writeFileSync(join(out, "LICENSE"), blob(license.sha));

const lock = JSON.parse(readFileSync(LOCK, "utf8"));
lock.skills[name] = { source: repo, path, commit, license: license.path, hash: skillHash(out) };
lock.skills = Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
writeNotice(lock.skills);
console.log(`Pinned ${name} from ${repo}@${commit.slice(0, 12)} (${files.length} files). Review the diff before you commit it.`);

/** Credits every pinned skill: where it came from, its license and its copyright line. */
function writeNotice(skills) {
  const lines = [
    "Stage skills",
    "",
    "Each skill under skills/ is a copy of a third-party skill, pinned at the commit below and",
    "unchanged except that only its Markdown files and LICENSE are kept. Each keeps its own",
    "LICENSE file. skills-lock.json records the exact source, path, commit and hash.",
    "",
  ];
  for (const [n, p] of Object.entries(skills)) {
    const text = readFileSync(join(ROOT, "skills", n, "LICENSE"), "utf8");
    const copyright = text.match(/^Copyright.*$/m)?.[0] ?? "(no copyright line)";
    lines.push(`${n}: ${p.source}/${p.path} at ${p.commit.slice(0, 12)}`, `  ${text.split("\n")[0].trim()}, ${copyright}`, "");
  }
  writeFileSync(join(ROOT, "NOTICE"), lines.join("\n"));
}

/** Must match `skillHash` in src/agents/stage-skills.ts, which checks it. */
function skillHash(dir) {
  const hash = createHash("sha256");
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const file of walk(dir).map((f) => relative(dir, f).split("\\").join("/")).sort()) {
    hash.update(`${file}\0`).update(readFileSync(join(dir, file))).update("\0");
  }
  return hash.digest("hex");
}
