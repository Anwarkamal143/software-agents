/** Invisible, and breaks a mention or a command without changing how the text reads. */
const WORD_JOINER = "⁠";

/**
 * Agent-written text, made safe to post (ADR 0007): no @mention pings anyone, no Reply command
 * reads as one, no Factory marker survives, and it fits in `max` characters. Neutralising inserts
 * an invisible joiner rather than relying on Markdown, so unbalanced backticks can't undo it.
 */
export function cleanAgentText(text: string, max: number): string {
  const cleaned = text
    .replaceAll("<!--", "&lt;!--")
    .replace(/@(?=[A-Za-z0-9])/g, `@${WORD_JOINER}`)
    .replace(/\/(?=(?:answer|approve|reject|cancel)\b)/gi, `/${WORD_JOINER}`);
  if (cleaned.length <= max) return cleaned;
  // Never leave half a surrogate pair at the cut.
  let cut = cleaned.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}
