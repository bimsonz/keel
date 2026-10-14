import { apply, type Plan } from "./plan.ts";

/**
 * Zero trunk breaks, without a suite: the trunk Keel serves at the end holds
 * exactly what the run's landings make, applied in the order Keel landed
 * them. A landing lost, landed twice, or merged wrong shows as a file that
 * differs; a file no landing made shows as one more.
 */

export interface Break {
  readonly path: string;
  readonly why: "differs" | "missing" | "unexpected" | "landed-twice" | "not-applicable";
}

/** The run's files as its landings make them: the base, then each landed task's edit, in landing order. */
export function expectedTrunk(
  plan: Plan,
  landedInOrder: readonly number[],
): {
  readonly files: ReadonlyMap<string, string>;
  readonly breaks: readonly Break[];
} {
  const files = new Map(plan.base.map((f) => [f.path, f.content] as const));
  const breaks: Break[] = [];
  const seen = new Set<number>();
  for (const index of landedInOrder) {
    const task = plan.tasks[index];
    if (task === undefined) continue;
    if (seen.has(index)) {
      breaks.push({ path: task.edit.path, why: "landed-twice" });
      continue;
    }
    seen.add(index);
    try {
      files.set(task.edit.path, apply(task.edit, files.get(task.edit.path)));
    } catch {
      breaks.push({ path: task.edit.path, why: "not-applicable" });
    }
  }
  return { files, breaks };
}

/** What differs between the trunk the landings make and the trunk Keel serves (the run's paths only). */
export function compare(
  expected: ReadonlyMap<string, string>,
  served: ReadonlyMap<string, string>,
): readonly Break[] {
  const breaks: Break[] = [];
  for (const [path, content] of expected) {
    const there = served.get(path);
    if (there === undefined) breaks.push({ path, why: "missing" });
    else if (there !== content) breaks.push({ path, why: "differs" });
  }
  for (const path of served.keys())
    if (!expected.has(path)) breaks.push({ path, why: "unexpected" });
  return breaks;
}
