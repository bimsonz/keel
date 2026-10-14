import type { Worker } from "../agents/coder.ts";
import type { GivenTask } from "./start.ts";
import { brief, planTasks } from "./tasks.ts";

/** What a worker's start needs to know of its run. */
export interface RunPlan {
  readonly id: string;
  readonly shape: "one" | "many";
  readonly workers: number;
  readonly seed: number;
  readonly project: string;
  readonly base?: string | undefined;
  readonly tasks?: readonly GivenTask[] | undefined;
  readonly model?: string | undefined;
}

/** A worker as Flue's dispatch starts it: its id, what it is told when made, and its brief. */
export interface Dispatch {
  readonly id: string;
  readonly initialData: Worker;
  readonly message: string;
}

/**
 * The run's `index`th worker: its given task's brief as written, or else its
 * planned task's, under the account's keyring and the run's model. Undefined
 * when the run has no such task or the worker no account.
 */
export function workerAt(
  run: RunPlan,
  index: number,
  keyring: string | undefined,
): Dispatch | undefined {
  const message = run.tasks === undefined ? plannedBrief(run, index) : run.tasks[index]?.brief;
  if (message === undefined || keyring === undefined) return undefined;
  return {
    id: `${run.id}-${index}`,
    initialData: {
      keyring,
      run: run.shape === "one" ? `${run.id}-${index}` : run.id,
      project: run.project,
      ...(run.model === undefined ? {} : { model: run.model }),
    },
    message,
  };
}

function plannedBrief(run: RunPlan, index: number): string | undefined {
  const planned = planTasks({ seed: run.seed, count: run.workers, run: run.id, base: run.base });
  const task = planned[index];
  return task === undefined ? undefined : brief(task);
}
