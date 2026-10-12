// The fan-out's Probe cases over a fake Workflow binding: what the pool cannot
// show, because miniflare takes an event for a finished instance without
// throwing, while the platform may throw.
import { ConflictId, EventEnvelope, makeId } from "@keeltown/core/kernel";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type InstanceEvents,
  probeStart,
  sendToInstance,
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
  return { sent, deliver };
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
});
