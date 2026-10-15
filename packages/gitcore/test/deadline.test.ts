import { describe, expect, it } from "vitest";
import { uploadPack } from "../src/fetch.ts";
import {
  BOX_COMPOSE_SCRIPT,
  BOX_LOW_SPEED_BYTES,
  BOX_LOW_SPEED_SECONDS,
} from "../src/mergebox-script.ts";
import { scriptSync } from "./git-harness.ts";
import { advertisement, type GitRemote, receivePack } from "../src/push.ts";

/** A remote whose server never answers: each request waits until its signal aborts it, or for ever. */
const silent = (deadlineMs?: number): GitRemote => ({
  url: "https://git.invalid/repo",
  ...(deadlineMs === undefined ? {} : { deadlineMs }),
  fetch: async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }),
});

const OID = "a".repeat(40);

describe("a git request's deadline", () => {
  it(
    "[git.deadline] each request to a remote that never answers is aborted at the remote's deadline with a TimeoutError",
    { timeout: 2_000 },
    async () => {
      const requests = [
        (remote: GitRemote) => advertisement(remote),
        (remote: GitRemote) => uploadPack(remote, [OID], []),
        (remote: GitRemote) =>
          receivePack(
            remote,
            [{ ref: "refs/heads/main", old: "0".repeat(40), new: OID }],
            new Uint8Array(),
          ),
      ];
      for (const request of requests)
        await expect(request(silent(20))).rejects.toMatchObject({ name: "TimeoutError" });
    },
  );

  it("[box.low-speed] the box's compose script runs git with a low-speed limit, so a stalled fetch or push is aborted rather than holding the box", () => {
    // The script's own preamble, before it touches git, then what git would read of it.
    const preamble = BOX_COMPOSE_SCRIPT.slice(0, BOX_COMPOSE_SCRIPT.indexOf("staging=$1"));
    const run = scriptSync(
      "sh",
      ["-c", `${preamble}echo "$GIT_HTTP_LOW_SPEED_LIMIT"; echo "$GIT_HTTP_LOW_SPEED_TIME"`],
      { PATH: process.env["PATH"] },
    );
    expect(run.stdout.toString().split("\n").filter(Boolean)).toEqual([
      String(BOX_LOW_SPEED_BYTES),
      String(BOX_LOW_SPEED_SECONDS),
    ]);
  });
});
