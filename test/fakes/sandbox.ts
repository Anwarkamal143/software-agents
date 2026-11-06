import { SandboxUnavailable, type Sandbox } from "../../src/stages/check-runner.js";

/** A Sandbox that can't start here, as on a Linux host without bubblewrap. */
export const unavailableSandbox = (why = "bubblewrap is not installed"): Sandbox => ({
  ready: () => Promise.reject(new SandboxUnavailable(why)),
  wrap: () => Promise.reject(new Error("an unavailable Sandbox never wraps")),
  close: async () => {},
});
