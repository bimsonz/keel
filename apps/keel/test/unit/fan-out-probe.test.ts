// The fan-out's Probe cases over a fake Workflow binding: what the pool cannot
// show, because miniflare takes an event for a finished instance without
// throwing, while the platform may throw.
import { ConflictId, EventEnvelope, makeId } from "@keeltown/core/kernel";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  deliverStart,
  type InstanceEvents,
  probeStart,
  sendToInstance,
  waitingWorkflowFor,
} from "../../src/adapters/driven/do-rpc/fan-out.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

const changeId = makeId("chg", ulid());
const projectId = makeId("prj", ulid());
const conflictId = Schema.decodeUnknownSync(ConflictId)(makeId("cfl", ulid()));

const envelope = (
  type: string,
  payload: unknown,
  entity: { readonly kind: string; readonly id: string } = { kind: "change", id: changeId },
) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulid()),
    type,
    entity,
    seq: 1,
    at: 1_791_709_200_000,
    dedupeKey: `${type}:1`,
    project: projectId,
    affected: [],
    notified: [],
    payload,
  });

/** A Probe binding whose instances answer `status`, and whose sendEvent throws when `refuses`. */
function probes(status: string, refuses: boolean) {
  const sent: { readonly id: string; readonly type: string; readonly payload: unknown }[] = [];
  const workflow: InstanceEvents = {
    get: async (id) => ({
      status: async () => ({ status }),
      sendEvent: async (event) => {
        if (refuses) throw new Error(`instance ${id} takes no more events`);
        sent.push({ id, ...event });
      },
    }),
  };
  const deliver = (instance: string, events: readonly EventEnvelope[]) =>
    Effect.runPromise(
      Effect.exit(sendToInstance(workflow, instance, `workflow:Probe/${instance}`, events)),
    );
  return { sent, deliver, workflow };
}

describe("the fan-out's Probe cases", () => {
  it("[fan-out.send] a waiting instance's subscription gets each change event as change-<changeId>, with the envelope", async () => {
    const { sent, deliver } = probes("running", false);
    const event = envelope("ChangeSubmitted", { _tag: "ChangeSubmitted" });
    const exit = await deliver("probe-1", [event]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(sent).toEqual([
      {
        id: "probe-1",
        type: `change-${changeId}`,
        payload: Schema.encodeSync(EventEnvelope)(event),
      },
    ]);
  });

  it("[fan-out.waiting-route] an instance address reaches its own Workflow: a Probe's the Probe binding, a world check's the world-check binding, and no other Workflow waits", () => {
    const [probe, worldCheck] = [probes("running", false), probes("running", false)];
    const env = { PROBE: probe.workflow, WORLD_CHECK: worldCheck.workflow };
    expect(waitingWorkflowFor(env, "Probe")).toBe(probe.workflow);
    expect(waitingWorkflowFor(env, "KeelWorldCheck")).toBe(worldCheck.workflow);
    for (const name of ["Precheck", "KeelVerify", "keelworldcheck", ""])
      expect(waitingWorkflowFor(env, name)).toBeUndefined();
  });

  it("[fan-out.send-finished] an event an instance refuses is acknowledged once it has finished, and stays owed while it runs", async () => {
    const event = envelope("ChangeLanded", { _tag: "ChangeLanded" });
    const acknowledged: Record<string, boolean> = {};
    for (const status of ["complete", "errored", "terminated", "running", "waiting", "queued"])
      acknowledged[status] = Exit.isSuccess(await probes(status, true).deliver("p", [event]));
    expect(acknowledged).toEqual({
      complete: true,
      errored: true,
      terminated: true,
      running: false,
      waiting: false,
      queued: false,
    });
  });

  it("[fan-out.probe-start] a ConflictSuspected starts probe-<conflictId> at its subject; one with no subject key, or another event, starts nothing", () => {
    const key = "authz.permission-evaluation";
    const suspected = (subjectKey?: string) =>
      envelope(
        "ConflictSuspected",
        {
          _tag: "ConflictSuspected",
          conflictId,
          kind: "semantic",
          parties: [changeId],
          ...(subjectKey === undefined ? {} : { subjectKey }),
        },
        { kind: "conflict", id: conflictId },
      );
    expect(probeStart(suspected(key))).toEqual({
      id: `probe-${conflictId}`,
      params: { projectId, key, conflictId },
    });
    expect(probeStart(suspected())).toEqual({ skipped: expect.stringContaining(conflictId) });
    expect(probeStart(envelope("ChangeSubmitted", {}))).toMatchObject({
      skipped: expect.stringContaining("not ConflictSuspected"),
    });
  });

  it("[fan-out.deliver-start] a TrunkAdvanced starts deliver-<projectId>-<to> with its landed candidates once each, in group order; another event, or one naming no advance, starts nothing", () => {
    const to = "b".repeat(40);
    const first = makeId("cnd", ulid());
    const second = makeId("cnd", ulid());
    const landing = (candidateId: string) => ({
      changeId: makeId("chg", ulid()),
      commitSha: "c".repeat(40),
      candidateId,
      proofId: "proof",
    });
    const advanced = (to: string) =>
      envelope(
        "TrunkAdvanced",
        {
          _tag: "TrunkAdvanced",
          projectId,
          from: "a".repeat(40),
          to,
          groupId: "grp",
          landings: [landing(first), landing(first), landing(second)],
        },
        { kind: "trunk", id: projectId },
      );
    expect(deliverStart(advanced(to))).toEqual({
      id: `deliver-${projectId}-${to}`,
      params: { projectId, to, candidates: [first, second] },
    });
    // The id is the advance's, not the event's: a second event of the same advance names the same instance.
    expect(deliverStart(advanced(to))).toEqual(deliverStart(advanced(to)));
    expect(deliverStart(advanced("e".repeat(40)))).toMatchObject({
      id: `deliver-${projectId}-${"e".repeat(40)}`,
    });
    expect(deliverStart(advanced("not a sha"))).toEqual({
      skipped: expect.stringContaining("names no trunk advance"),
    });
    expect(deliverStart(envelope("ChangeSubmitted", {}))).toMatchObject({
      skipped: expect.stringContaining("not TrunkAdvanced"),
    });
  });
});
