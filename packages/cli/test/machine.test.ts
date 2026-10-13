import { describe, expect, it } from "vitest";
import type { Exec } from "../src/key-store.ts";
import { machineIo } from "../src/machine.ts";
import { run } from "../src/run.ts";
import { keel, ORIGIN } from "./person.ts";

describe("keeltown on a machine", () => {
  it("[cli.machine-stores] files a sign-in under its own service in the machine's key store, never under the agent's, and knows how it was run", async () => {
    const ran: { args: readonly string[]; stdin: string | undefined }[] = [];
    const exec: Exec = async (_file, args, stdin) => {
      ran.push({ args, stdin });
      return { code: 0, stdout: "", stderr: "" };
    };
    const k = keel();
    const io = await machineIo(
      {
        platform: "darwin",
        env: { KEEL_URL: ORIGIN },
        argv: ["/usr/local/bin/node", "/opt/keeltown/bin.ts", "login"],
        stdout: k.io.stdout,
        stderr: k.io.stderr,
        stdin: async () => "",
      },
      exec,
    );
    expect(io.self).toEqual(["/usr/local/bin/node", "/opt/keeltown/bin.ts"]);
    // The fake Keel's fetch and clock, with everything the machine gave over them.
    expect(await run(["login"], { ...k.io, ...io })).toBe(0);
    const written = ran.filter((r) => r.stdin?.startsWith("add-generic-password"));
    expect(written).toHaveLength(1);
    expect(written[0]?.stdin).toMatch(
      /^add-generic-password -U -s keeltown-login -a "keel\.test" -l "Keel sign-in \(keel\.test\)" -w [A-Za-z0-9_-]+\n$/,
    );
    await io.keyStore?.remove("keel.test");
    expect(ran.at(-1)?.args).toEqual([
      "delete-generic-password",
      "-s",
      "keeltown",
      "-a",
      "keel.test",
    ]);
  });
});
