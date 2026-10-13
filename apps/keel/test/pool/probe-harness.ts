import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  conflictView,
  probeCellRan,
  probeDrafted,
  subjectAddress,
  subjectIdOf,
  suspectConflict,
} from "@keeltown/core/application/coordination";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import type { ConflictCommand } from "@keeltown/core/domain/verification";
import {
  type ChangeId,
  type ConflictId,
  ContentHash,
  type EventEnvelope,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { EventOutbox } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { FanOutRpc } from "../../src/adapters/driven/do-rpc/fan-out.ts";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { drainAfter, placeProject } from "./helpers.ts";

export const key = Schema.decodeUnknownSync(SubjectKey);
export const LEAF = key("authz.permission-evaluation");
export const sha = (c: string) => c.repeat(40);
export const hash = (c: string) => `sha256:${c.repeat(64)}`;
export const WORKSPACE = (n: string) => ({ namespace: "keel-ws-00", name: `ws-${n}` });

/** A step's kept value, as the Workflow keeps it: the JSON of what the step answered. */
export const kept = (value: unknown) => JSON.stringify(value);
export const ok = (value: unknown) => kept({ _tag: "Ok", value });

export const subjectOf = (projectId: ProjectId) =>
  drainAfter(env.SUBJECT.get(env.SUBJECT.idFromName(subjectAddress(projectId, LEAF))));

const premise = (value: string, relation: "at-most" | "is") => ({
  subject: LEAF,
  predicate: "freshness" as const,
  relation,
  value,
});

/**
 * A semantic conflict on the subject's real Subject DO, as its fallout
 * opens one: A's premise against B's effect (or no effect, when asked), in a
 * fresh project placed in org `pool`. The ConflictSuspected it committed is
 * answered, to be delivered as the outbox would.
 */
export async function suspected(
  options: {
    readonly effect?: boolean;
    readonly subjectKey?: boolean;
    /** The premise holder, when the case has a real change for it. */
    readonly A?: ChangeId;
  } = {},
) {
  const projectId = makeId("prj", ulid());
  await placeProject(projectId);
  const conflictId = makeId("cfl", ulid());
  const [A, B] = [options.A ?? makeId("chg", ulid()), makeId("chg", ulid())];
  const command: Extract<ConflictCommand, { _tag: "Suspect" }> = {
    _tag: "Suspect",
    kind: "semantic",
    parties: [A, B],
    subjectId: subjectIdOf(projectId, LEAF),
    ...(options.subjectKey === false ? {} : { subjectKey: LEAF }),
    predicate: "freshness",
    origin: "fallout",
    premise: { holder: A, proposition: premise("per-request", "at-most") },
    ...(options.effect === false
      ? {}
      : { effect: { changeId: B, proposition: premise("per-session", "is") } }),
  };
  // Committed through the runtime, so arm the flush as an answered call would.
  const envelope = await runInDurableObject(subjectOf(projectId), async (instance: SubjectDO) => {
    const committed = await instance["runtime"].runPromise(
      Effect.gen(function* () {
        yield* suspectConflict(projectId, conflictId, command);
        const log = (yield* EventOutbox).log({ kind: "conflict", id: conflictId });
        return log.find((e) => e.type === "ConflictSuspected");
      }),
    );
    await instance["armFlush"]();
    return committed;
  });
  if (envelope === undefined) throw new Error("no ConflictSuspected committed");
  return { projectId, conflictId, A, B, envelope };
}

/** The events committed on an entity of the subject, by type. */
export async function logOf(
  projectId: ProjectId,
  entity: { kind: "conflict" | "probe"; id: string },
) {
  return runInDurableObject(subjectOf(projectId), (instance: SubjectDO) =>
    instance["runtime"].runPromise(
      Effect.map(EventOutbox, (outbox) => outbox.log(entity).map((e) => e.type)),
    ),
  );
}

/** The conflict's probe, as its ledger holds it. */
export const probeIdOf = async (projectId: ProjectId, conflictId: ConflictId) =>
  runInDurableObject(subjectOf(projectId), async (instance: SubjectDO) => {
    const view = await instance["runtime"].runPromise(conflictView(conflictId));
    if (view.probe === undefined) throw new Error(`conflict ${conflictId} has no probe`);
    return view.probe.id;
  });

export const deliver = (subscriber: string, events: readonly EventEnvelope[]) =>
  Effect.runPromise(Effect.exit(FanOutRpc(env).deliver(subscriber, events)));

/** Starts the conflict's probe on its Subject DO, as the Probe's `drafted` step does: the conflict is then probing. */
export async function drafted(projectId: ProjectId, conflictId: ConflictId) {
  await runInDurableObject(subjectOf(projectId), async (instance: SubjectDO) => {
    await instance["runtime"].runPromise(
      probeDrafted(projectId, {
        conflictId,
        attempts: 1,
        bundleHash: Schema.decodeUnknownSync(ContentHash)(hash("7")),
      }),
    );
    await instance["armFlush"]();
  });
}

/** A run that discriminates: passes on trunk and in A, fails combined and against A-noop. */
const DISCRIMINATING = [
  ["trunk", "pass"],
  ["A", "pass"],
  ["B", "n/a"],
  ["AB", "fail"],
  ["A-noop", "fail"],
] as const;

/** Drafts the conflict's probe and records all 15 of its cells: the ledger admits it, and the conflict is proven. */
export async function admitted(projectId: ProjectId, conflictId: ConflictId) {
  await drafted(projectId, conflictId);
  await runInDurableObject(subjectOf(projectId), async (instance: SubjectDO) => {
    await instance["runtime"].runPromise(
      Effect.gen(function* () {
        const probeId = (yield* conflictView(conflictId)).probe?.id;
        if (probeId === undefined) throw new Error("the draft answers its probe");
        for (const run of [1, 2, 3])
          for (const [world, outcome] of DISCRIMINATING)
            yield* probeCellRan(projectId, {
              conflictId,
              probeId,
              world,
              run,
              outcome,
              resultRef: `r2://probe/${run}/${world}`,
            });
      }),
    );
    await instance["armFlush"]();
  });
}
