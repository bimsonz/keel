// Preflight across real objects: each change is a real Change DO whose
// preflight reads its project's live-change index on the real Project DO, and
// a change's IntentDeclared reaches that index through the fan-out, as in
// production. A change is drained before the next declares, so the index has
// heard it.
import { Proposition } from "@keeltown/core/domain/coordination";
import { makeId, type ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { changeUnderTest, ok } from "./change-harness.ts";
import { drainOutbox } from "./helpers.ts";

/** S1's pair: A relies on revocation taking effect per request; B's cache makes it per session. */
const freshPerRequest = Schema.decodeUnknownSync(Proposition)({
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
});
const cachedPerSession = Schema.decodeUnknownSync(Proposition)({
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "is",
  value: "per-session",
});

/** Changes of one fresh project, each reading the project's real index. */
function liveProject() {
  const projectId: ProjectId = makeId("prj", ulid());
  return { projectId, change: () => changeUnderTest(projectId, "project") };
}

describe("[b21.contradiction] preflight through the Project DO's index", () => {
  it("[b21.contradiction] B's declared effect meets A's premise, held on another Change DO", async () => {
    const { change } = liveProject();
    const a = await change();
    const first = ok(await a.declare("declare-a", { premises: [freshPerRequest] }));
    await drainOutbox(a.stub);
    const b = await change();
    const second = ok(await b.declare("declare-b", { declaredEffects: [cachedPerSession] }));

    expect(first.preflight).toMatchObject({ contradictions: [], suggestedMove: "proceed" });
    expect(second.preflight.contradictions).toEqual([
      { premise: freshPerRequest, with: cachedPerSession, holder: a.changeId, withRole: "effect" },
    ]);
    expect(second.preflight).toMatchObject({
      suggestedMove: "refine",
      basis: { _tag: "contradiction", index: 0 },
    });
    expect(second.change.state).toBe("working");
  });

  it("[b21.contradiction] A's premise meets B's declared effect when B declared first, and A sequences", async () => {
    const { change } = liveProject();
    const b = await change();
    ok(await b.declare("declare-b", { declaredEffects: [cachedPerSession] }));
    await drainOutbox(b.stub);
    const a = await change();
    const second = ok(await a.declare("declare-a", { premises: [freshPerRequest] }));

    // `holder` names the premise's holder, A itself; B is the neighbour whose effect it meets.
    expect(second.preflight.contradictions).toEqual([
      { premise: freshPerRequest, with: cachedPerSession, holder: a.changeId, withRole: "effect" },
    ]);
    expect(second.preflight.neighbours.map((found) => found.changeId)).toEqual([b.changeId]);
    expect(second.preflight).toMatchObject({
      suggestedMove: "sequence",
      basis: { _tag: "contradiction", index: 0 },
    });
  });
});
