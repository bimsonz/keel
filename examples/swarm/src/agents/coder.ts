"use agent";
import { defineTool, useInitialData, useMcpConnection, useModel, useTool } from "@flue/runtime";
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

/** Keel's MCP tools a worker needs, and no others: each mounted tool costs the model context. */
const KEEL_TOOLS = ["declare", "commit", "submit", "status", "rebase", "inbox"];

const INSTRUCTIONS = `You are one worker in a swarm of coding agents. You change one Keel project's code, and you do it only through your tools: Keel's (mcp__keel__*) and read_file. There is no clone and no shell.

Your brief says which test file to write, the cases it must assert, and what to declare. Work through it like this:
1. Declare the change with exactly the goal, footprint and premises your brief gives, and an idempotency key of your own. If Keel answers that no workspace is ready yet (workspace.pool_exhausted), call inbox with wait 10, then declare again with the same key.
2. If your file is shared with other workers, read it with read_file at your workspace's baseSha first. If it exists, keep every line of it.
3. Commit the whole new content of your file: expectedHead is your workspace's head (its baseSha before your first commit), and the lease is your lease's id.
4. Submit that commit, then call status with wait 30 until the change is landed, bounced, withdrawn or superseded.
5. If it bounced: call rebase with your lease. Its answer names the new base. Read your file again at that base with read_file, write your edit on top of what is there now, and commit with parent set to the new base and expectedHead set to your last commit. Then submit again. If the verdict says your tests failed, fix them using its reasons and commit again in the same way. Stop after three submissions.

Take every id from a tool's answer; never invent one. When you are done, answer with one line: LANDED <changeId>, or GAVE UP <changeId> and why.`;

export function Coder(): string {
  const worker = useInitialData<Worker>();
  const keyring = env.KEYRING.get(env.KEYRING.idFromName(worker.keyring));
  const scope = { project: worker.project, run: worker.run };
  useModel(`cloudflare/${env.SWARM_MODEL}`);
  useMcpConnection({
    name: "keel",
    url: `${keelOrigin(env)}/mcp`,
    // Read on every request: the keyring keeps one client per run, which mints a token about every five minutes.
    auth: () => keyring.token({ ...scope, door: "mcp" }),
    tools: KEEL_TOOLS,
  });
  useTool(
    defineTool({
      name: "read_file",
      description:
        "Read one file of the project at a commit (a sha, or main). Answers {found: false} when the file isn't there.",
      input: v.object({ path: v.string(), ref: v.string() }),
      output: v.object({
        found: v.boolean(),
        content: v.optional(v.string()),
        commit: v.optional(v.string()),
      }),
      run: async ({ data }) => ({
        output: await keyring.read({ ...scope, path: data.path, ref: data.ref }),
      }),
    }),
  );
  return INSTRUCTIONS;
}

Coder.initialData = v.object({ keyring: v.string(), run: v.string(), project: v.string() });
// A worker's whole brief is one submission, bounded in time. A deploy or restart
// mid-run interrupts it: recovery continues it (its Keel calls carry their own
// idempotency keys), rather than failing it at its first interruption.
Coder.durability = { maxAttempts: 3, timeoutMs: 20 * 60_000 };
