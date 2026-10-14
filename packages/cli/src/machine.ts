import { entryName, type Held, heldKey, KeyError } from "./agent-key.ts";
import { type Exec, keyStoreFor, run, SIGN_INS } from "./key-store.ts";
import type { Io } from "./run.ts";

/** The process the CLI runs as: what it was started with, and its streams. */
export interface Machine {
  readonly platform: string;
  readonly env: Io["env"];
  /** The command line it was started with: the program, the script, then the arguments. */
  readonly argv: readonly string[];
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly stdin: () => Promise<string>;
}

/**
 * The CLI's reach into this machine: its key store twice over, once for an
 * agent's key and once, under a service of its own, for a person's sign-in;
 * git; and the command that runs this CLI again, which git's config is given.
 */
export async function machineIo(machine: Machine, exec: Exec = run): Promise<Io> {
  const [program, script] = machine.argv;
  return {
    env: machine.env,
    stdout: machine.stdout,
    stderr: machine.stderr,
    stdin: machine.stdin,
    keyStore: await keyStoreFor(machine.platform, exec),
    signIns: await keyStoreFor(machine.platform, exec, SIGN_INS),
    exec,
    ...(program === undefined || script === undefined ? {} : { self: [program, script] }),
  };
}

/**
 * The agent a profile's key signed up as on this machine, for a script that
 * acts as it: KEEL_AGENT_KEY with KEEL_AGENT_ID when set, else the key store's
 * entry for the host and the profile, read as `keeltown` reads it. Undefined
 * when neither holds a key.
 */
export async function machineAgent(
  platform: string,
  env: Io["env"],
  baseUrl: string,
  profile?: string,
  exec: Exec = run,
): Promise<(Held & { readonly agentId: string }) | undefined> {
  const held = await heldKey(env, await keyStoreFor(platform, exec), entryName(baseUrl, profile));
  if (held === undefined) return undefined;
  if (held.agentId === undefined)
    throw new KeyError("this key has not signed up yet: run `keeltown agent signup`");
  return { ...held, agentId: held.agentId };
}
