import { SandboxUnavailable, type Sandbox } from "../../src/stages/check-runner.js";

/** A Sandbox that can't start here, as on a Linux host without bubblewrap. */
export const unavailableSandbox = (why = "bubblewrap is not installed"): Sandbox => ({
  ready: () => Promise.reject(new SandboxUnavailable(why)),
  wrap: () => Promise.reject(new Error("an unavailable Sandbox never wraps")),
  close: async () => {},
});

/** A Sandbox whose availability you switch, as when bubblewrap is installed or removed while the Factory is off. */
export function switchableSandbox(available = false, why = "bubblewrap is not installed") {
  const sandbox = {
    available,
    readyCalls: 0,
    async ready() {
      sandbox.readyCalls++;
      if (!sandbox.available) throw new SandboxUnavailable(why);
    },
    wrap: () => Promise.reject(new Error("this fake Sandbox never wraps: use it for the self-check only")),
    close: async () => {},
  } satisfies Sandbox & { available: boolean; readyCalls: number };
  return sandbox;
}
