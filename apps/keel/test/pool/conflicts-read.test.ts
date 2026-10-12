// A project's conflicts read through the deployed fetch handler. The first
// case is real end to end: two Change DOs declare, the Subject DO's fallout
// opens the conflict, its probe is drafted and run through the ledger, and the
// events reach the real Projector over the fan-out. The audience cases place
// a conflict's event on the Projector as an outbox delivers it, in a real
// Project DO whose visibility a maintainer changes.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { conflictIdOf, worldCheckRan } from "@keeltown/core/application/coordination";
import { Proposition } from "@keeltown/core/domain/coordination";
import { type EventEnvelope, EventEnvelope as Envelope, makeId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { changeUnderTest, ok } from "./change-harness.ts";
import {
  BASE,
  drainOutbox,
  OTHER_ORG,
  seedAgent,
  seedForeignAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";
import { inertProbe } from "./inert-probe.ts";
import { admitted, hash, LEAF, probeIdOf, subjectOf } from "./probe-harness.ts";
import { project } from "./project-harness.ts";

const WAIT = { timeout: 15_000, interval: 50 };

const relied = Schema.decodeUnknownSync(Proposition)({
  subject: LEAF,
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
});
const cached = Schema.decodeUnknownSync(Proposition)({
  subject: LEAF,
  predicate: "freshness",
  relation: "is",
  value: "per-session",
});

interface Named {
  readonly id: string;
  readonly label?: string;
}
interface Row {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly state: string;
  readonly parties: readonly string[];
  readonly subject?: string;
  readonly predicate?: string;
  readonly probe?: Named & { readonly state: string };
  readonly guard?: Named;
}
interface ListBody {
  readonly items: readonly Row[];
  readonly nextCursor?: string;
  readonly totals: { readonly open: number; readonly settled: number };
}
interface Side {
  readonly changeId: string;
  readonly role: string;
  readonly proposition: { readonly relation: string; readonly value: unknown };
  readonly told?: { readonly how: string };
}
interface DetailBody extends Row {
  readonly origin?: string;
  readonly proven?: { readonly _tag: string; readonly probeId?: string };
  readonly sides?: { readonly holder: Side; readonly other: Side };
  readonly matrix: readonly {
    readonly world: string;
    readonly probe: readonly { readonly run: number; readonly outcome: string }[];
    readonly checks: readonly { readonly check: string; readonly outcome: string }[];
  }[];
}
interface ProblemBody {
  readonly code: string;
  readonly detail?: string;
}

/** A GET through the doorway, with a bearer token or with none. */
const get = (path: string, token?: string) =>
  worker(
    `${BASE}${path}`,
    token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
  );

/** Events arrive at the Projector as an outbox delivers them, in one batch. */
const arrive = async (...events: EventEnvelope[]) => {
  const projector = env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));
  await projector.receive(events.map((event) => Schema.encodeSync(Envelope)(event)));
};

/** The status and the problem's code and detail, which is all a refusal may differ by. */
const refusal = async (response: Response) => {
  const body = await response.json<ProblemBody>();
  return { status: response.status, code: body.code, detail: body.detail };
};

describe("[b23.conflicts-read] a project's conflicts over REST, from the Projector's fold", () => {
  it("[b23.conflicts-read] a conflict opened by fallout and proven through the ledger is listed with its labels and totals, and read with its sides, its five-world matrix, its probe and its guard", async () => {
    await using probes = await inertProbe();
    const projectId = makeId("prj", ulid());
    const [a, b] = [
      await changeUnderTest(projectId, "project"),
      await changeUnderTest(projectId, "project"),
    ];
    ok(await a.declare(`declare-${a.changeId}`, { premises: [relied] }));
    await drainOutbox(a.stub);
    ok(await b.declare(`declare-${b.changeId}`, { declaredEffects: [cached] }));
    await drainOutbox(b.stub);
    const conflictId = conflictIdOf(projectId, {
      premise: { holder: a.changeId, proposition: relied },
      effect: { changeId: b.changeId, proposition: cached },
    });
    await vi.waitFor(async () => expect(await probes.get()).toHaveLength(1), WAIT);

    await admitted(projectId, conflictId);
    const counts = { passed: 41, failed: 1, skipped: 0 };
    await runInDurableObject(subjectOf(projectId), async (instance: SubjectDO) => {
      await instance["runtime"].runPromise(
        worldCheckRan(projectId, {
          conflictId,
          world: "AB",
          check: `suite:${b.changeId}`,
          run: 1,
          outcome: "fail",
          counts,
        }),
      );
      await instance["armFlush"]();
    });
    await drainOutbox(subjectOf(projectId));
    const probeId = await probeIdOf(projectId, conflictId);
    const token = await tokenFor(await seedAgent({ projectId }));

    const list = await vi.waitFor(async () => {
      const response = await get("/v1/conflicts", token);
      expect(response.status).toBe(200);
      const body = await response.json<ListBody>();
      expect(body.items.map((row) => [row.id, row.state, row.guard?.label])).toEqual([
        [conflictId, "proven", "G-1"],
      ]);
      return body;
    }, WAIT);
    expect(list.items).toMatchObject([
      {
        id: conflictId,
        label: "C-1",
        kind: "semantic",
        state: "proven",
        parties: [a.changeId, b.changeId],
        subject: LEAF,
        predicate: "freshness",
        probe: { id: probeId, label: "P-1", state: "admitted" },
      },
    ]);
    expect(list.totals).toEqual({ open: 1, settled: 0 });
    expect(list.nextCursor).toBeUndefined();

    const settled = await (await get("/v1/conflicts?open=false", token)).json<ListBody>();
    expect(settled).toEqual({ items: [], totals: { open: 1, settled: 0 } });
    const ofB = await (await get(`/v1/conflicts?changeId=${b.changeId}`, token)).json<ListBody>();
    expect(ofB.items.map((row) => row.id)).toEqual([conflictId]);
    expect(await refusal(await get("/v1/conflicts?cursor=first", token))).toMatchObject({
      status: 400,
      code: "request.invalid",
    });

    const detail = await vi.waitFor(async () => {
      const response = await get(`/v1/conflicts/${conflictId}`, token);
      expect(response.status).toBe(200);
      const body = await response.json<DetailBody>();
      expect(body.matrix.at(4)?.checks).toHaveLength(1);
      // Each party's Change DO heard the proof and, under the default policy, noted it.
      expect([body.sides?.holder.told?.how, body.sides?.other.told?.how]).toEqual([
        "noted",
        "noted",
      ]);
      return body;
    }, WAIT);
    expect(detail).toMatchObject({
      id: conflictId,
      label: "C-1",
      state: "proven",
      origin: "fallout",
      proven: { _tag: "probe", probeId },
      sides: {
        holder: {
          changeId: a.changeId,
          role: "premise",
          proposition: { relation: "at-most", value: "per-request" },
        },
        other: {
          changeId: b.changeId,
          role: "effect",
          proposition: { relation: "is", value: "per-session" },
        },
      },
      probe: { id: probeId, label: "P-1", state: "admitted", attempts: 1, bundleHash: hash("7") },
      guard: { label: "G-1", state: "admitted", probeId, runs: 3 },
    });
    expect(detail.matrix.map((row) => row.world)).toEqual(["trunk", "A-noop", "A", "B", "AB"]);
    expect(detail.matrix.map((row) => row.probe.map((run) => run.outcome))).toEqual([
      ["pass", "pass", "pass"],
      ["fail", "fail", "fail"],
      ["pass", "pass", "pass"],
      ["n/a", "n/a", "n/a"],
      ["fail", "fail", "fail"],
    ]);
    expect(detail.matrix.map((row) => row.checks)).toMatchObject([
      [],
      [],
      [],
      [],
      [{ check: `suite:${b.changeId}`, run: 1, outcome: "fail", counts }],
    ]);
  });
});

describe("[b23.conflicts-audience] who may read a project's conflicts", () => {
  it("[b23.conflicts-audience] a private project's conflicts are read by its own agent and by a member of its org; outside the org the conflict is the 404 of one that does not exist, and another project's agent in the org is refused", async () => {
    const p = await project();
    const conflictId = makeId("cfl", ulid());
    await arrive(p.events.suspected(conflictId, makeId("chg", ulid()), makeId("chg", ulid())));
    const own = await tokenFor(await seedAgent({ projectId: p.projectId }));
    const member = (await seedUser(uniqueHandle("member"))).token;
    const neighbour = await tokenFor(await seedAgent({ projectId: makeId("prj", ulid()) }));
    const outsider = await tokenFor(await seedForeignAgent());
    const visitor = (await seedUser(uniqueHandle("visitor"), { org: OTHER_ORG })).token;
    const nowhere = makeId("prj", ulid());
    const one = (projectId: string, id: string = conflictId) =>
      `/v1/conflicts/${id}?project=${projectId}`;

    expect((await get(one(p.projectId), own)).status).toBe(200);
    expect((await get(`/v1/conflicts/${conflictId}`, own)).status).toBe(200);
    expect((await get(one(p.projectId), member)).status).toBe(200);
    const hidden = await refusal(await get(one(p.projectId)));
    expect(hidden).toEqual({
      status: 404,
      code: "conflict.not_found",
      detail: `No conflict ${conflictId} in that project.`,
    });
    // A project that does not exist, a private one seen from outside its org, a
    // project that has no such conflict and a caller that names none: one answer.
    expect([
      await refusal(await get(one(nowhere))),
      await refusal(await get(one(p.projectId), outsider)),
      await refusal(await get(one(p.projectId), visitor)),
      await refusal(await get(`/v1/conflicts/${conflictId}`, neighbour)),
      await refusal(await get(`/v1/conflicts/${conflictId}`, member)),
      await refusal(await get(`/v1/conflicts/${conflictId}`)),
    ]).toEqual([hidden, hidden, hidden, hidden, hidden, hidden]);
    expect(await refusal(await get(one(p.projectId, makeId("cfl", ulid())), own))).toMatchObject({
      status: 404,
      code: "conflict.not_found",
    });
    // Inside the org the project is no secret: another project's agent is told why it is refused.
    const refused = {
      status: 403,
      code: "auth.forbidden",
      detail: "Refused: foreign-project.",
    };
    expect(await refusal(await get(one(p.projectId), neighbour))).toEqual(refused);

    const listHidden = await refusal(await get(`/v1/conflicts?project=${p.projectId}`));
    expect(listHidden).toMatchObject({ status: 404, code: "resource.not_found" });
    expect([
      await refusal(await get(`/v1/conflicts?project=${nowhere}`)),
      await refusal(await get(`/v1/conflicts?project=${p.projectId}`, outsider)),
      await refusal(await get(`/v1/conflicts?project=${p.projectId}`, visitor)),
      await refusal(await get("/v1/conflicts")),
    ]).toEqual([listHidden, listHidden, listHidden, listHidden]);
    expect(await refusal(await get(`/v1/conflicts?project=${p.projectId}`, neighbour))).toEqual(
      refused,
    );
    const listed = await (await get("/v1/conflicts", own)).json<ListBody>();
    expect(listed.items.map((row) => row.id)).toEqual([conflictId]);
    const asMember = await get(`/v1/conflicts?project=${p.projectId}`, member);
    expect((await asMember.json<ListBody>()).items.map((row) => row.id)).toEqual([conflictId]);
    // An agent that names no project reads its own, which has no conflict.
    expect((await (await get("/v1/conflicts", neighbour)).json<ListBody>()).items).toEqual([]);
  });

  it("[b23.conflicts-audience] once the project is public, its conflicts are read without a token, by a user outside its org and by another project's agent", async () => {
    const p = await project();
    const conflictId = makeId("cfl", ulid());
    const [holder, other] = [makeId("chg", ulid()), makeId("chg", ulid())];
    await arrive(p.events.suspected(conflictId, holder, other));
    const neighbour = await tokenFor(await seedAgent({ projectId: makeId("prj", ulid()) }));
    const outsider = await tokenFor(await seedForeignAgent());
    const visitor = (await seedUser(uniqueHandle("visitor"), { org: OTHER_ORG })).token;
    expect((await get(`/v1/conflicts?project=${p.projectId}`)).status).toBe(404);
    await p.open();

    const list = await get(`/v1/conflicts?project=${p.projectId}`);
    const detail = await get(`/v1/conflicts/${conflictId}?project=${p.projectId}`);
    expect([list.status, detail.status]).toEqual([200, 200]);
    expect(
      await Promise.all(
        [neighbour, outsider, visitor].map(async (token) => [
          (await get(`/v1/conflicts?project=${p.projectId}`, token)).status,
          (await get(`/v1/conflicts/${conflictId}?project=${p.projectId}`, token)).status,
        ]),
      ),
    ).toEqual([
      [200, 200],
      [200, 200],
      [200, 200],
    ]);
    expect(await list.json<ListBody>()).toMatchObject({
      items: [{ id: conflictId, label: "C-1", state: "suspected", parties: [holder, other] }],
      totals: { open: 1, settled: 0 },
    });
    expect(await detail.json<DetailBody>()).toMatchObject({
      id: conflictId,
      sides: { holder: { changeId: holder }, other: { changeId: other } },
    });
    // A conflict the public project does not have is still a 404.
    expect(
      await refusal(await get(`/v1/conflicts/${makeId("cfl", ulid())}?project=${p.projectId}`)),
    ).toMatchObject({ status: 404, code: "conflict.not_found" });
  });
});
