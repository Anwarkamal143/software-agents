import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { GuardDenial, GuardName } from "./adapter.js";

/** Where one Stage run may work, and what it must never reach. */
export interface GuardContext {
  /** The Attempt's Working copy: the only place file tools may touch. */
  workingCopy: string;
  factoryHome: string;
  /** Your home, whose credential folders no session reads. */
  userHome: string;
}

/**
 * The Guards (ADR 0007): a block on one agent action, checked before every tool call. A Guard
 * stops a tool call; it never reads intent. The Sandbox confines Bash as well; Guards are the
 * second wall, and every denial is recorded. Returns null when the call may go ahead.
 */
export function checkToolCall(tool: string, input: Record<string, unknown>, ctx: GuardContext): GuardDenial | null {
  const deny = (guard: GuardName, why: string): GuardDenial => ({ guard, tool, why });
  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const found = checkCommand(command, ctx);
    return found && deny(found.guard, found.why);
  }
  for (const [key, value] of Object.entries(input)) {
    if (!PATH_KEYS.has(key) || typeof value !== "string" || !value) continue;
    // Glob and Grep patterns name files too: a pattern that would match .env files is a read of them.
    if (SECRET_IN_PATH.test(value)) return deny("secret-file", `${value} is a secret file`);
    if (key === "pattern" || key === "glob") continue;
    const target = resolveIn(value, ctx);
    if (!inside(target, ctx.workingCopy)) return deny("outside-working-copy", `${value} is outside the Working copy`);
  }
  return null;
}

/** Tool input fields that hold a path or a file pattern. */
const PATH_KEYS = new Set(["file_path", "notebook_path", "path", "pattern", "glob"]);

/** A `.env` file, or a pattern that matches one: `.env`, `.env.local`, `**\/.env*`. */
const SECRET_IN_PATH = /(^|[\\/])\.env(\*|\.[^\\/]*)?$/;
/** The same, as a word in a shell command. */
const SECRET_IN_COMMAND = /(^|[\s/'"=:<>(])\.env(\.[\w.-]+)?(?=$|[\s'";|&)<>])/;
/** Home-directory credential folders and files. */
const CREDENTIALS = String.raw`\.(ssh|aws|gnupg|docker|kube|netrc|npmrc|git-credentials|claude|config/gh)\b`;
const HOME_CREDENTIALS = new RegExp(String.raw`(~|\$HOME|\$\{HOME\})/${CREDENTIALS}`);
/** Commands that print a stored credential. */
const CREDENTIAL_COMMANDS = /\bgh\s+auth\s+token\b|\bsecurity\s+find-(generic|internet)-password\b|\bsecret-tool\s+lookup\b|\bgit\s+credential\b/;

/** Each check is one shell segment (between `;`, `&&`, `||`, `|` and newlines) or the whole line. */
const DESTRUCTIVE: { test: (segment: string, line: string) => boolean; why: string }[] = [
  // Agents never push (ADR 0007): the Orchestrator pushes after Pre-push checks.
  { test: (s) => /^git\b.*\spush\b/.test(s), why: "agents never push; the Orchestrator pushes the Job branch itself" },
  { test: (s) => /^git\b.*\sremote\s+(add|set-url|rename)\b/.test(s), why: "agents don't change the Working copy's remotes" },
  { test: (s) => /^(sudo|doas|su)\b/.test(s), why: "no session runs anything as another user" },
  { test: (s) => /^rm\b/.test(s) && dangerousRmTarget(s), why: "rm -r outside the Working copy's own folders" },
  { test: (_s, line) => /\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(line), why: "piping a download into a shell" },
  { test: (s) => /^dd\b.*\bof=\/dev\//.test(s) || /^mkfs(\.\w+)?\b/.test(s), why: "writing to a disk device" },
  { test: (s) => /^chmod\b.*\s-R\b.*\s\/\s*$/.test(s), why: "changing permissions on the whole disk" },
  { test: (_s, line) => /:\(\)\s*\{.*:\|:.*\}/.test(line), why: "a fork bomb" },
];

function checkCommand(command: string, ctx: GuardContext): { guard: GuardName; why: string } | null {
  if (SECRET_IN_COMMAND.test(command)) return { guard: "secret-file", why: "the command reads a .env file" };
  if (HOME_CREDENTIALS.test(command) || command.includes(ctx.factoryHome) || (ctx.userHome && new RegExp(`${escape(ctx.userHome)}/${CREDENTIALS}`).test(command))) {
    return { guard: "secret-file", why: "the command reaches a credential folder or the Factory home" };
  }
  if (CREDENTIAL_COMMANDS.test(command)) return { guard: "secret-file", why: "the command prints a stored credential" };
  const segments = command
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim().replace(/^(\w+=\S*\s+)+/, ""))
    .filter(Boolean);
  for (const segment of segments) {
    for (const rule of DESTRUCTIVE) if (rule.test(segment, command)) return { guard: "destructive-command", why: rule.why };
  }
  return null;
}

/** `rm` with `-r` whose target is `/`, your home, a parent folder or any absolute path. */
function dangerousRmTarget(segment: string): boolean {
  const words = segment.split(/\s+/).slice(1);
  const recursive = words.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || w === "--recursive");
  if (!recursive) return false;
  return words
    .filter((w) => !w.startsWith("-"))
    .map((w) => w.replace(/^['"]|['"]$/g, ""))
    .some((t) => t.startsWith("/") || t.startsWith("~") || t.startsWith("$HOME") || t.startsWith("${HOME}") || t === ".." || t.startsWith("../") || t === "*" || t === ".");
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where `path` really lands: relative paths start in the Working copy, `~` is your home, and symlinks are followed. */
function resolveIn(path: string, ctx: GuardContext): string {
  const expanded = path === "~" || path.startsWith("~/") ? join(ctx.userHome, path.slice(1)) : path;
  const absolute = normalize(isAbsolute(expanded) ? expanded : resolve(ctx.workingCopy, expanded));
  return realOf(absolute);
}

/** The real path of the deepest part of `path` that exists, with the rest added on. */
function realOf(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

function inside(path: string, dir: string): boolean {
  const rel = relative(realOf(dir), path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
