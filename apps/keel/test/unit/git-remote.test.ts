import { describe, expect, it } from "vitest";
import { GIT_HTTP_DEADLINE_MS, gitRemote } from "../../src/adapters/driven/gitcore/remote.ts";

describe("Keel's git remotes", () => {
  it("[git.remote-deadline] every remote Keel calls carries the git deadline, with or without a token", () => {
    expect(gitRemote("https://git.invalid/a", "t")).toEqual({
      url: "https://git.invalid/a",
      token: "t",
      deadlineMs: GIT_HTTP_DEADLINE_MS,
    });
    expect(gitRemote("https://git.invalid/b")).toEqual({
      url: "https://git.invalid/b",
      deadlineMs: GIT_HTTP_DEADLINE_MS,
    });
  });
});
