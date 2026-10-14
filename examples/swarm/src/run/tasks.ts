/**
 * A run's tasks, planned from a seed. Every task asks a worker to write vitest
 * cases for one pure function of the forge-lite fixture, with the expected
 * answers given, so a change is real code the project's suite runs at landing.
 *
 * Overlap is planned, not hoped for (disjoint changes are free, so a
 * count alone proves nothing):
 *   - 60% write a test file of their own: disjoint footprints;
 *   - 30% add their cases to a test file shared with the rest of their group
 *     (five groups at most): the same file, so textual bounces, rebases and
 *     re-merges;
 *   - 10% declare a premise on one of two shared subjects, so preflight shows
 *     neighbours by subject as well as by footprint.
 */

/** A function of the fixture and where it lives, from the repository root. */
export interface Target {
  readonly module: string;
  readonly fn: string;
  /** How a case's answer reads: a validator answers undefined or a message; a predicate answers a boolean. */
  readonly answers: "validator" | "predicate";
}

/** One call and its expected answer. */
export interface Case {
  readonly args: readonly (string | null)[];
  /** For a validator: true when the value is accepted (undefined), false when refused (a message). */
  readonly expected: boolean;
}

export type TaskKind = "disjoint" | "shared" | "premise";

/** A premise in Keel's proposition shape, declared with the change. */
export interface Premise {
  readonly subject: string;
  readonly predicate: "authority" | "invariant";
  readonly relation: "is";
  readonly value: string;
  readonly gloss: string;
}

export interface Task {
  readonly index: number;
  readonly kind: TaskKind;
  /** The shared group, for a shared task. */
  readonly group?: number;
  readonly goal: string;
  /** The test file the worker writes, from the repository root. */
  readonly path: string;
  readonly target: Target;
  readonly cases: readonly Case[];
  readonly premises: readonly Premise[];
}

const NAMES = "src/domain/names.ts";
const PERMISSIONS = "src/domain/permissions.ts";

const validator = (fn: string): Target => ({ module: NAMES, fn, answers: "validator" });
const predicate = (fn: string): Target => ({ module: PERMISSIONS, fn, answers: "predicate" });

const yes = (...args: (string | null)[]): Case => ({ args, expected: true });
const no = (...args: (string | null)[]): Case => ({ args, expected: false });

/** Each function with cases whose answers `[swarm.tasks-truth]` checks against the fixture itself. */
export const BANK: readonly { readonly target: Target; readonly cases: readonly Case[] }[] = [
  {
    target: validator("checkUsername"),
    cases: [
      yes("a"),
      yes("octo-cat"),
      no("-octo"),
      no("octo-"),
      no("Octo"),
      no("o_o"),
      yes("a".repeat(39)),
      no("a".repeat(40)),
    ],
  },
  {
    target: validator("checkRepoName"),
    cases: [
      yes("keel"),
      yes("my.repo_1-x"),
      no("."),
      no(".."),
      no("repo.git"),
      no("Repo"),
      no(""),
      yes("a".repeat(100)),
      no("a".repeat(101)),
    ],
  },
  {
    target: validator("checkBranch"),
    cases: [
      yes("main"),
      yes("v1.2"),
      yes("Release_2"),
      no("feature/x"),
      no("-x"),
      no("a..b"),
      no("x.lock"),
    ],
  },
  {
    target: validator("checkLabel"),
    cases: [
      yes("bug"),
      yes("good-first-issue"),
      no("-bug"),
      no("Bug"),
      yes("a".repeat(50)),
      no("a".repeat(51)),
    ],
  },
  {
    target: validator("checkSha"),
    cases: [
      yes("0".repeat(40)),
      yes("a".repeat(40)),
      no("A".repeat(40)),
      no("0".repeat(39)),
      no("g".repeat(40)),
    ],
  },
  {
    target: validator("checkColor"),
    cases: [yes("a1b2c3"), yes("000000"), no("A1B2C3"), no("#a1b2c3"), no("abc"), no("a1b2c3d")],
  },
  {
    target: validator("checkPassword"),
    cases: [yes("x".repeat(10)), no("x".repeat(9)), yes("x".repeat(200)), no("x".repeat(201))],
  },
];

/** The premise tasks' functions, each paired with the subject its premise speaks about. */
export const PREMISE_BANK: readonly {
  readonly target: Target;
  readonly cases: readonly Case[];
  readonly premise: Premise;
}[] = [
  {
    target: predicate("allows"),
    cases: [
      yes(null, "read", "public"),
      no(null, "read", "private"),
      no(null, "push", "public"),
      yes("write", "push", "private"),
      no("triage", "push", "public"),
      yes("maintain", "manage-settings", "private"),
      no("admin", "transfer", "public"),
      yes("owner", "transfer", "private"),
      no("read", "manage-issues", "public"),
      yes("triage", "manage-issues", "private"),
    ],
    premise: {
      subject: "authz.permission-evaluation",
      predicate: "authority",
      relation: "is",
      value: "role-lattice",
      gloss: "allows() decides every action but a public read by the role lattice",
    },
  },
  {
    target: predicate("canSee"),
    cases: [
      yes(null, "public"),
      no(null, "private"),
      yes("read", "private"),
      yes("admin", "private"),
    ],
    premise: {
      subject: "repo.visibility",
      predicate: "invariant",
      relation: "is",
      value: "public-is-visible-to-anyone",
      gloss: "canSee() shows a public repository to a caller with no role",
    },
  },
];

/** How a run of `count` workers splits: 60% disjoint, 30% shared, the rest premise. */
export function mix(count: number): {
  readonly disjoint: number;
  readonly shared: number;
  readonly premise: number;
} {
  const disjoint = Math.round(count * 0.6);
  const shared = Math.min(count - disjoint, Math.round(count * 0.3));
  return { disjoint, shared, premise: count - disjoint - shared };
}

/** Five groups at most, and never a group of one: a shared file needs two writers. */
export function groupsFor(shared: number): number {
  return Math.min(5, Math.floor(shared / 2));
}

/** A small, fast, seeded generator (mulberry32): the same seed plans the same run. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CASES_PER_TASK = 3;

function pick<T>(next: () => number, from: readonly T[], n: number): T[] {
  const pool = [...from];
  const chosen: T[] = [];
  while (chosen.length < n && pool.length > 0)
    chosen.push(...pool.splice(Math.floor(next() * pool.length), 1));
  return chosen;
}

/**
 * The run's tasks, in worker order. `run` names the run's directory, so no
 * two runs write the same file and a run's files sit together on trunk.
 */
export function planTasks(options: {
  readonly seed: number;
  readonly count: number;
  readonly run: string;
}): Task[] {
  const { seed, count, run } = options;
  const next = random(seed);
  const split = mix(count);
  const groups = groupsFor(split.shared);
  const dir = `test/swarm/${run}`;
  const kinds: TaskKind[] = [
    ...Array<TaskKind>(split.disjoint).fill("disjoint"),
    ...Array<TaskKind>(split.shared).fill(groups === 0 ? "disjoint" : "shared"),
    ...Array<TaskKind>(split.premise).fill("premise"),
  ];
  let sharedSeen = 0;
  return kinds.map((kind, index): Task => {
    if (kind === "premise") {
      const entry = PREMISE_BANK[index % PREMISE_BANK.length] ?? PREMISE_BANK[0];
      if (entry === undefined) throw new Error("the premise bank is empty");
      return {
        index,
        kind,
        goal: `Test ${entry.target.fn} under the premise on ${entry.premise.subject}`,
        path: `${dir}/${String(index).padStart(3, "0")}-${entry.target.fn}.test.ts`,
        target: entry.target,
        cases: pick(next, entry.cases, CASES_PER_TASK),
        premises: [entry.premise],
      };
    }
    const entry = BANK[Math.floor(next() * BANK.length)] ?? BANK[0];
    if (entry === undefined) throw new Error("the bank is empty");
    const cases = pick(next, entry.cases, CASES_PER_TASK);
    if (kind === "shared") {
      const group = sharedSeen++ % groups;
      return {
        index,
        kind,
        group,
        goal: `Add worker ${index}'s ${entry.target.fn} cases to group ${group}'s shared test file`,
        path: `${dir}/group-${group}.test.ts`,
        target: entry.target,
        cases,
        premises: [],
      };
    }
    return {
      index,
      kind,
      goal: `Test ${entry.target.fn} with worker ${index}'s cases`,
      path: `${dir}/${String(index).padStart(3, "0")}-${entry.target.fn}.test.ts`,
      target: entry.target,
      cases,
      premises: [],
    };
  });
}

/** How a case reads in a prompt: the call, and the answer it must give. */
export function describeCase(target: Target, c: Case): string {
  const call = `${target.fn}(${c.args.map((a) => JSON.stringify(a)).join(", ")})`;
  if (target.answers === "predicate") return `${call} is ${String(c.expected)}`;
  return c.expected
    ? `${call} accepts it (returns undefined)`
    : `${call} refuses it (returns a message string)`;
}

/** The import path from the task's test file to the function's module. */
export function importPath(task: Task): string {
  const depth = task.path.split("/").length - 1;
  return `${"../".repeat(depth)}${task.target.module}`;
}

/** The worker's whole brief: what to change, how to declare it, and the cases with their answers. */
export function brief(task: Task): string {
  const lines = [
    `Goal: ${task.goal}.`,
    `File: ${task.path}. Import it as: import { ${task.target.fn} } from "${importPath(task)}"; and import { describe, expect, it } from "vitest".`,
    task.kind === "shared"
      ? `This file is shared with other workers. Read it at your workspace's head first: if it exists, keep every line of it and add one describe block of your own, named "worker ${task.index}: ${task.target.fn}", at the end. If it does not exist, create it with that one describe block.`
      : `Create the file with one describe block named "${task.target.fn}".`,
    `Write one it() per case, asserting exactly this:`,
    ...task.cases.map((c) => `- ${describeCase(task.target, c)}`),
    `Declare with goal ${JSON.stringify(task.goal)}, footprint ${JSON.stringify([{ path: task.path, op: task.kind === "shared" ? "edit" : "create" }])}, premises ${JSON.stringify(task.premises)}.`,
  ];
  return lines.join("\n");
}
