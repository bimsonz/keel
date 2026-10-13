import { describe, expect, it } from "vitest";
import { type Exec, keyStoreFor, SIGN_INS } from "../src/key-store.ts";

const SECRET = "c2VjcmV0LXZhbHVlLW5vdC1hLWtleQ";

interface Ran {
  readonly file: string;
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

/** A recorded `exec`: every program run, and what `answer` scripts for it. */
function recorded(answer: (ran: Ran) => { code: number; stdout?: string } | undefined) {
  const ran: Ran[] = [];
  const exec: Exec = async (file, args, stdin) => {
    const call = { file, args, stdin };
    ran.push(call);
    const answered = answer(call);
    return answered === undefined
      ? undefined
      : { code: answered.code, stdout: answered.stdout ?? "", stderr: "" };
  };
  return { exec, ran };
}

const inArguments = (ran: readonly Ran[]) => ran.flatMap((r) => [r.file, ...r.args]).join(" ");

describe("the machine's key store", () => {
  it("[cli.keystore-macos] the macOS store takes the secret on stdin, never in the arguments, and reads it back", async () => {
    const { exec, ran } = recorded((r) =>
      r.args.includes("find-generic-password") ? { code: 0, stdout: `${SECRET}\n` } : { code: 0 },
    );
    const store = await keyStoreFor("darwin", exec);
    expect(store?.kind).toBe("the macOS keychain");
    await store?.write("keel.town", SECRET);
    expect(ran[0]).toMatchObject({ file: "/usr/bin/security", args: ["-i"] });
    expect(ran[0]?.stdin).toBe(
      `add-generic-password -U -s keeltown -a "keel.town" -l "Keel agent key (keel.town)" -w ${SECRET}\n`,
    );
    expect(inArguments(ran)).not.toContain(SECRET);
    expect(await store?.read("keel.town#ci")).toBe(SECRET);
    expect(ran[1]).toMatchObject({
      file: "/usr/bin/security",
      args: ["find-generic-password", "-s", "keeltown", "-a", "keel.town#ci", "-w"],
      stdin: undefined,
    });
    await store?.remove("keel.town");
    expect(ran[2]?.args).toEqual(["delete-generic-password", "-s", "keeltown", "-a", "keel.town"]);
  });

  it("[cli.keystore-macos] an item that is not there is no key, and any other failure is an error, never an empty key", async () => {
    const missing = await keyStoreFor("darwin", recorded(() => ({ code: 44 })).exec);
    expect(await missing?.read("keel.town")).toBeUndefined();
    await expect(missing?.remove("keel.town")).resolves.toBeUndefined();
    const locked = await keyStoreFor("darwin", recorded(() => ({ code: 51 })).exec);
    await expect(locked?.read("keel.town")).rejects.toThrow(/keychain/);
    await expect(locked?.write("keel.town", SECRET)).rejects.toThrow(/keychain/);
    const empty = await keyStoreFor("darwin", recorded(() => ({ code: 0, stdout: "\n" })).exec);
    await expect(empty?.read("keel.town")).rejects.toThrow(/keychain/);
  });

  it("[cli.keystore-macos] a name that could end the store's own command line is refused before anything runs", async () => {
    const { exec, ran } = recorded(() => ({ code: 0 }));
    const store = await keyStoreFor("darwin", exec);
    for (const name of ['keel.town" -w x', "keel.town\nadd", "", "a b"])
      await expect(store?.write(name, SECRET)).rejects.toThrow(/name/);
    await expect(store?.write("keel.town", "two words")).rejects.toThrow(/secret/);
    expect(ran).toEqual([]);
  });

  it("[cli.keystore-linux] the Secret Service store takes the secret on stdin, never in the arguments, and reads it back", async () => {
    const { exec, ran } = recorded((r) =>
      r.args[0] === "lookup" ? { code: 0, stdout: SECRET } : { code: 0 },
    );
    const store = await keyStoreFor("linux", exec);
    expect(store?.kind).toBe("the Secret Service keyring");
    await store?.write("keel.town", SECRET);
    const [, stored] = ran;
    expect(stored).toEqual({
      file: "secret-tool",
      args: [
        "store",
        "--label",
        "Keel agent key (keel.town)",
        "service",
        "keeltown",
        "account",
        "keel.town",
      ],
      stdin: SECRET,
    });
    expect(inArguments(ran)).not.toContain(SECRET);
    expect(await store?.read("keel.town")).toBe(SECRET);
    await store?.remove("keel.town");
    expect(ran.at(-1)?.args).toEqual(["clear", "service", "keeltown", "account", "keel.town"]);
  });

  it("[cli.keystore-linux] a secret that is not there is no key, and a machine with no secret-tool has no store", async () => {
    const missing = await keyStoreFor(
      "linux",
      recorded((r) => (r.args[0] === "lookup" ? { code: 1 } : { code: 0 })).exec,
    );
    expect(await missing?.read("keel.town")).toBeUndefined();
    expect(await keyStoreFor("linux", recorded(() => undefined).exec)).toBeUndefined();
    expect(await keyStoreFor("win32", recorded(() => ({ code: 0 })).exec)).toBeUndefined();
  });

  it("[cli.keystore-sign-ins] a person's sign-in is filed under its own service and label on macOS, and its failures say what it is", async () => {
    const { exec, ran } = recorded((r) =>
      r.args.includes("find-generic-password") ? { code: 0, stdout: `${SECRET}\n` } : { code: 0 },
    );
    const store = await keyStoreFor("darwin", exec, SIGN_INS);
    await store?.write("keel.town", SECRET);
    expect(ran[0]?.stdin).toBe(
      `add-generic-password -U -s keeltown-login -a "keel.town" -l "Keel sign-in (keel.town)" -w ${SECRET}\n`,
    );
    expect(await store?.read("keel.town")).toBe(SECRET);
    expect(ran[1]?.args).toEqual([
      "find-generic-password",
      "-s",
      "keeltown-login",
      "-a",
      "keel.town",
      "-w",
    ]);
    await store?.remove("keel.town");
    expect(ran[2]?.args).toEqual([
      "delete-generic-password",
      "-s",
      "keeltown-login",
      "-a",
      "keel.town",
    ]);
    const locked = await keyStoreFor("darwin", recorded(() => ({ code: 51 })).exec, SIGN_INS);
    await expect(locked?.read("keel.town")).rejects.toThrow(/did not give your sign-in/);
  });

  it("[cli.keystore-sign-ins] a person's sign-in is filed under its own service and label in the Secret Service", async () => {
    const { exec, ran } = recorded((r) =>
      r.args[0] === "lookup" ? { code: 0, stdout: SECRET } : { code: 0 },
    );
    const store = await keyStoreFor("linux", exec, SIGN_INS);
    await store?.write("keel.town", SECRET);
    expect(ran[1]?.args).toEqual([
      "store",
      "--label",
      "Keel sign-in (keel.town)",
      "service",
      "keeltown-login",
      "account",
      "keel.town",
    ]);
    expect(await store?.read("keel.town")).toBe(SECRET);
    expect(ran[2]?.args).toEqual(["lookup", "service", "keeltown-login", "account", "keel.town"]);
  });
});
