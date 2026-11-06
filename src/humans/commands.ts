/**
 * Reply commands (ADR 0006): the only form a human's reply is read back in. Parsing is
 * deterministic; free text is carried as data and never interpreted.
 */

/** Hidden in every comment the Factory posts. A comment carrying it is never parsed as a reply. */
export const FACTORY_MARKER = "<!-- factory -->";

/** A question's options are lettered in this order. */
export const OPTION_LETTERS = ["A", "B", "C"] as const;
export type OptionLetter = (typeof OPTION_LETTERS)[number];

export type ReplyCommand =
  | { command: "answer"; option: OptionLetter }
  | { command: "answer"; option: "other"; text: string }
  | { command: "approve" }
  | { command: "reject"; text: string }
  | { command: "cancel" };

export type ParsedReply =
  | { kind: "command"; command: ReplyCommand }
  /** Looks like a Reply command but isn't one: logged, never guessed at. */
  | { kind: "malformed"; why: string }
  /** The Factory's own comment. */
  | { kind: "factory" }
  /** Ordinary discussion. */
  | { kind: "none" };

const NAMES = ["answer", "approve", "reject", "cancel"] as const;
const NEEDS_OPTION = "/answer needs an option: A, B, C or other: <text>";

/**
 * Reads a comment as a Reply command. The command must open the comment; `/reject` and
 * `/answer other:` take the rest of the comment as their text, the others take nothing.
 */
export function parseReplyCommand(comment: string): ParsedReply {
  if (comment.includes(FACTORY_MARKER)) return { kind: "factory" };
  const text = comment.trim();
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (!match) return { kind: "none" };
  const [, word, rest] = match as unknown as [string, string, string];
  if (!(NAMES as readonly string[]).includes(word)) {
    return NAMES.some((n) => word.toLowerCase().startsWith(n))
      ? { kind: "malformed", why: "Reply commands are lowercase: /answer, /approve, /reject or /cancel" }
      : { kind: "none" };
  }
  const command = word as (typeof NAMES)[number];
  const ok = (c: ReplyCommand): ParsedReply => ({ kind: "command", command: c });
  const malformed = (why: string): ParsedReply => ({ kind: "malformed", why });

  switch (command) {
    case "approve":
    case "cancel":
      return rest ? malformed(`/${command} takes nothing after it`) : ok({ command });
    case "reject":
      return rest ? ok({ command, text: rest }) : malformed("/reject needs a reason");
    case "answer": {
      if (rest.startsWith("other:")) {
        const other = rest.slice("other:".length).trim();
        return other ? ok({ command, option: "other", text: other }) : malformed("/answer other: needs some text");
      }
      const letter = OPTION_LETTERS.find((l) => l === rest.toUpperCase());
      return letter ? ok({ command, option: letter }) : malformed(NEEDS_OPTION);
    }
  }
}
