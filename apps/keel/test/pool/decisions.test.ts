import { env } from "cloudflare:workers";
import { type EventEnvelope, EventEnvelope as Envelope, makeId } from "@keeltown/core/kernel";
import { PORTS, ruledConflict } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { DecisionsRpc } from "../../src/adapters/driven/do-rpc/decisions.ts";
import type { ProblemBody } from "../../src/adapters/driving/http/problems.ts";
import {
  BASE,
  OTHER_ORG,
  seedAgent,
  seedForeignAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";
import { project } from "./project-harness.ts";

/** The one Projector every object's outbox delivers to. */
const projector = () => env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));

/** Events arrive at the Projector as an outbox delivers them, in one batch. */
const arrive = async (...events: EventEnvelope[]) => {
  await projector().receive(events.map((event) => Schema.encodeSync(Envelope)(event)));
};

// The real index passes the same contract as the in-memory one, folded in the real receipt.
PORTS.Decisions.contract("Projector DO over RPC", () => ({
  layer: DecisionsRpc(projector),
  arrive: (event) => Effect.promise(() => arrive(event)),
}));

/** A GET through the doorway, with a bearer token or with none. */
const get = (path: string, token?: string) =>
  worker(
    `${BASE}${path}`,
    token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
  );

/** The status and the problem's code and detail, which is all a refusal may differ by. */
const refusal = async (response: Response) => {
  const body = await response.json<ProblemBody>();
  return { status: response.status, code: body.code, detail: body.detail };
};

type DecisionBody = { readonly id: string };
type DecisionPage = { readonly items: readonly DecisionBody[] };

describe("[memory.decisions-http] a project's decisions over REST, from the Projector's index", () => {
  it("[memory.decisions-http] a private project's decision is read with what it settled by the project's own agent and a member of its org, listed by subject, and outside the org is the 404 of one that does not exist until the project is public", async () => {
    const p = await project();
    const ruled = ruledConflict(p.events);
    await arrive(...ruled.conflict, ruled.recorded("premise-holds"), ruled.resolved([ruled.other]));
    const own = await tokenFor(await seedAgent({ projectId: p.projectId }));
    const member = (await seedUser(uniqueHandle("member"))).token;
    const neighbour = await tokenFor(await seedAgent({ projectId: makeId("prj", ulid()) }));
    const outsider = await tokenFor(await seedForeignAgent());
    const visitor = (await seedUser(uniqueHandle("visitor"), { org: OTHER_ORG })).token;
    const one = `/v1/decisions/${ruled.decisionId}`;

    const read = await get(one, own);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      id: ruled.decisionId,
      label: expect.stringMatching(/^D-[1-9]\d*$/),
      option: "premise-holds",
      summary: "The premise holds",
      decidedAt: expect.any(String),
      state: "active",
      escalationId: expect.stringMatching(/^esc_/),
      project: p.projectId,
      conflictId: ruled.conflictId,
      subject: "authz.permission-evaluation",
      holds: [{ ...ruled.premise, strength: "must" }],
      against: [ruled.other],
      guards: [ruled.guardId],
    });
    expect((await get(one, member)).status).toBe(200);
    const hidden = await refusal(await get(one));
    expect(hidden).toEqual({
      status: 404,
      code: "decision.not_found",
      detail: `No decision ${ruled.decisionId} in a project you can read.`,
    });
    expect([
      await refusal(await get(one, outsider)),
      await refusal(await get(one, visitor)),
    ]).toEqual([hidden, hidden]);
    expect(await refusal(await get(`/v1/decisions/${makeId("dec", ulid())}`, own))).toMatchObject({
      status: 404,
      code: "decision.not_found",
    });
    // Inside the org the project is no secret: another project's agent is told why it is refused.
    expect(await refusal(await get(one, neighbour))).toEqual({
      status: 403,
      code: "auth.forbidden",
      detail: "Refused: foreign-project.",
    });

    const listed = (path: string, token?: string) =>
      get(path, token).then(async (r) => (await r.json<DecisionPage>()).items.map((d) => d.id));
    expect(await listed("/v1/decisions", own)).toEqual([ruled.decisionId]);
    expect(await listed("/v1/decisions?subject=authz.permission-evaluation", own)).toEqual([
      ruled.decisionId,
    ]);
    expect(await listed("/v1/decisions?subject=billing.invoices", own)).toEqual([]);
    expect(await listed(`/v1/decisions?project=${p.projectId}`, member)).toEqual([
      ruled.decisionId,
    ]);
    // An agent that names no project reads its own, which has no decision.
    expect(await listed("/v1/decisions", neighbour)).toEqual([]);
    const listHidden = await refusal(await get(`/v1/decisions?project=${p.projectId}`));
    expect(listHidden).toMatchObject({ status: 404, code: "resource.not_found" });
    expect(await refusal(await get(`/v1/decisions?project=${p.projectId}`, visitor))).toEqual(
      listHidden,
    );

    await p.open();
    expect((await get(one)).status).toBe(200);
    expect((await get(one, visitor)).status).toBe(200);
    expect(await listed(`/v1/decisions?project=${p.projectId}`)).toEqual([ruled.decisionId]);
  });
});
