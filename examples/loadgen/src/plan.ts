import { createHash } from "node:crypto";
import type { KeelClient } from "@keeltown/sdk";

/**
 * A loadgen run's plan, a pure function of its seed: what each synthetic
 * agent (a run of the one loadgen account) declares and writes, and the
 * sealed key to its benchmark.
 *
 *   - About 60% are disjoint: a file of each agent's own.
 *   - About 30% share a file in groups of up to four, each agent a function
 *     of it, all under one subject's premise: overlap Keel should see, and
 *     merge.
 *   - About 10% are the benchmark's pairs, started together. A planted pair
 *     conflicts; a decoy pair looks like one of the four kinds but does not.
 *     Keel is never told which is which: the key is written apart, and its
 *     digest is published before the run.
 */

type Intent = Parameters<KeelClient["declare"]>[0];
export type Premise = NonNullable<Intent["premises"]>[number];
export type FootprintEntry = NonNullable<Intent["footprint"]>[number];

/** An anchor as the plan writes one: the file, the symbol, and the commit it is read at. */
export interface Anchor {
  readonly path: string;
  readonly symbol?: string;
  readonly commit?: string;
}

const isAnchor = (a: unknown): a is Anchor =>
  typeof a === "object" && a !== null && "path" in a && typeof a.path === "string";

/** A premise's anchors, read back by their shape: `declare` takes a premise's anchors as any JSON. */
export const anchorsOf = (premise: Premise): readonly Anchor[] =>
  (premise.anchors ?? []).filter(isAnchor);

/** The four kinds of conflict the benchmark plants, each with its decoy. */
export const BENCH_KINDS = ["premise", "effect", "textual", "interaction"] as const;
export type BenchKind = (typeof BENCH_KINDS)[number];

export type Edit =
  | { readonly op: "create"; readonly path: string; readonly content: string }
  /** The function `fn` in `path`, its whole text replaced by `text`. */
  | { readonly op: "replace"; readonly path: string; readonly fn: string; readonly text: string }
  /** The function `fn` in `path`, removed. */
  | { readonly op: "remove"; readonly path: string; readonly fn: string };

export interface Task {
  readonly index: number;
  readonly kind: "disjoint" | "shared" | "bench";
  readonly goal: string;
  readonly footprint: readonly FootprintEntry[];
  readonly premises: readonly Premise[];
  readonly edit: Edit;
  /** For the benchmark's tasks: the pair, and which side of it. */
  readonly pair?: number;
  readonly side?: "a" | "b";
}

/** A benchmark pair before it has sides: its kind, and whether it conflicts or is a decoy. */
export interface PairSpec {
  readonly kind: BenchKind;
  readonly planted: boolean;
}

export interface PairKey {
  readonly pair: number;
  readonly kind: BenchKind;
  readonly planted: boolean;
  readonly a: number;
  readonly b: number;
}

export interface Plan {
  readonly run: string;
  readonly seed: number;
  /** Where every file of the run lives: `lg/<run>/`. */
  readonly dir: string;
  /** The files one change lands before any agent starts. */
  readonly base: readonly { readonly path: string; readonly content: string }[];
  /** In the order the agents start; a pair's two sides are next to each other. */
  readonly tasks: readonly Task[];
  readonly key: readonly PairKey[];
}

/** A small seeded generator (mulberry32): the same seed gives the same plan. */
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

function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const held = out[i];
    const other = out[j];
    if (held === undefined || other === undefined) continue;
    out[i] = other;
    out[j] = held;
  }
  return out;
}

/** How `count` agents split: benchmark pairs first (at least one), then shared, then disjoint. */
export function mix(count: number): {
  readonly pairs: number;
  readonly shared: number;
  readonly disjoint: number;
} {
  const pairs = Math.min(Math.floor(count / 2), Math.max(1, Math.round((count * 0.1) / 2)));
  const shared = Math.min(count - pairs * 2, Math.round(count * 0.3));
  return { pairs, shared, disjoint: count - pairs * 2 - shared };
}

export const GROUP_SIZE = 4;

const fnText = (name: string, ret: string, body: string) =>
  `export function ${name}(n: number): ${ret} {\n${body}\n}\n`;

/** Functions apart, so an edit to one never touches another's lines. */
const SEPARATOR = "\n// ----\n\n";
const fileOf = (fns: readonly string[]) => fns.join(SEPARATOR);

const priceText = (body: string) => fnText("price", "number", body);
const labelText = (body: string) => fnText("label", "string", body);
const legacyText = (body: string) => fnText("legacyLabel", "string", body);

/** A benchmark pair's base file: three functions its two sides touch, or don't. */
const benchBase = () =>
  fileOf([
    priceText("  return n * 2;"),
    labelText("  return `#${n}`;"),
    legacyText("  return `No. ${n}`;"),
  ]);

const groupBase = (members: number) =>
  fileOf(
    Array.from({ length: members }, (_, j) => fnText(`f${j}`, "number", `  return n + ${j};`)),
  );

/** A subject key for this run: lowercase segments, so a run label like `r1` is kept as it is. */
const subjectOf = (run: string, ...parts: string[]) =>
  [`lg`, run.toLowerCase().replace(/[^a-z0-9-]/g, "-"), ...parts].join(".");

/** `count` pairs, balanced across the four kinds, planted and decoy alternating within a kind, then shuffled. */
export function pairKinds(count: number, next: () => number): PairSpec[] {
  return shuffled(
    Array.from({ length: count }, (_, k) => ({
      kind: BENCH_KINDS[k % BENCH_KINDS.length] ?? "premise",
      planted: Math.floor(k / BENCH_KINDS.length) % 2 === 0,
    })),
    next,
  );
}

/**
 * A run's pairs dealt to its shards: shard k takes the next `sizes[k]` of
 * them. A run of many shards plans its pairs once, so its kinds and decoys
 * are balanced over the run; a shard of a hundred plans only five, too few
 * for a decoy of every kind.
 */
export function dealPairs(pairs: readonly PairSpec[], sizes: readonly number[]): PairSpec[][] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total !== pairs.length) throw new Error(`${pairs.length} pairs dealt as ${total}`);
  return sizes.map((size, k) => {
    const from = sizes.slice(0, k).reduce((sum, n) => sum + n, 0);
    return pairs.slice(from, from + size);
  });
}

export function planRun(options: {
  readonly run: string;
  readonly seed: number;
  readonly count: number;
  /** Its pairs, when the run's are planned over all its shards; as many as `mix(count)` plans. */
  readonly pairs?: readonly PairSpec[];
}): Plan {
  const { run, seed, count } = options;
  const next = random(seed);
  const dir = `lg/${run}`;
  const split = mix(count);
  if (options.pairs !== undefined && options.pairs.length !== split.pairs)
    throw new Error(`${count} agents take ${split.pairs} pairs, not ${options.pairs.length}`);
  const pairs = options.pairs ?? pairKinds(split.pairs, next);
  const groups = Math.ceil(split.shared / GROUP_SIZE);
  const groupSizes = Array.from({ length: groups }, (_, g) =>
    Math.min(GROUP_SIZE, split.shared - g * GROUP_SIZE),
  );

  const base = [
    ...groupSizes.map((size, g) => ({ path: `${dir}/shared/g${g}.ts`, content: groupBase(size) })),
    ...pairs.map((_, k) => ({ path: `${dir}/bench/p${k}.ts`, content: benchBase() })),
  ];

  // Units of work in start order: an agent alone, or a pair's two sides together.
  type Unit =
    | { readonly kind: "disjoint" }
    | { readonly kind: "shared"; readonly group: number; readonly member: number }
    | { readonly kind: "bench"; readonly pair: number };
  const units = shuffled<Unit>(
    [
      ...Array.from({ length: split.disjoint }, (): Unit => ({ kind: "disjoint" })),
      ...groupSizes.flatMap((size, group) =>
        Array.from({ length: size }, (_, member): Unit => ({ kind: "shared", group, member })),
      ),
      ...pairs.map((_, pair): Unit => ({ kind: "bench", pair })),
    ],
    next,
  );

  const tasks: Task[] = [];
  const key: PairKey[] = [];
  for (const unit of units) {
    const index = tasks.length;
    if (unit.kind === "disjoint") {
      const path = `${dir}/own/a${index}.ts`;
      tasks.push({
        index,
        kind: "disjoint",
        goal: `Add a${index}, a function of agent ${index}'s own`,
        footprint: [{ path, op: "create" }],
        premises: [],
        edit: {
          op: "create",
          path,
          content: fnText(`a${index}`, "number", `  return n + ${index};`),
        },
      });
    } else if (unit.kind === "shared") {
      const path = `${dir}/shared/g${unit.group}.ts`;
      const fn = `f${unit.member}`;
      tasks.push({
        index,
        kind: "shared",
        goal: `Scale ${fn} in group ${unit.group}'s shared file`,
        footprint: [{ path, symbol: fn, op: "edit" }],
        premises: [
          {
            subject: subjectOf(run, `g${unit.group}`),
            predicate: "purity",
            relation: "is",
            value: true,
            gloss: `group ${unit.group}'s functions stay pure`,
          },
        ],
        edit: {
          op: "replace",
          path,
          fn,
          text: fnText(fn, "number", `  return n * ${unit.member + 2} + ${index};`),
        },
      });
    } else {
      const pair = pairs[unit.pair];
      if (pair === undefined) throw new Error(`no pair ${unit.pair}`);
      const [a, b] = sides(dir, run, unit.pair, pair.kind, pair.planted);
      tasks.push({ index, kind: "bench", pair: unit.pair, side: "a", ...a });
      tasks.push({ index: index + 1, kind: "bench", pair: unit.pair, side: "b", ...b });
      key.push({ pair: unit.pair, kind: pair.kind, planted: pair.planted, a: index, b: index + 1 });
    }
  }
  return { run, seed, dir, base, tasks, key: key.toSorted((x, y) => x.pair - y.pair) };
}

type Side = Pick<Task, "goal" | "footprint" | "premises" | "edit">;

/** A pair's two sides. Planted and decoy differ only in what conflicts. */
function sides(
  dir: string,
  run: string,
  k: number,
  kind: BenchKind,
  planted: boolean,
): [Side, Side] {
  const file = `${dir}/bench/p${k}.ts`;
  const own = (side: "a" | "b", uses: string) => {
    const path = `${dir}/bench/p${k}-${side}.ts`;
    const content = `import { ${uses} } from "./p${k}.ts";\n\n${fnText(
      `use${side.toUpperCase()}${k}`,
      uses === "price" ? "number" : "string",
      `  return ${uses}(n);`,
    )}`;
    return { path, content };
  };
  const purity = (value: boolean): Premise => ({
    subject: subjectOf(run, `p${k}`, "price"),
    predicate: "purity",
    relation: "is",
    value,
    anchors: [{ path: file, symbol: "price", commit: PENDING }],
    gloss: value ? "price() has no side effects" : "price() may have side effects",
  });
  const creating = (side: "a" | "b", uses: string, premises: readonly Premise[]): Side => {
    const made = own(side, uses);
    return {
      goal: `Use ${uses} from pair ${k}'s file in a file of its own`,
      footprint: [{ path: made.path, op: "create" }],
      premises,
      edit: { op: "create", ...made },
    };
  };
  const replacing = (fn: string, text: string): Side => ({
    goal: `Rewrite ${fn} in pair ${k}'s file`,
    footprint: [{ path: file, symbol: fn, op: "edit" }],
    premises: [],
    edit: { op: "replace", path: file, fn, text },
  });
  const table: Record<BenchKind, () => [Side, Side]> = {
    // Two premises on one subject: contradictory, or the same.
    premise: () => [
      creating("a", "price", [purity(true)]),
      creating("b", "price", [purity(!planted)]),
    ],
    // One side relies on price() being pure; the other makes it impure, or rewrites it purely.
    effect: () => [
      replacing(
        "price",
        priceText(planted ? '  console.info("priced", n);\n  return n * 2;' : "  return n + n;"),
      ),
      creating("b", "price", [purity(true)]),
    ],
    // The same lines of one function, or two functions of one file.
    textual: () => [
      replacing("price", priceText("  return n * 3;")),
      planted
        ? replacing("price", priceText("  return n * 4;"))
        : replacing("label", labelText("  return `Item ${n}`;")),
    ],
    // One side removes a function the other's new code calls, or one with a like name.
    interaction: () => {
      const fn = planted ? "label" : "legacyLabel";
      return [
        {
          goal: `Remove ${fn} from pair ${k}'s file`,
          footprint: [{ path: file, symbol: fn, op: "delete" }],
          premises: [],
          edit: { op: "remove", path: file, fn },
        },
        creating("b", "label", []),
      ];
    },
  };
  return table[kind]();
}

/**
 * An anchor names the commit it was read at, and the base files exist only
 * once the run's first change lands them: until then an anchor's commit is
 * this, and `anchoredAt` gives it that landing's trunk commit.
 */
export const PENDING = "pending";

/** The plan with every anchor read at `commit`, the trunk the base files landed on. */
export function anchoredAt(plan: Plan, commit: string): Plan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      premises: task.premises.map((premise) =>
        premise.anchors === undefined
          ? premise
          : {
              ...premise,
              anchors: anchorsOf(premise).map((a) => (a.commit === PENDING ? { ...a, commit } : a)),
            },
      ),
    })),
  };
}

const FN = (fn: string) => new RegExp(`export function ${fn}\\(n: number\\)[^]*?\\n\\}\\n`);

/** A file's content after `edit`, from `current` (undefined when the file is absent). */
export function apply(edit: Edit, current: string | undefined): string {
  if (edit.op === "create") return edit.content;
  if (current === undefined) throw new Error(`${edit.path} is not there to edit`);
  const found = FN(edit.fn).exec(current);
  if (found === null) throw new Error(`${edit.fn} is not in ${edit.path}`);
  return current.replace(found[0], edit.op === "replace" ? edit.text : "");
}

/** The key's canonical text, and the digest published before the run. */
export function sealed(plan: Plan): { readonly text: string; readonly sha256: string } {
  const text = `${JSON.stringify({ run: plan.run, seed: plan.seed, pairs: plan.key }, null, 2)}\n`;
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}
