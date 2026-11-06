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
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  notify({ title, body }: { title: string; body: string }): Promise<void> {
    const [cmd, args] =
      this.platform === "darwin"
        ? ["osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body.slice(0, 200)]]
        : ["notify-send", ["--", title, body.slice(0, 200)]];
    return new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, () => resolve()));
  }
}
