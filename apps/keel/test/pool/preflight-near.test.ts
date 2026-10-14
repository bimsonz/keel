// A preflight reads only the live changes near its intent: a real Change DO,
// declaring through RPC and read back through the deployed fetch handler,
// against a project whose real Project DO holds many unrelated live changes,
// folded into it through its `receive` as the fan-out delivers them.
import { env, exports } from "cloudflare:workers";
import { Proposition } from "@keeltown/core/domain/coordination";
import { type ChangeId, EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { changeUnderTest, ok } from "./change-harness.ts";
import { BASE, drainAfter, drainOutbox, seedAgent, tokenFor } from "./helpers.ts";

/** How many live changes of the project are nowhere near the change under test. */
const UNRELATED = 200;

const freshPerRequest = Schema.decodeUnknownSync(Proposition)({
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
});

let seq = 0;
/** A change's IntentDeclared, as the fan-out delivers it to the project's index. */
function declared(
  changeId: ChangeId,
  intent: {
    readonly footprint: readonly { readonly path: string; readonly op: "edit" }[];
    readonly premises?: readonly object[];
    readonly declaredEffects?: readonly object[];
  },
) {
  seq += 1;
  return Schema.encodeSync(EventEnvelope)(
    Schema.decodeUnknownSync(EventEnvelope)({
      eventId: makeId("evt", ulid()),
      type: "IntentDeclared",
      entity: { kind: "change", id: changeId },
      seq: 1,
      at: Date.now(),
      dedupeKey: `change:${changeId}/declare-${seq}/IntentDeclared#1`,
      affected: [],
      notified: [],
      payload: {
        _tag: "IntentDeclared",
        changeId,
        agentId: makeId("agt", ulid()),
        origin: "agent",
        revision: 1,
        goal: "something else",
        premises: [],
        leaseId: makeId("lse", ulid()),
        ...intent,
      },
    }),
  );
}

describe("[t694.reads-near-rows] a preflight reads only the rows near its intent", () => {
  it("[t694.reads-near-rows] among 200 unrelated live changes, the declare and the nearby over REST name the 3 near ones and say they compared 3", async () => {
    const projectId: ProjectId = makeId("prj", ulid());
    const token = await tokenFor(await seedAgent({ projectId }));
    const project = drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));

    // Each unrelated change works on a subject and a directory of its own.
    const unrelated = Array.from({ length: UNRELATED }, (_, i) =>
      declared(makeId("chg", ulid()), {
        footprint: [{ path: `pkg/zone${i}/**`, op: "edit" }],
        premises: [
          { ...Schema.encodeSync(Proposition)(freshPerRequest), subject: `zone${i}.cache` },
        ],
      }),
    );
    // Near the change: one relies on its subject, one changes a sibling, one edits under its footprint.
    const [same, sibling, underFootprint] = [
      makeId("chg", ulid()),
      makeId("chg", ulid()),
      makeId("chg", ulid()),
    ];
    const near = [
      declared(same, {
        footprint: [],
        premises: [Schema.encodeSync(Proposition)(freshPerRequest)],
      }),
      declared(sibling, {
        footprint: [],
        declaredEffects: [
          { ...Schema.encodeSync(Proposition)(freshPerRequest), subject: "authz.audit-log" },
        ],
      }),
      declared(underFootprint, {
        footprint: [{ path: "src/authz/cache.ts", op: "edit" }],
        premises: [
          { ...Schema.encodeSync(Proposition)(freshPerRequest), subject: "search.ranking" },
        ],
      }),
    ];
    await project.receive([...unrelated.slice(0, 100), ...near, ...unrelated.slice(100)]);

    // The change under test relies on authz.permission-evaluation and edits src/authz/**.
    const change = await changeUnderTest(projectId, "project");
    const answer = ok(await change.declare("declare-near", { premises: [freshPerRequest] }));
    await drainOutbox(change.stub);
    const response = await exports.default.fetch(`${BASE}/v1/changes/${change.changeId}/nearby`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json<{
      ok: boolean;
      result: { preflight: { neighbours: { changeId: string }[]; compared?: unknown } };
    }>();

    const expected = [same, sibling, underFootprint].toSorted((a, b) => (a < b ? -1 : 1));
    expect(answer.preflight.neighbours.map((found) => found.changeId)).toEqual(expected);
    expect(answer.preflight.compared).toEqual({ changes: 3, subjects: 1 });
    expect(response.status).toBe(200);
    expect(body.result.preflight.neighbours.map((found) => found.changeId)).toEqual(expected);
    expect(body.result.preflight.compared).toEqual({ changes: 3, subjects: 1 });
  });
});
