import { execFile } from "node:child_process";

/** A local notification that a Job needs a human. */
export interface Notifier {
  notify(note: { title: string; body: string }): Promise<void>;
}

/**
 * Notifications from the OS: Notification Center on macOS, `notify-send` on Linux.
 * Text goes in as arguments, never into a script, so it can't run anything.
 */
export class OsNotifier implements Notifier {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    /** Runs a command with arguments and settles when it exits, never rejecting. */
    private readonly run: (cmd: string, args: string[]) => Promise<void> = (cmd, args) =>
      new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, () => resolve())),
  ) {}

  notify({ title, body }: { title: string; body: string }): Promise<void> {
    const text = body.slice(0, MAX_BODY);
    return this.platform === "darwin"
      ? this.run("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, text])
      : this.run("notify-send", ["--", title, text]);
  }
}

const MAX_BODY = 200;
