/**
 * What starts a run: its shape, its workers, and either a seed the run plans
 * its tasks from or the tasks themselves. Given tasks are real work a person
 * wrote, each brief passed to its worker unchanged; a run given tasks plans
 * none of its own and plants no pairs, and has one worker a task.
 */

import * as v from "valibot";

export const Shape = v.picklist(["one", "many"]);

/** A task given with the run: a short title for its report, and the brief its worker is told. */
export const GivenTask = v.strictObject({
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  brief: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
});
export type GivenTask = v.InferOutput<typeof GivenTask>;

/** A Workers AI model's exact id, as Flue's Cloudflare provider takes it after `cloudflare/`. */
export const ModelId = v.pipe(v.string(), v.regex(/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/));

const Workers = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200));

export const Start = v.pipe(
  v.object({
    shape: Shape,
    workers: v.optional(Workers),
    seed: v.pipe(v.number(), v.integer()),
    project: v.string(),
    rampMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(250))),
    tasks: v.optional(v.pipe(v.array(GivenTask), v.minLength(1), v.maxLength(200))),
    model: v.optional(ModelId),
  }),
  v.check(
    ({ workers, tasks }) =>
      tasks === undefined
        ? workers !== undefined
        : workers === undefined || workers === tasks.length,
    "A run takes workers, or tasks with one worker each.",
  ),
  v.transform(({ workers, tasks, ...rest }) => ({
    ...rest,
    workers: tasks?.length ?? workers ?? 0,
    ...(tasks === undefined ? {} : { tasks }),
  })),
);
export type Start = v.InferOutput<typeof Start>;
