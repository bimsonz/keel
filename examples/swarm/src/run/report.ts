import type { TaskKind } from "./tasks.ts";

/**
 * What one worker's change did, as Keel's own record of the project tells it
 * (`events.ts`): its last state, the neighbours preflight named, its bounces,
 * and when it was submitted and landed. A worker that never declared is a
 * record with no change.
 */
export interface WorkerRecord {
  readonly index: number;
  readonly kind: TaskKind;
  readonly changeId?: string;
  /** Keel's last state for the change, or what stopped the worker before it had one. */
  readonly outcome:
    | "landed"
    | "bounced"
    | "withdrawn"
    | "superseded"
    | "parked"
    | "unfinished"
    | "failed";
  /** How many neighbours preflight named when the change was declared. */
  readonly neighbours?: number;
  readonly bounces: number;
  /** When the revision that landed was submitted, in ms since the epoch. */
  readonly submittedAt?: number;
  readonly landedAt?: number;
}

/** A run's contention numbers beside landings, bounces and model calls. */
export interface Report {
  readonly workers: number;
  readonly declared: number;
  readonly landed: number;
  readonly bounces: number;
  readonly notLanded: number;
  /** The share of declared changes whose preflight named at least one neighbour. */
  readonly contentionDensity: number | null;
  /** Bounces per landing. */
  readonly reworkRate: number | null;
  /** Time in queue, submitted to landed, of the landed changes. */
  readonly queueMs: { readonly p50: number | null; readonly p95: number | null };
  readonly modelCalls: number;
  readonly modelCallsPerLanding: number | null;
  /** Calls the model refused with its rate limit's 429, each asked again after a wait. */
  readonly modelLimited: number;
}

/** The nearest-rank percentile: the smallest value at or above `p` of the values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** The run's numbers from its workers' records, and the model calls its gate counted and the model refused. */
export function summarise(
  records: readonly WorkerRecord[],
  modelCalls: number,
  modelLimited: number,
): Report {
  const declared = records.filter((r) => r.changeId !== undefined);
  const landed = records.filter((r) => r.outcome === "landed");
  const bounces = records.reduce((sum, r) => sum + r.bounces, 0);
  const queued = landed.flatMap((r) =>
    r.submittedAt === undefined || r.landedAt === undefined ? [] : [r.landedAt - r.submittedAt],
  );
  return {
    workers: records.length,
    declared: declared.length,
    landed: landed.length,
    bounces,
    notLanded: records.length - landed.length,
    contentionDensity: ratio(
      declared.filter((r) => (r.neighbours ?? 0) > 0).length,
      declared.length,
    ),
    reworkRate: ratio(bounces, landed.length),
    queueMs: { p50: percentile(queued, 50), p95: percentile(queued, 95) },
    modelCalls,
    modelCallsPerLanding: ratio(modelCalls, landed.length),
    modelLimited,
  };
}

const share = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const fixed = (n: number | null, digits = 2) => (n === null ? "n/a" : n.toFixed(digits));
const seconds = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);

/** Reports side by side, one column each, as a Markdown table. */
export function table(
  columns: readonly { readonly title: string; readonly report: Report }[],
): string {
  const rows: [string, (r: Report) => string][] = [
    ["Workers", (r) => String(r.workers)],
    ["Declared", (r) => String(r.declared)],
    ["Landed", (r) => String(r.landed)],
    ["Not landed", (r) => String(r.notLanded)],
    ["Bounces", (r) => String(r.bounces)],
    ["Contention density", (r) => share(r.contentionDensity)],
    ["Rework rate (bounces per landing)", (r) => fixed(r.reworkRate)],
    ["Time in queue p50", (r) => seconds(r.queueMs.p50)],
    ["Time in queue p95", (r) => seconds(r.queueMs.p95)],
    ["Model calls", (r) => String(r.modelCalls)],
    ["Model calls per landing", (r) => fixed(r.modelCallsPerLanding, 1)],
    ["Model calls refused (429)", (r) => String(r.modelLimited)],
  ];
  const head = `| | ${columns.map((c) => c.title).join(" | ")} |`;
  const rule = `|---|${columns.map(() => "---:").join("|")}|`;
  return [
    head,
    rule,
    ...rows.map(
      ([name, cell]) => `| ${name} | ${columns.map((c) => cell(c.report)).join(" | ")} |`,
    ),
  ].join("\n");
}
