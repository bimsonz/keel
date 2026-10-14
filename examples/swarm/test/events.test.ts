import { describe, expect, it } from "vitest";
import { recordsFrom, type KeelEvent } from "../src/run/events.ts";

const at = (s: number) => new Date(Date.UTC(2026, 9, 14, 3, 0, s)).toISOString();
const event = (s: number, _tag: string, payload: Record<string, unknown> = {}): KeelEvent => ({
  at: at(s),
  payload: { _tag, ...payload },
});
const declared = (s: number, changeId: string, path: string, premises: unknown[] = []) =>
  event(s, "IntentDeclared", { changeId, footprint: [{ path, op: "create" }], premises });

describe("a run's records from Keel's events", () => {
  it("[swarm.events-fold] follows each of the run's changes from declared to its end, and only the run's", () => {
    const dir = "test/swarm/r1";
    const events: KeelEvent[] = [
      declared(0, "c-own", `${dir}/000-checkSha.test.ts`),
      event(0, "PreflightIssued", { changeId: "c-own", neighbours: [] }),
      declared(1, "c-shared", `${dir}/group-0.test.ts`),
      event(1, "PreflightIssued", {
        changeId: "c-shared",
        neighbours: [{ changeId: "c-x" }, { changeId: "c-y" }],
      }),
      declared(2, "c-premise", `${dir}/009-allows.test.ts`, [
        { subject: "authz.permission-evaluation" },
      ]),
      event(2, "PreflightIssued", { changeId: "c-premise", neighbours: [{ changeId: "c-z" }] }),
      declared(3, "c-elsewhere", "test/swarm/r0/000-checkSha.test.ts"),
      event(3, "ChangeSubmitted", { changeId: "c-elsewhere" }),
      event(10, "ChangeSubmitted", { changeId: "c-own" }),
      event(11, "ChangeSubmitted", { changeId: "c-shared" }),
      event(40, "ChangeLanded", { changeId: "c-own" }),
      event(41, "ChangeBounced", { changeId: "c-shared" }),
      // Preflight again after the rebase: the record keeps what the declare saw.
      event(42, "PreflightIssued", { changeId: "c-shared", neighbours: [] }),
      event(50, "ChangeSubmitted", { changeId: "c-shared" }),
      event(80, "ChangeLanded", { changeId: "c-shared" }),
      event(81, "ChangeSubmitted", { changeId: "c-premise" }),
      event(90, "ChangeWithdrawn", { changeId: "c-premise" }),
    ];
    const records = recordsFrom(events, { dir, workers: 5 });
    expect(records).toHaveLength(5);
    const [own, shared, premise, ...idle] = records;
    expect(own).toMatchObject({
      changeId: "c-own",
      kind: "disjoint",
      outcome: "landed",
      neighbours: 0,
      bounces: 0,
    });
    expect((own?.landedAt ?? 0) - (own?.submittedAt ?? 0)).toBe(30_000);
    expect(shared).toMatchObject({
      changeId: "c-shared",
      kind: "shared",
      outcome: "landed",
      neighbours: 2,
      bounces: 1,
    });
    // Time in queue is the landed revision's: from its own submission.
    expect((shared?.landedAt ?? 0) - (shared?.submittedAt ?? 0)).toBe(30_000);
    expect(premise).toMatchObject({
      changeId: "c-premise",
      kind: "premise",
      outcome: "withdrawn",
      neighbours: 1,
    });
    expect(idle.every((r) => r.changeId === undefined && r.outcome === "unfinished")).toBe(true);
    expect(records.some((r) => r.changeId === "c-elsewhere")).toBe(false);
  });
});
