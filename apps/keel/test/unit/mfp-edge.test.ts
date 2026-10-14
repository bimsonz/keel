import { describe, expect, it } from "@effect/vitest";
import { Change, Preflight, Proposition, SubjectKey } from "@keeltown/core/domain/coordination";
import { AgentId, ChangeId, CommitSha, Instant, makeId, WorkspaceId } from "@keeltown/core/kernel";
import { Result, Schema } from "effect";
import { ulid } from "ulid";
import {
  abandonOk,
  adoptOk,
  committedOk,
  declareOk,
  type Input,
  nearbyOk,
  rebaseOk,
  relyOk,
  reviseOk,
  reliesAgainstChange,
  relyInput,
  relying,
  retractions,
  reviseInput,
  revising,
} from "../../src/adapters/driving/http/work-loop.ts";

const proposition = Schema.decodeUnknownSync(Proposition);
const CHANGE = ChangeId.make(makeId("chg", ulid()));
const OTHER = makeId("chg", ulid());

const perRequest = proposition({
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
});
const perSession = proposition({
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "is",
  value: "per-session",
});
/** Stored before 0.2: a writer with a space in it, which 0.2's `Writer` cannot hold. */
const spacedWriter = proposition({
  subject: "deploy.prod",
  predicate: "authority",
  relation: "at-most",
  value: "release team,alice",
});

const preflight = (contradictions: readonly object[], index: number) =>
  Schema.decodeUnknownSync(Preflight)({
    neighbours: [],
    contradictions,
    precedents: [],
    suggestedMove: "coordinate",
    basis: { _tag: "contradiction", index },
  });

/** Held by another change, with a strength of its own. */
const shouldPerSession = proposition({ ...perSession, strength: "should" });

const BASE = CommitSha.make("b".repeat(40));
const AGENT = AgentId.make(makeId("agt", ulid()));

/** A change holding one premise 0.2 can tell and one it cannot. */
const change = Schema.decodeUnknownSync(Change)({
  id: CHANGE,
  agentId: AGENT,
  origin: "agent",
  state: "working",
  intent: {
    revision: 1,
    goal: "Gate deploys",
    footprint: [],
    premises: [spacedWriter, perRequest],
  },
  lease: { id: makeId("lse", ulid()), agentId: AGENT, renewedAt: 0, state: "active" },
  createdAt: 0,
  baseSha: BASE,
});
const proceed = Schema.decodeUnknownSync(Preflight)({
  neighbours: [],
  contradictions: [],
  precedents: [],
  suggestedMove: "proceed",
});
const grant = {
  workspaceId: WorkspaceId.make(makeId("wsp", ulid())),
  remote: "https://keel.test/ws.git",
  token: "t",
  expiresAt: Instant(0),
  baseSha: BASE,
  repo: { namespace: "keel-ws-00", name: "ws" },
};

/** The change and notices of an answer that carries one: these never refuse. */
const envelopeOf = (body: object) => {
  const result: unknown = Reflect.get(body, "result");
  const premises: unknown = Reflect.get(Object(Reflect.get(Object(result), "change")), "premises");
  return { premises, notices: Reflect.get(body, "notices") };
};

/** A nearby answer's envelope: a preflight read never refuses. */
const answered = (changeId: ChangeId, read: Preflight) => {
  const { body } = nearbyOk(changeId, read);
  if (!("result" in body)) throw new Error("nearby answered a problem");
  return body;
};

/** A revision as the doorway hands it on, adding whatever premises it is given. */
const revise = (premisesAdded: readonly object[]) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- premises the doorway's validator refuses, handed to the mapper behind it
  ({
    changeId: CHANGE,
    "keel-lease": makeId("lse", ulid()),
    "idempotency-key": "revise-0001",
    "if-match": '"1"',
    premisesAdded,
  }) as unknown as Input<"revise">;

/** A rely as the doorway hands it on, with whatever premise it is given. */
const rely = (premise: object) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a premise the doorway's validator refuses, handed to the mapper behind it
  ({
    changeId: CHANGE,
    "keel-lease": makeId("lse", ulid()),
    "idempotency-key": "rely-0001",
    premise,
  }) as unknown as Input<"rely">;

describe("MFP 0.2 at the edge, mapped", () => {
  it("[mfp.edge-view] a stored proposition with no 0.2 form is left out with a notice, never repaired, and the move's basis follows its contradiction", () => {
    const untold = { premise: spacedWriter, with: perSession, holder: OTHER, withRole: "effect" };
    const told = { premise: perRequest, with: perSession, holder: OTHER, withRole: "effect" };
    // Another change's premise is told as a premise, its strength kept.
    const held = {
      premise: perRequest,
      with: shouldPerSession,
      holder: OTHER,
      withRole: "premise",
    };
    // And one whose other side has no 0.2 form is left out too, named for its holder.
    const otherUntold = {
      premise: perRequest,
      with: spacedWriter,
      holder: OTHER,
      withRole: "premise",
    };
    const body = answered(CHANGE, preflight([untold, told, held, otherUntold], 1));
    expect(body.result.preflight.contradictions).toEqual([
      {
        premise: { ...perRequest, strength: "must" },
        with: perSession,
        holder: OTHER,
        withRole: "effect",
      },
      {
        premise: { ...perRequest, strength: "must" },
        with: { ...perSession, strength: "should" },
        holder: OTHER,
        withRole: "premise",
      },
    ]);
    expect(body.result.preflight.basis).toEqual({ _tag: "contradiction", index: 0 });
    expect(body.notices).toEqual([
      expect.objectContaining({
        kind: "PropositionUntellable",
        ref: `change:${CHANGE}`,
        detail: expect.stringContaining("deploy.prod authority at-most release team,alice"),
      }),
      expect.objectContaining({ kind: "PropositionUntellable", ref: OTHER }),
    ]);
    // A move resting on the one left out is told with no basis, not another's index.
    expect(answered(CHANGE, preflight([untold, told], 0)).result.preflight).not.toHaveProperty(
      "basis",
    );
  });

  it("[mfp.edge-view] every envelope that serves a change names its untellable premise in its notices and serves the rest", () => {
    const envelopes = {
      declare: declareOk({ change, preflight: proceed, workspace: grant }).body,
      rebase: rebaseOk({ change, ref: "refs/heads/keel/trunk", base: BASE }).body,
      commit: committedOk({
        change,
        commit: { commitSha: BASE, tree: "t", changed: 1 },
        parent: BASE,
      }).body,
      revise: reviseOk({ change, preflight: proceed }).body,
      rely: relyOk({ change, preflight: proceed }).body,
      adopt: adoptOk({ change }).body,
      abandon: abandonOk(change).body,
    };
    for (const [name, body] of Object.entries(envelopes)) {
      const envelope = envelopeOf(body);
      expect([name, envelope.premises]).toEqual([name, [{ ...perRequest, strength: "must" }]]);
      expect([name, envelope.notices]).toEqual([
        name,
        [expect.objectContaining({ kind: "PropositionUntellable", ref: `change:${CHANGE}` })],
      ]);
    }
  });

  it("[mfp.edge-retract] a retraction names the stored premise whose 0.2 form it echoes, an older spelling included; each one echoed is retracted, and one that matches none retracts nothing", () => {
    const stored = [proposition({ ...spacedWriter, value: "release-team, alice" }), perRequest];
    const retracted = [
      {
        subject: SubjectKey.make("deploy.prod"),
        predicate: "authority" as const,
        relation: "at-most" as const,
        value: ["release-team", "alice"],
        strength: "must" as const,
      },
      {
        subject: SubjectKey.make("deploy.other"),
        predicate: "freshness" as const,
        relation: "is" as const,
        value: "static",
      },
      {
        subject: SubjectKey.make("authz.permission-evaluation"),
        predicate: "freshness" as const,
        relation: "at-most" as const,
        value: "per-request",
        strength: "must" as const,
      },
    ];
    expect(retractions(stored, retracted)).toEqual([stored[0], stored[1]]);
  });

  it("[mfp.edge-input] rely holds its premise through 0.2 itself, without the doorway's validator in front: a bound with no unit is refused at the premise, and an anchor with no commit is held at the change's base or refused where it has none", () => {
    // The doorway's validator refuses this first; the mapper must refuse it too.
    const bound = { subject: "deploy.latency", predicate: "bound", relation: "at-most", value: 30 };
    const refused = relyInput(rely(bound));
    expect(Result.isFailure(refused)).toBe(true);
    expect(Result.isFailure(refused) ? refused.failure.map((i) => i.path[0]) : []).toContain(
      "premise",
    );
    const refusedOnRevise = reviseInput(revise([bound]));
    expect(
      Result.isFailure(refusedOnRevise)
        ? refusedOnRevise.failure.map((i) => i.path.slice(0, 2))
        : [],
    ).toContainEqual(["premisesAdded", 0]);
    // Held against a change with no base, an added premise's anchor with no commit is refused at it too.
    const unbasedRevision = revising(
      undefined,
      [],
      Result.getOrThrow(
        reviseInput(revise([{ ...bound, unit: "s", anchors: [{ path: "src/deploy/gate.ts" }] }])),
      ),
    );
    expect(Result.isFailure(unbasedRevision) ? unbasedRevision.failure : []).toEqual([
      { path: ["premisesAdded", 0], message: expect.stringContaining("name the commit") },
    ]);
    const request = Result.getOrThrow(relyInput(rely({ ...bound, unit: "s" })));
    expect(Result.getOrThrow(relying(undefined, request)).premise).toEqual(
      proposition({ ...bound, unit: "s" }),
    );

    const anchored = Result.getOrThrow(
      relyInput(rely({ ...bound, unit: "s", anchors: [{ path: "src/deploy/gate.ts" }] })),
    );
    expect(reliesAgainstChange(anchored)).toBe(true);
    expect(reliesAgainstChange(request)).toBe(false);
    const base = CommitSha.make("b".repeat(40));
    expect(Result.getOrThrow(relying(base, anchored)).premise.anchors).toEqual([
      { path: "src/deploy/gate.ts", commit: base },
    ]);
    const unbased = relying(undefined, anchored);
    expect(Result.isFailure(unbased) ? unbased.failure : []).toEqual([
      { path: ["premise"], message: expect.stringContaining("name the commit") },
    ]);
  });
});
