import { env } from "cloudflare:workers";
import { makeId } from "@keeltown/core/kernel";
import { makeChangesMemory, makeInboxMemory, makeWorkspacePoolMemory } from "@keeltown/testing";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { BASE, type Fetch, seedAgent, tokenFor } from "./helpers.ts";

/**
 * MFP 0.2 at the work loop's edge, through the real HTTP doorway, auth gate
 * and handlers, over in-memory Changes: what an agent declares, revises and
 * relies on in 0.2 is what Keel tells back, and what does not read is refused
 * with the field that does not.
 */
function loop() {
  const changes = makeChangesMemory();
  const inbox = makeInboxMemory();
  const { app } = makeIsolate(
    env,
    isolateLayer(env, {
      changes: changes.layer,
      inbox: inbox.layer,
      notifier: inbox.notifier,
      workspacePool: makeWorkspacePoolMemory().layer,
    }),
  );
  const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
  return via;
}

interface Body {
  readonly result: {
    readonly change: {
      readonly id: string;
      readonly premises: readonly unknown[];
      readonly declaredEffects?: readonly unknown[];
    };
    readonly lease: { readonly id: string };
    readonly workspace: { readonly baseSha: string };
  };
  readonly premises: readonly unknown[];
  readonly declaredEffects?: readonly unknown[];
  readonly code: string;
  readonly issues: readonly {
    readonly path: readonly (string | number)[];
    readonly message: string;
  }[];
}

async function rest(via: Fetch, token: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  const response = await via(`${BASE}/v1${path}`, { ...init, headers });
  return { status: response.status, body: await response.json<Body>() };
}

const declare = (via: Fetch, token: string, key: string, body: object) =>
  rest(via, token, "/changes", {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify({ goal: "Gate deploys on the release team", footprint: [], ...body }),
  });

const ANCHOR = { path: "src/deploy/gate.ts", symbol: "gate", commit: "c".repeat(40) };
const SESSION = makeId("ses", ulid());

/** One premise per form the conversion reshapes: an authority list, a shape, a bound with its unit, and each citation. */
const premises = [
  {
    subject: "deploy.prod",
    predicate: "authority",
    relation: "at-most",
    value: ["release-team", "alice", "bob"],
    anchors: [ANCHOR],
  },
  {
    subject: "deploy.manifest",
    predicate: "shape",
    relation: "is",
    value: {
      type: "object",
      fields: [
        { name: "service", shape: { type: "string" }, optional: false },
        { name: "replicas", shape: { type: "array", items: { type: "number" } }, optional: true },
      ],
    },
  },
  {
    subject: "deploy.latency",
    predicate: "bound",
    relation: "at-most",
    value: 30,
    unit: "s",
    strength: "should",
    gloss: "A deploy finishes inside the change window",
  },
  {
    subject: "deploy.cache",
    predicate: "freshness",
    relation: "at-most",
    value: "per-request",
    scope: "env:prod",
    cites: [
      { kind: "message", ref: `${SESSION}/4` },
      { kind: "anchor", ...ANCHOR },
      { kind: "record", ref: "rec-1" },
    ],
  },
];
const effects = [
  { subject: "deploy.queue", predicate: "cardinality", relation: "is", value: "exactly-once" },
];

/** A premise as Keel serves it: its strength written out, `must` where none was given. */
const served = (premise: object) => ({ strength: "must", ...premise });

describe("MFP 0.2 at the work loop's edge", () => {
  it("[mfp.edge-worker] what an agent declares in 0.2 is what Keel tells back, on declare and on the change read, and a premise is retracted by echoing it", async () => {
    const via = loop();
    const token = await tokenFor(await seedAgent());
    const declared = await declare(via, token, "mfp-edge-0001", {
      premises,
      declaredEffects: effects,
    });
    expect(declared.status).toBe(201);
    const { change, lease } = declared.body.result;
    expect(change.premises).toEqual(premises.map(served));
    expect(change.declaredEffects).toEqual(effects);

    const read = await rest(via, token, `/changes/${change.id}`);
    expect(read.status).toBe(200);
    expect(read.body.premises).toEqual(premises.map(served));
    expect(read.body.declaredEffects).toEqual(effects);

    // The authority premise retracted as Keel told it, strength and all.
    const [authority] = read.body.premises;
    const revised = await rest(via, token, `/changes/${change.id}/revisions`, {
      method: "POST",
      headers: { "idempotency-key": "mfp-edge-0002", "keel-lease": lease.id, "if-match": '"1"' },
      body: JSON.stringify({ premisesRetracted: [authority] }),
    });
    expect(revised.status).toBe(200);
    expect(revised.body.result.change.premises).toEqual(premises.slice(1).map(served));
  });

  it("[mfp.edge-worker] what does not read in 0.2 is refused at the field, never repaired: a bound with no unit, an ordering of a subject to itself, a cited tool result", async () => {
    const via = loop();
    const token = await tokenFor(await seedAgent());
    const refused = async (premise: object) => {
      const answered = await declare(via, token, `mfp-edge-${ulid()}`, { premises: [premise] });
      expect(answered.status).toBe(400);
      expect(answered.body.code).toBe("request.invalid");
      return answered.body.issues.map((issue) => issue.path.slice(0, 2));
    };
    const { unit: _, ...unitless } = premises[2] ?? {};
    expect(await refused(unitless)).toContainEqual(["premises", 0]);
    expect(
      await refused({
        subject: "deploy.start",
        predicate: "ordering",
        relation: "before",
        value: "deploy.start",
      }),
    ).toContainEqual(["premises", 0]);
    expect(
      await refused({ ...premises[3], cites: [{ kind: "tool-result", ref: "call-1" }] }),
    ).toContainEqual(["premises", 0]);
  });

  it("[mfp.edge-worker] an anchor with no commit means the driver's working commit: on rely and revise the change's base, on a premise added or echoed to retract it and on a declared effect, and on declare, where Keel has none yet, it is refused with what to do", async () => {
    const via = loop();
    const token = await tokenFor(await seedAgent());
    const unpinned = { path: "src/deploy/gate.ts", symbol: "gate" };
    const onDeclare = await declare(via, token, "mfp-edge-0101", {
      premises: [{ ...premises[3], cites: [{ kind: "anchor", ...unpinned }] }],
    });
    expect(onDeclare.status).toBe(400);
    expect(onDeclare.body.issues).toContainEqual({
      path: ["premises", 0],
      message: expect.stringContaining("add the premise with rely once declared"),
    });

    const declared = await declare(via, token, "mfp-edge-0102", { premises: [] });
    expect(declared.status).toBe(201);
    const { change, lease, workspace } = declared.body.result;
    const pinned = { ...unpinned, commit: workspace.baseSha };
    const relied = await rest(via, token, `/changes/${change.id}/premises`, {
      method: "POST",
      headers: { "idempotency-key": "mfp-edge-0103", "keel-lease": lease.id },
      body: JSON.stringify({ premise: { ...premises[0], anchors: [unpinned] } }),
    });
    expect(relied).toMatchObject({ status: 200 });
    expect(relied.body.result.change.premises).toEqual([
      served({ ...premises[0], anchors: [pinned] }),
    ]);
    const revised = await rest(via, token, `/changes/${change.id}/revisions`, {
      method: "POST",
      headers: { "idempotency-key": "mfp-edge-0104", "keel-lease": lease.id, "if-match": '"2"' },
      body: JSON.stringify({
        premisesAdded: [{ ...premises[3], cites: [{ kind: "anchor", ...unpinned }] }],
      }),
    });
    expect(revised.status).toBe(200);
    expect(revised.body.result.change.premises).toContainEqual(
      served({ ...premises[3], cites: [{ kind: "anchor", ...pinned }] }),
    );

    // The same input echoed retracts it: its anchor with no commit is read at the base again.
    const echoed = await rest(via, token, `/changes/${change.id}/revisions`, {
      method: "POST",
      headers: { "idempotency-key": "mfp-edge-0105", "keel-lease": lease.id, "if-match": '"3"' },
      body: JSON.stringify({
        premisesRetracted: [{ ...premises[3], cites: [{ kind: "anchor", ...unpinned }] }],
      }),
    });
    expect(echoed.status).toBe(200);
    expect(echoed.body.result.change.premises).toEqual([
      served({ ...premises[0], anchors: [pinned] }),
    ]);

    // A revision whose one anchor with no commit is on a declared effect reads the change too.
    const effected = await rest(via, token, `/changes/${change.id}/revisions`, {
      method: "POST",
      headers: { "idempotency-key": "mfp-edge-0106", "keel-lease": lease.id, "if-match": '"4"' },
      body: JSON.stringify({ declaredEffects: [{ ...effects[0], anchors: [unpinned] }] }),
    });
    expect(effected.status).toBe(200);
    expect(effected.body.result.change.declaredEffects).toEqual([
      { ...effects[0], anchors: [pinned] },
    ]);
  });
});
