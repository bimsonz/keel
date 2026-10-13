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
