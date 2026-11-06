import { describe, expect, test } from "vitest";
import { FACTORY_MARKER, parseReplyCommand } from "../src/humans/commands.js";

describe("parseReplyCommand", () => {
  test.each([
    ["/answer A", { command: "answer", option: "A" }],
    ["/answer c", { command: "answer", option: "C" }],
    ["  /answer B  \n", { command: "answer", option: "B" }],
    ["/answer other: use GraphQL", { command: "answer", option: "other", text: "use GraphQL" }],
    ["/answer other:  two\nlines ", { command: "answer", option: "other", text: "two\nlines" }],
    ["/approve", { command: "approve" }],
    ["/approve\n", { command: "approve" }],
    ["/reject the tests don't cover /health", { command: "reject", text: "the tests don't cover /health" }],
    ["/reject\nmissing tests", { command: "reject", text: "missing tests" }],
    ["/cancel", { command: "cancel" }],
  ])("%j is a Reply command", (text, command) => {
    expect(parseReplyCommand(text)).toEqual({ kind: "command", command });
  });

  test.each([
    ["/answer", "/answer needs an option: A, B, C or other: <text>"],
    ["/answer D", "/answer needs an option: A, B, C or other: <text>"],
    ["/answer AB", "/answer needs an option: A, B, C or other: <text>"],
    ["/answer A please", "/answer needs an option: A, B, C or other: <text>"],
    ["/answer other:", "/answer other: needs some text"],
    ["/answer other:   ", "/answer other: needs some text"],
    ["/approve but only after lunch", "/approve takes nothing after it"],
    ["/reject", "/reject needs a reason"],
    ["/cancel now", "/cancel takes nothing after it"],
    ["/APPROVE", "Reply commands are lowercase: /answer, /approve, /reject or /cancel"],
    ["/approved", "Reply commands are lowercase: /answer, /approve, /reject or /cancel"],
  ])("%j is a malformed Reply command", (text, why) => {
    expect(parseReplyCommand(text)).toEqual({ kind: "malformed", why });
  });

  test.each([
    "Looks good to me!",
    "",
    "I'd /approve this if the tests passed",
    "> /approve\nquoted, not sent",
    "/lgtm",
  ])("%j is not a Reply command", (text) => {
    expect(parseReplyCommand(text)).toEqual({ kind: "none" });
  });

  test("a Factory-marked comment is never parsed, wherever the marker sits", () => {
    expect(parseReplyCommand(`${FACTORY_MARKER}\n/approve`)).toEqual({ kind: "factory" });
    expect(parseReplyCommand(`/approve\n${FACTORY_MARKER}`)).toEqual({ kind: "factory" });
  });
});
