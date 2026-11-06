import { describe, expect, test } from "vitest";
import { statSync } from "node:fs";
import { ArtifactStore } from "../src/store/artifact-store.js";
import { tmpHome } from "./helpers/tmp.js";

describe("ArtifactStore", () => {
  test("stores bytes under their sha256 and gives them back by hash", () => {
    const store = new ArtifactStore(tmpHome());
    const ref = store.put("hello\n");

    expect(ref).toEqual({ sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03", size: 6 });
    expect(store.get(ref.sha256).toString()).toBe("hello\n");
  });

  test("artifact files are readable only by the owner", () => {
    const store = new ArtifactStore(tmpHome());
    const ref = store.put(Buffer.from([1, 2, 3]));
    expect(statSync(store.path(ref.sha256)).mode & 0o777).toBe(0o600);
  });

  test("putting the same bytes twice keeps one file", () => {
    const store = new ArtifactStore(tmpHome());
    expect(store.put("same")).toEqual(store.put("same"));
  });

  test("a hash that isn't a sha256 is refused rather than read from disk", () => {
    const store = new ArtifactStore(tmpHome());
    expect(() => store.get("../../etc/passwd")).toThrow(/not a sha256/);
  });
});
