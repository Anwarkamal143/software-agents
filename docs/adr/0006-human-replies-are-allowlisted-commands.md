# Human replies are allowlisted Reply commands, never read by an agent

When a Job is waiting, the Factory accepts a human's reply only as a fixed **Reply command** (`/answer A`, `/answer other: <text>`, `/approve`, `/reject <reason>`, `/cancel`) from a GitHub login on the `humans` allowlist, or from the local `factory` CLI. The Orchestrator parses the command deterministically and records it as a `human-answered` event naming its channel; the first one recorded wins. We rejected letting any later comment count as the reply and having an agent work out what it means. That would be friendlier, but it puts issue-thread text, which anyone with access to the thread can write, in charge of deciding Job state. It also fails when the Factory posts from your own account, where author alone can't tell the Factory's comments from yours.

## Consequences

- Factory comments carry a hidden `<!-- factory -->` marker and are never parsed as replies.
- Commands from people not on the allowlist, and commands sent while the Job isn't waiting, are logged and otherwise ignored. Edits to a reply that has already been recorded change nothing.
- Free-text answers (`other:`) reach the resumed Stage only as human input inside the Stage brief or session turn, marked with who sent it, never as instructions to the Orchestrator.
- `/approve` overrides a Risk rule or the Autonomy level, but never the fixed core of the Merge gate.
- Replies arrive through the same Source poll that carries approvals, edits and closes (one conditional poll per Target repo every 60s), not a separate reply poll (amended by Source trigger mechanics, #17).
