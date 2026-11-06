import { describe, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigHolder } from "../src/config/holder.js";
import { fixture } from "./helpers/config.js";
import { tmpHome } from "./helpers/tmp.js";

describe("ConfigHolder", () => {
  test("an edit that passes the check applies at the next refresh", () => {
    const file = join(tmpHome(), "factory.yaml");
    writeFileSync(file, fixture("minimal.yaml"));
    const holder = ConfigHolder.open(file);
    expect(holder.current.max_running).toBe(2);

    writeFileSync(file, fixture("minimal.yaml") + "max_running: 4\n");
    expect(holder.refresh()).toEqual({ changed: true, problems: [] });
    expect(holder.current.max_running).toBe(4);
  });

  test("a broken edit while running is rejected and the previous config stays in effect", () => {
    const file = join(tmpHome(), "factory.yaml");
    writeFileSync(file, fixture("minimal.yaml"));
    const holder = ConfigHolder.open(file);
    const before = { config: holder.current, hash: holder.hash };

    writeFileSync(file, fixture("refused/no-check-stage.yaml"));
    expect(holder.refresh()).toEqual({
      changed: false,
      problems: ['Pipeline "feature" has no Check Stage, so the Merge gate can never pass (no Evidence).'],
    });
    expect(holder.current).toBe(before.config);
    expect(holder.hash).toBe(before.hash);
  });

  test("refusing to start: opening a config that fails the check throws with every problem", () => {
    const file = join(tmpHome(), "factory.yaml");
    writeFileSync(file, fixture("refused/missing-stage.yaml"));
    expect(() => ConfigHolder.open(file)).toThrow(/Pipeline "feature" uses Stage "lint", which isn't defined\./);
  });

  test("an unchanged file is not reloaded", () => {
    const file = join(tmpHome(), "factory.yaml");
    writeFileSync(file, fixture("minimal.yaml"));
    const holder = ConfigHolder.open(file);
    expect(holder.refresh()).toEqual({ changed: false, problems: [] });
  });
});
