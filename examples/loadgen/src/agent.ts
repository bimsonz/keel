import { KeelProblem, KeelTokenError, type KeelClient } from "@keeltown/sdk";
import { apply, type Task } from "./plan.ts";

/**
 * One synthetic agent: a run of the loadgen account, scripted, with no model.
 * It declares its task, commits its file through Keel's API (no clone),
 * submits, and waits for the change to settle. When it bounces it rebases,
 * writes its edit again on the new base and submits again, three times at
 * most, as Keel's own agents are told to.
 */

export interface AgentResult {
  readonly index: number;
  readonly changeId?: string;
  readonly outcome: "landed" | "gave-up" | "failed";
  readonly submissions: number;
  readonly reason?: string;
  /** The declare call's own time, preflight included: the try Keel answered, not the waits for the pool. */
  readonly declareMs?: number;
}

export const MAX_SUBMISSIONS = 3;
const SETTLED: ReadonlySet<string> = new Set(["landed", "bounced", "withdrawn", "superseded"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait before asking again, or undefined when the refusal is the answer. */
export function retryIn(error: unknown, tries: number): number | undefined {
  if (error instanceof KeelProblem) {
    if (error.code === "workspace.pool_exhausted") return error.retryAfterMs ?? 5_000;
    if (error.status === 429) return error.retryAfterMs ?? 60_000;
    if (error.status >= 500 && tries < 5) return 2_000 * (tries + 1);
    return undefined;
  }
  // The token request's refusal by the limit: the pace holds every request until its window ends.
  if (error instanceof KeelTokenError)
    return error.status === 429 || error.status >= 500 ? 1_000 : undefined;
  // A request that never reached Keel.
  if (error instanceof TypeError && tries < 5) return 3_000 * (tries + 1);
  return undefined;
}

/** `act` asked again, under the same idempotency key, while Keel says to wait. */
export async function patiently<T>(act: () => Promise<T>, deadline: number): Promise<T> {
  for (let tries = 0; ; tries += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one try at a time
      return await act();
    } catch (error) {
      const wait = retryIn(error, tries);
      if (wait === undefined || Date.now() + wait > deadline) throw error;
      // oxlint-disable-next-line no-await-in-loop -- the wait is the point
      await sleep(wait);
    }
  }
}

/** The file at `ref`, or undefined when it is not there. */
async function readAt(
  client: KeelClient,
  project: string,
  path: string,
  ref: string,
  deadline: number,
) {
  try {
    return (await patiently(() => client.blob(project, path, { ref }), deadline)).content;
  } catch (error) {
    if (error instanceof KeelProblem && error.status === 404) return undefined;
    throw error;
  }
}

/** Waits on the change's status until it settles or the deadline passes. */
async function settle(client: KeelClient, changeId: string, deadline: number): Promise<string> {
  for (;;) {
    const wait = Math.max(1, Math.min(30, Math.ceil((deadline - Date.now()) / 1000)));
    // oxlint-disable-next-line no-await-in-loop -- a long poll asks again only once answered
    const { result } = await patiently(() => client.status(changeId, { wait }), deadline);
    if (SETTLED.has(result.state) || Date.now() >= deadline) return result.state;
  }
}

export async function work(
  client: KeelClient,
  project: string,
  task: Task,
  options: { readonly key: string; readonly deadline: number },
): Promise<AgentResult> {
  const { key, deadline } = options;
  let changeId: string | undefined;
  let submissions = 0;
  try {
    // Preflight is answered with the declare, so its time is the call's: the try that was answered.
    let declareMs = 0;
    const { result: declared } = await patiently(async () => {
      const at = Date.now();
      const answer = await client.declare(
        { goal: task.goal, footprint: [...task.footprint], premises: [...task.premises] },
        { idempotencyKey: `${key}:declare` },
      );
      declareMs = Date.now() - at;
      return answer;
    }, deadline);
    changeId = declared.change.id;
    const id = changeId;
    const lease = declared.lease.id;
    const first = declared.workspace.baseSha;
    if (first === undefined)
      return {
        index: task.index,
        changeId,
        outcome: "failed",
        submissions,
        reason: "declare answered no base",
        declareMs,
      };
    let base = first;
    let head = first;
    for (;;) {
      submissions += 1;
      const n = submissions;
      const current =
        task.edit.op === "create"
          ? undefined
          : // oxlint-disable-next-line no-await-in-loop -- each step waits on the last
            await readAt(client, project, task.edit.path, base, deadline);
      const content = apply(task.edit, current);
      const parent = head === base ? {} : { parent: base };
      // oxlint-disable-next-line no-await-in-loop -- each step waits on the last
      const { result: committed } = await patiently(
        () =>
          client.commitEdits(
            id,
            {
              expectedHead: head,
              ...parent,
              message: task.goal,
              edits: [{ path: task.edit.path, content }],
            },
            { lease, idempotencyKey: `${key}:commit:${n}` },
          ),
        deadline,
      );
      head = committed.commitSha;
      const sha = head;
      // oxlint-disable-next-line no-await-in-loop -- each step waits on the last
      await patiently(
        () =>
          client.submit(
            { changeId: id, commitSha: sha },
            { lease, idempotencyKey: `${key}:submit:${n}` },
          ),
        deadline,
      );
      // oxlint-disable-next-line no-await-in-loop -- each step waits on the last
      const state = await settle(client, id, deadline);
      if (state === "landed")
        return { index: task.index, changeId, outcome: "landed", submissions, declareMs };
      if (state !== "bounced" || submissions === MAX_SUBMISSIONS) {
        // oxlint-disable-next-line no-await-in-loop -- once, on the way out
        await patiently(
          () => client.abandon(id, {}, { lease, idempotencyKey: `${key}:abandon` }),
          deadline,
        ).catch(() => undefined);
        return {
          index: task.index,
          changeId,
          outcome: "gave-up",
          submissions,
          reason: state === "bounced" ? `bounced ${submissions} times` : `the change is ${state}`,
          declareMs,
        };
      }
      // oxlint-disable-next-line no-await-in-loop -- each step waits on the last
      const { result: moved } = await patiently(
        () => client.rebase(id, { lease, idempotencyKey: `${key}:rebase:${n}` }),
        deadline,
      );
      base = moved.base;
    }
  } catch (error) {
    return {
      index: task.index,
      ...(changeId === undefined ? {} : { changeId }),
      outcome: "failed",
      submissions,
      reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}
