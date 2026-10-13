import { entryName, KeyError } from "./agent-key.ts";
import { heldSignIn } from "./login.ts";
import type { ExitCode, Io } from "./run.ts";

/** This machine itself: the one host a credential may reach over plain `http`. */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** What git's helper is run with, after this CLI's own command. */
const HELPER = ["auth", "git-credential"];

/** The address git wants a credential for, from the `key=value` lines it writes its helper. */
export function credentialOf(input: string): {
  readonly protocol?: string;
  readonly host?: string;
} {
  const fields = new Map<string, string>();
  for (const line of input.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trimEnd());
  }
  const protocol = fields.get("protocol");
  const host = fields.get("host");
  return {
    ...(protocol === undefined ? {} : { protocol }),
    ...(host === undefined ? {} : { host }),
  };
}

/**
 * git's credential helper. `get` answers with the sign-in this machine holds
 * for the host git names, and only over `https` (or to this machine itself):
 * a session's token is never sent in the clear. `KEEL_SESSION` is one Keel's,
 * so it is given to `KEEL_URL`'s host alone. `store` and `erase` do nothing:
 * `login` and `logout` are the only things that write a sign-in.
 */
export async function gitCredential(
  io: Io,
  op: string | undefined,
  profile: string | undefined,
): Promise<ExitCode> {
  if (op !== "get") return 0;
  const { protocol, host } = credentialOf((await io.stdin?.()) ?? "");
  if (host === undefined) return 0;
  if (protocol !== "https" && !(protocol === "http" && LOOPBACK.test(host))) return 0;
  try {
    const named = io.env["KEEL_URL"];
    const own = named !== undefined && URL.parse(named)?.host === host;
    const held = await heldSignIn(
      own ? io.env : {},
      io.signIns,
      entryName(`${protocol}://${host}`, profile),
    );
    if (held === undefined) {
      io.stderr(`keeltown holds no sign-in for ${host}: run \`keeltown login\`.`);
      return 0;
    }
    io.stdout(`username=${held.handle ?? "keeltown"}`);
    io.stdout(`password=${held.token}`);
    return 0;
  } catch (error) {
    // git reads a helper's failure as no answer and asks the person: say why, in one line.
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

/** A word as git's shell reads one: quoted unless it is plainly safe bare. */
const quoted = (word: string) =>
  /^[A-Za-z0-9_/.:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * `auth setup-git`: has git ask this CLI for the credential to one Keel host.
 * Two lines of the person's own git config, under that host alone: an empty
 * one, which ends the list of helpers set for every host, so none of them is
 * asked for Keel's credential or handed it to keep; then this CLI, by the
 * path it was run from, so git finds it whatever its own PATH is.
 */
export async function setupGit(
  io: Io,
  baseUrl: string,
  profile: string | undefined,
): Promise<ExitCode> {
  const url = URL.parse(baseUrl);
  if (url === null) throw new KeyError("KEEL_URL is not a URL");
  const key = `credential.${url.protocol}//${url.host}.helper`;
  const helper = `!${[
    ...(io.self ?? ["keeltown"]),
    ...HELPER,
    ...(profile === undefined ? [] : ["--profile", profile]),
  ]
    .map(quoted)
    .join(" ")}`;
  for (const args of [
    ["config", "--global", "--replace-all", key, ""],
    ["config", "--global", "--add", key, helper],
  ]) {
    const ran = await io.exec?.("git", args);
    if (ran === undefined) {
      io.stderr("git is not on this machine's PATH, so there is nothing to set up.");
      return 2;
    }
    if (ran.code !== 0) {
      io.stderr(
        `git did not take the setting (git config exited ${ran.code}): ${ran.stderr.trim()}`,
      );
      return 2;
    }
  }
  io.stdout(
    `git now asks keeltown for the credential to ${url.host}: a private project there clones with nothing pasted.`,
  );
  return 0;
}
