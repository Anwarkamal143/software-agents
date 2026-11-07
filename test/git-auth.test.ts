import { describe, expect, test } from "vitest";
import { remoteAuthEnv } from "../src/repos/git.js";

describe("remoteAuthEnv", () => {
  test("an https remote gets the token as a Basic auth header, scoped to that remote, through env config", () => {
    expect(remoteAuthEnv("https://github.com/acme/web-app.git", "ghs_abc")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/acme/web-app.git.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hzX2FiYw==",
    });
  });

  test("a remote that isn't https gets nothing", () => {
    expect(remoteAuthEnv("/tmp/remote.git", "ghs_abc")).toEqual({});
    expect(remoteAuthEnv("file:///tmp/remote.git", "ghs_abc")).toEqual({});
  });
});
