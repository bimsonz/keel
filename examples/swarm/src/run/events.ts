import type { WorkerRecord } from "./report.ts";

/** One entry of a project's event feed, as Keel's `events` answers it. */
export interface KeelEvent {
  readonly at: string;
  readonly payload: { readonly _tag: string } & Readonly<Record<string, unknown>>;
}

const isEvent = (value: unknown): value is KeelEvent =>
  typeof value === "object" &&
  value !== null &&
  "at" in value &&
  typeof value.at === "string" &&
  "payload" in value &&
  typeof value.payload === "object" &&
  value.payload !== null &&
  "_tag" in value.payload &&
  typeof value.payload._tag === "string";

/** The events of one page of the feed, as JSON; anything else in it is left out. */
export function eventsIn(page: string): KeelEvent[] {
  const parsed: unknown = JSON.parse(page);
  return Array.isArray(parsed) ? parsed.filter(isEvent) : [];
}

const ENDS = new Map<string, WorkerRecord["outcome"]>([
  ["ChangeLanded", "landed"],
  ["ChangeWithdrawn", "withdrawn"],
  ["ChangeSuperseded", "superseded"],
  ["ChangeParked", "parked"],
]);

const field = (event: KeelEvent, key: string): unknown => event.payload[key];
const text = (event: KeelEvent, key: string): string | undefined => {
  const value = field(event, key);
  return typeof value === "string" ? value : undefined;
};
const list = (event: KeelEvent, key: string): readonly unknown[] => {
  const value = field(event, key);
  return Array.isArray(value) ? value : [];
};
const pathOf = (entry: unknown): string | undefined =>
  typeof entry === "object" && entry !== null && "path" in entry && typeof entry.path === "string"
    ? entry.path
    : undefined;

/**
 * The run's records, from Keel's own record of the project: every change
 * declared on a file under the run's directory, followed through preflight,
 * its submissions, its bounces and its end. Workers that never declared are
 * records with no change, up to `workers`. Nothing here is the workers' own
 * account of what they did.
 */
export function recordsFrom(
  events: readonly KeelEvent[],
  run: { readonly dir: string; readonly workers: number },
): WorkerRecord[] {
  const prefix = `${run.dir}/`;
  type Draft = { -readonly [K in keyof WorkerRecord]: WorkerRecord[K] };
  const changes = new Map<string, Draft>();
  for (const event of events) {
    const tag = event.payload._tag;
    const changeId = text(event, "changeId");
    if (changeId === undefined) continue;
    if (tag === "IntentDeclared") {
      const paths = list(event, "footprint").map(pathOf);
      if (!paths.some((p) => p?.startsWith(prefix))) continue;
      if (changes.has(changeId)) continue;
      const kind =
        list(event, "premises").length > 0
          ? "premise"
          : paths.some((p) => p?.includes("/group-"))
            ? "shared"
            : "disjoint";
      changes.set(changeId, {
        index: changes.size,
        kind,
        changeId,
        outcome: "unfinished",
        bounces: 0,
      });
      continue;
    }
    const change = changes.get(changeId);
    if (change === undefined) continue;
    const at = Date.parse(event.at);
    if (tag === "PreflightIssued") change.neighbours ??= list(event, "neighbours").length;
    else if (tag === "ChangeSubmitted") change.submittedAt = at;
    else if (tag === "ChangeBounced") {
      change.bounces += 1;
      change.outcome = "bounced";
    } else {
      const end = ENDS.get(tag);
      if (end === undefined) continue;
      change.outcome = end;
      if (end === "landed") change.landedAt = at;
    }
  }
  const records: WorkerRecord[] = [...changes.values()];
  for (let i = records.length; i < run.workers; i++)
    records.push({ index: i, kind: "disjoint", outcome: "unfinished", bounces: 0 });
  return records;
}
