import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type KeelClient, KeelProblem } from "@keeltown/sdk";
import { cloneWorkspace, commitAndPush } from "./git.ts";

/**
 * Scenario S1 against a deployed Keel, as far as its two changes being
 * submitted: the steps every live harness that needs a real conflict shares.
 * A relies on permission evaluation being fresh at most per-request and adds
 * the revoke route; B declares the effect freshness = per-session and adds the
 * role cache. They merge cleanly and disagree about that one premise.
 */

/** The template every harness forks its project from. */
export const FIXTURE = "fixture-forge-lite";
/** The subject both changes speak about. */
export const SUBJECT = "authz.permission-evaluation";
/** The file both propositions anchor to. */
export const ANCHORED = "src/authz/require-permission.ts";
const SCENARIO = join(import.meta.dirname, "../../../fixtures/forge-lite/scenarios/s1");

export type EventRecord = Awaited<ReturnType<KeelClient["events"]>>["items"][number];
export type Declared = Awaited<ReturnType<KeelClient["declare"]>>;
export const tagOf = (e: EventRecord): string => e.payload._tag;
export const field = (e: EventRecord, key: string): unknown => Reflect.get(e.payload, key);
export const brief = (value: unknown, max = 300): string =>
  JSON.stringify(value)?.slice(0, max) ?? "";

/**
 * A feed read forward on demand: the reader's own project's from its start,
 * or the project and the cursor `from` names (a person names the project; a
 * cursor skips what came before the run).
 */
export function feedOf(
  reader: KeelClient,
  from: { readonly project?: string; readonly cursor?: string } = {},
) {
  const seen: EventRecord[] = [];
  /** Each read the server failed (a 5xx), as `status code: detail`: said aloud and read again, never hidden. */
  const faults: string[] = [];
  let at = from.cursor;
  const page = (wait: number) =>
    reader.events({
      ...(at === undefined ? {} : { cursor: at }),
      ...(from.project === undefined ? {} : { project: from.project }),
      limit: 500,
      wait,
    });
  const read = async (wait: number) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const got = await page(wait);
        at = got.nextCursor;
        seen.push(...got.items);
        return;
      } catch (error) {
        // A wait of minutes should not end on one failed read; three in a row is the server's state, and is thrown.
        if (!(error instanceof KeelProblem) || error.status < 500 || attempt === 3) throw error;
        faults.push(`${error.status} ${error.message}`);
        console.log(`     a feed read answered ${error.status} ${error.message}; reading again`);
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  };
  /** Reads until `done` holds or `ms` passes; the feed is in projection order, so one more page follows. */
  const until = async (done: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!done() && Date.now() < deadline) await read(20);
    await read(5);
    return done();
  };
  return { seen, until, faults };
}

/** Declares, waiting out a pool that is still forking (a new project's) under the same key, for at most `settleMs`. */
export async function declareWhenPooled(
  client: KeelClient,
  intent: Parameters<KeelClient["declare"]>[0],
  idempotencyKey: string,
  settleMs: number,
): Promise<Declared> {
  const deadline = Date.now() + settleMs;
  for (;;) {
    try {
      return await client.declare(intent, { idempotencyKey });
    } catch (error) {
      if (
        !(error instanceof KeelProblem) ||
        error.code !== "workspace.pool_exhausted" ||
        Date.now() > deadline
      )
        throw error;
      console.log(`     pool still forking; retrying in ${error.retryAfterMs ?? 5_000} ms`);
      await new Promise((r) => setTimeout(r, error.retryAfterMs ?? 5_000));
    }
  }
}

/** A scenario patch, and the footprint it edits. */
export function scenarioPatch(name: "a" | "b") {
  const file = join(SCENARIO, `${name}.patch`);
  const footprint = [
    ...readFileSync(file, "utf8").matchAll(/^diff --git a\/(\S+) b\/\S+\n(new file mode)?/gm),
  ].map((m) => ({
    path: m[1] ?? "",
    op: m[2] === undefined ? ("edit" as const) : ("create" as const),
  }));
  return { file, footprint };
}

/** Applies a scenario patch in a workspace's clone. */
export const applyPatch = (file: string) => (dir: string) => {
  execFileSync("git", ["apply", file], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
};

/**
 * Declares S1's two changes, each anchored at `base` (trunk's head): A with
 * its premise, then B with its effect. Fallout suspects the conflict when the
 * second arrives, which starts the Probe; it waits for both submissions.
 * `declared` hears each change as it is made, so a caller that withdraws what
 * it leaves open knows of A even when B's declare fails.
 */
export async function declareS1(
  agents: { readonly a: KeelClient; readonly b: KeelClient },
  base: string,
  keyOf: (party: "a" | "b") => string,
  settleMs: number,
  declared: (changeId: string) => void,
): Promise<{ readonly a: Declared; readonly b: Declared }> {
  const anchor = (path: string, symbol: string) => ({ path, symbol, commit: base });
  const freshness = (
    relation: "at-most" | "is",
    value: string,
    anchors: ReturnType<typeof anchor>[],
  ) => ({ subject: SUBJECT, predicate: "freshness" as const, relation, value, anchors });
  const a = await declareWhenPooled(
    agents.a,
    {
      goal: "Owners can revoke collaborators, effective immediately",
      footprint: scenarioPatch("a").footprint,
      premises: [
        freshness("at-most", "per-request", [
          anchor(ANCHORED, "requirePermission"),
          anchor("src/routes/collaborators.ts", "store.removeCollaborator"),
        ]),
      ],
    },
    keyOf("a"),
    settleMs,
  );
  declared(a.result.change.id);
  const b = await declareWhenPooled(
    agents.b,
    {
      goal: "Speed up permission checks with a per-session role cache",
      footprint: scenarioPatch("b").footprint,
      premises: [],
      declaredEffects: [freshness("is", "per-session", [anchor(ANCHORED, "requirePermission")])],
    },
    keyOf("b"),
    settleMs,
  );
  declared(b.result.change.id);
  return { a, b };
}

/**
 * Applies `write` in the change's workspace, pushes it as `author` and submits
 * the commit under the change's lease.
 */
export async function pushAndSubmit(
  agent: KeelClient,
  declared: Declared,
  commit: { readonly author: string; readonly message: string; readonly idempotencyKey: string },
  write: (dir: string) => void,
): Promise<string> {
  const { change, workspace, lease } = declared.result;
  if (workspace.token === undefined) throw new Error("declare answered no workspace token");
  const dir = cloneWorkspace(workspace.remote, workspace.token);
  let commitSha: string;
  try {
    write(dir);
    commitSha = commitAndPush(dir, workspace.token, commit.author, commit.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await agent.submit(
    { changeId: change.id, commitSha },
    { lease: lease.id, idempotencyKey: commit.idempotencyKey },
  );
  console.log(`     ${commit.author}: change ${change.id} submitted at ${commitSha.slice(0, 12)}`);
  return commitSha;
}
