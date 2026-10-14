"use agent";
import { useInitialData, useMcpConnection, useModel } from "@flue/runtime";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { keelOrigin } from "../env.ts";

/** What a worker is told when it is made: whose key it works with, under which run, on which project. */
export interface Worker {
  /** The keyring of the account it works as. */
  readonly keyring: string;
  /** Its run's label: its changes and workspaces are this run's. */
  readonly run: string;
  readonly project: string;
}

// What Keel's tools are and how its workflow goes, the worker learns from Keel's own answers:
// it is told only what to build, and every tool Keel serves is mounted.
const INSTRUCTIONS = `You're a coding agent connected to Keel, a Git platform, through its MCP tools (mcp__keel__*); there's no clone and no shell.

Your task is below. Get your change landed on Keel. Start with whoami; do what Keel's answers tell you next. When done, answer LANDED <changeId> or GAVE UP <changeId> and why.`;

export function Coder(): string {
  const worker = useInitialData<Worker>();
  const keyring = env.KEYRING.get(env.KEYRING.idFromName(worker.keyring));
  const scope = { project: worker.project, run: worker.run };
  useModel(`cloudflare/${env.SWARM_MODEL}`);
  useMcpConnection({
    name: "keel",
    url: `${keelOrigin(env)}/mcp`,
    // Read on every request: the keyring keeps one client per run, which mints a token about every five minutes.
    auth: () => keyring.token(scope),
  });
  return INSTRUCTIONS;
}

Coder.initialData = v.object({ keyring: v.string(), run: v.string(), project: v.string() });
// A worker's whole brief is one submission, bounded in time. A deploy or restart
// mid-run interrupts it: recovery continues it (its Keel calls carry their own
// idempotency keys), rather than failing it at its first interruption.
Coder.durability = { maxAttempts: 3, timeoutMs: 20 * 60_000 };
