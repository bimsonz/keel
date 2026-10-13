import { spawn } from "node:child_process";

/**
 * Where an agent's private key, or a person's sign-in, is kept on this machine:
 * the operating system's own key store, reached through the program the system
 * ships for it. The CLI never writes either to a file, and a secret never rides
 * a command line, where any process on the machine could read it.
 */
export interface KeyStore {
  /** What the store is, in words a person reads: "the macOS keychain". */
  readonly kind: string;
  /** The secret kept under `name`, or undefined when there is none. */
  readonly read: (name: string) => Promise<string | undefined>;
  readonly write: (name: string, secret: string) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
}

/** One program run to its end: its exit code and what it wrote. Undefined when the program is not on this machine. */
export type Exec = (
  file: string,
  args: readonly string[],
  stdin?: string,
) => Promise<
  { readonly code: number; readonly stdout: string; readonly stderr: string } | undefined
>;

/** What a store keeps: the service its entries are filed under, how one is labelled, and what a failure calls it. */
export interface Holds {
  readonly service: string;
  readonly label: (name: string) => string;
  readonly noun: string;
}

/** An agent's private key, filed beside the Keel host it is for. */
export const AGENT_KEYS: Holds = {
  service: "keeltown",
  label: (name) => `Keel agent key (${name})`,
  noun: "the agent's key",
};

/**
 * A person's sign-in, filed under a service of its own: an agent's key and a
 * person's session for one host never share an entry, so neither can be read
 * as, or written over, the other.
 */
export const SIGN_INS: Holds = {
  service: "keeltown-login",
  label: (name) => `Keel sign-in (${name})`,
  noun: "your sign-in",
};

/** A Keel host, with a port and a profile when it has them: nothing that could end a quoted argument. */
const NAME = /^[A-Za-z0-9.:[\]-]+(#[a-z0-9-]+)?$/;
/** A secret as the CLI stores one: base64url, so it is one word wherever it is written. */
const SECRET = /^[A-Za-z0-9_-]+$/;

function checked(name: string, secret?: string): void {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a key store entry's name.`);
  if (secret !== undefined && !SECRET.test(secret))
    throw new Error("A key store secret must be one base64url word.");
}

/** Why a store's own tool did not do what was asked: named, with its exit code, never guessed at. */
const refusedBy =
  (store: string, tool: string, noun: string) => (what: string, code: number | undefined) =>
    new Error(`${store} did not ${what} ${noun} (${tool} exited ${code ?? "without running"}).`);

/** `security`'s exit code for an item that does not exist. */
const NOT_FOUND = 44;

function macKeychain(exec: Exec, { service, label, noun }: Holds): KeyStore {
  const security = "/usr/bin/security";
  const failed = refusedBy("The macOS keychain", "security", noun);
  return {
    kind: "the macOS keychain",
    read: async (name) => {
      checked(name);
      const ran = await exec(security, ["find-generic-password", "-s", service, "-a", name, "-w"]);
      if (ran?.code === NOT_FOUND) return undefined;
      const secret = ran?.stdout.trim() ?? "";
      if (ran?.code !== 0 || secret === "") throw failed("give", ran?.code);
      return secret;
    },
    // `security -i` reads its commands from stdin, so the secret is never an argument of any process.
    write: async (name, secret) => {
      checked(name, secret);
      const ran = await exec(
        security,
        ["-i"],
        `add-generic-password -U -s ${service} -a "${name}" -l "${label(name)}" -w ${secret}\n`,
      );
      if (ran?.code !== 0) throw failed("take", ran?.code);
    },
    remove: async (name) => {
      checked(name);
      const ran = await exec(security, ["delete-generic-password", "-s", service, "-a", name]);
      if (ran?.code !== 0 && ran?.code !== NOT_FOUND) throw failed("remove", ran?.code);
    },
  };
}

function secretService(exec: Exec, { service, label, noun }: Holds): KeyStore {
  const tool = "secret-tool";
  const failed = refusedBy("The Secret Service keyring", tool, noun);
  /** How an entry is found in the Secret Service: by the attributes it was stored with. */
  const attributes = (name: string) => ["service", service, "account", name];
  return {
    kind: "the Secret Service keyring",
    // `lookup` exits 1 with nothing written when no secret matches.
    read: async (name) => {
      checked(name);
      const ran = await exec(tool, ["lookup", ...attributes(name)]);
      const secret = ran?.stdout.trim() ?? "";
      if (ran?.code === 1 && secret === "") return undefined;
      if (ran?.code !== 0 || secret === "") throw failed("give", ran?.code);
      return secret;
    },
    // `store` reads the secret from stdin.
    write: async (name, secret) => {
      checked(name, secret);
      const ran = await exec(tool, ["store", "--label", label(name), ...attributes(name)], secret);
      if (ran?.code !== 0) throw failed("take", ran?.code);
    },
    remove: async (name) => {
      checked(name);
      const ran = await exec(tool, ["clear", ...attributes(name)]);
      if (ran?.code !== 0) throw failed("remove", ran?.code);
    },
  };
}

/** Runs a program with nothing inherited but the environment, feeding it `stdin` when given. */
export const run: Exec = (file, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? resolve(undefined) : reject(error),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin ?? "");
  });

/**
 * This machine's key store, or undefined when it has none the CLI can use: a
 * container, a CI runner, a Linux box with no Secret Service tool, Windows for
 * now. There the key comes from `KEEL_AGENT_KEY`, which a secret manager sets,
 * and a person's sign-in from `KEEL_SESSION`. It keeps agents' keys unless
 * told it `holds` something else.
 */
export async function keyStoreFor(
  platform: string,
  exec: Exec = run,
  holds: Holds = AGENT_KEYS,
): Promise<KeyStore | undefined> {
  if (platform === "darwin") return macKeychain(exec, holds);
  if (platform === "linux")
    // Any answer at all means the tool is installed; none means it is not.
    return (await exec("secret-tool", ["--version"])) === undefined
      ? undefined
      : secretService(exec, holds);
  return undefined;
}
