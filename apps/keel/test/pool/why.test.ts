import { env } from "cloudflare:workers";
import { type EventEnvelope, EventEnvelope as Envelope, makeId } from "@keeltown/core/kernel";
import { ruledConflict } from "@keeltown/testing";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { ProblemBody } from "../../src/adapters/driving/http/problems.ts";
import {
  BASE,
  drainAfter,
  OTHER_ORG,
  mcp,
  mcpResult,
  seedAgent,
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

/** A POST through the doorway as `token`, with an idempotency key and a JSON body. */
const post = (path: string, token: string, body: object) =>
  worker(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": `why-${ulid()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

/**
 * An agent of the project, enrolled over REST by a maintainer of its org on a
 * fresh passkey sign-in, so the maintainer stands behind it and may pause it,
 * with a token of the agent's own.
 */
async function enrolled(projectId: string) {
  const maintainer = (
    await seedUser(uniqueHandle("maintainer"), { role: "maintainer", signedInBy: "passkey" })
  ).token;
  const enrolment = await post("/v1/agents", maintainer, {
    name: "why-agent",
    kind: "interactive",
    scopes: ["agent:read", "agent:work"],
    projectId,
  });
  expect(enrolment.status).toBe(201);
  const answer = await enrolment.json<{
    agent: { id: string };
    clientId: string;
    clientSecret: string;
  }>();
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${answer.agent.id}`)));
  const exchanged = await worker(`${BASE}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: answer.clientId,
      client_secret: answer.clientSecret,
    }),
  });
  const token = (await exchanged.json<{ access_token: string }>()).access_token;
  return { maintainer, agentId: answer.agent.id, token };
}

type Link = {
  readonly summary: string;
  readonly record: { readonly id: string; readonly message: { readonly kind: string } };
};
type WhyBody = {
  readonly summary: string;
  readonly result: { readonly chain: readonly Link[] };
  readonly next: readonly unknown[];
};

const SUBJECT = "authz.permission-evaluation";
const FILE = "src/authz/check.ts";
const LANDED = "d".repeat(40);

/**
 * A private project with one conflict ruled for the premise, as the Projector
 * hears it: both parties declared and started, the ruling and its resolution,
 * the premise's holder landed after it, and the subject anchored in `FILE`.
 */
async function explained() {
  const p = await project();
  const ruled = ruledConflict(p.events);
  const agents = [makeId("agt", ulid()), makeId("agt", ulid())] as const;
  await arrive(
    p.events.declared(ruled.holder, agents[0], "Check permissions on every request"),
    p.events.declared(ruled.other, agents[1], "Cache sessions for an hour"),
    p.events.started(ruled.holder),
    p.events.started(ruled.other),
    ...ruled.conflict,
    ruled.recorded("premise-holds"),
    ruled.resolved([ruled.other]),
    ...p.events.landing(ruled.holder, LANDED),
    ruled.minted([FILE]),
  );
  return { p, ruled };
}

/** The status and the chain an answer holds. */
const chainOf = async (response: Response) => ({
  status: response.status,
  result: (await response.json<WhyBody>()).result,
});

describe("[why.http] why, over REST and MCP, from the Projector's decision index", () => {
  it("[why.http] the project's own agent is answered the chain of a subject and of a file anchored to it, the same over MCP; nothing to explain, another project's agent and a person all read the one 404", async () => {
    const { p, ruled } = await explained();
    const own = await tokenFor(await seedAgent({ projectId: p.projectId }));
    const neighbour = await tokenFor(await seedAgent({ projectId: makeId("prj", ulid()) }));
    const member = (await seedUser(uniqueHandle("member"))).token;
    const visitor = (await seedUser(uniqueHandle("visitor"), { org: OTHER_ORG })).token;

    const asked = await get(`/v1/why?subject=${SUBJECT}`, own);
    expect(asked.status).toBe(200);
    const body = await asked.json<WhyBody>();
    expect(body.result.chain.map((link) => [link.record.message.kind, link.record.id])).toEqual([
      ["decision", ruled.decisionId],
      ["premise", `${ruled.conflictId}.premise`],
      ["intent", `${ruled.other}.intent.1`],
      ["observation", ruled.guardId],
      ["verdict", `${ruled.holder}.landed.${ruled.decisionId}`],
    ]);
    expect(body).toMatchObject({
      ok: true,
      summary: `1 active decision explains ${SUBJECT}, newest first: 5 records.`,
      next: [
        {
          kind: "read",
          operationId: "Memory_getDecision",
          args: { decisionId: ruled.decisionId },
        },
      ],
      notices: [],
    });
    // A file the subject is anchored in answers the same chain; the line narrows nothing.
    const byFile = await get(`/v1/why?path=${FILE}&line=12`, own);
    expect(byFile.status).toBe(200);
    expect((await byFile.json<WhyBody>()).result).toEqual(body.result);
    const viaTool = await mcpResult(
      await mcp(own, "tools/call", { name: "why", arguments: { subject: SUBJECT } }, "why"),
    );
    expect(viaTool["structuredContent"]).toEqual(body);

    const nothing = await refusal(await get("/v1/why?subject=billing.invoices", own));
    expect(nothing).toEqual({
      status: 404,
      code: "why.nothing_to_explain",
      detail: "No active decision in the project explains billing.invoices.",
    });
    expect(await refusal(await get("/v1/why?path=src/billing.ts", own))).toMatchObject({
      status: 404,
      code: "why.nothing_to_explain",
    });
    // Another project's agent reads its own project, where nothing explains the subject; a person, or no one, has no project of their own to read.
    const hidden = {
      status: 404,
      code: "why.nothing_to_explain",
      detail: `No active decision in the project explains ${SUBJECT}.`,
    };
    expect([
      await refusal(await get(`/v1/why?subject=${SUBJECT}`, neighbour)),
      await refusal(await get(`/v1/why?subject=${SUBJECT}`, member)),
      await refusal(await get(`/v1/why?subject=${SUBJECT}`, visitor)),
      await refusal(await get(`/v1/why?subject=${SUBJECT}`)),
    ]).toEqual([hidden, hidden, hidden, hidden]);

    // A path or a subject, never both and never neither, and a line only in a path.
    const invalid = await Promise.all(
      ["", `?path=${FILE}&subject=${SUBJECT}`, `?subject=${SUBJECT}&line=3`].map(async (query) => {
        const response = await get(`/v1/why${query}`, own);
        const problem = await response.json<ProblemBody>();
        return [response.status, problem.code, problem.issues?.map((issue) => issue.path)];
      }),
    );
    expect(invalid).toEqual([
      [400, "request.invalid", [["path"]]],
      [400, "request.invalid", [["subject"]]],
      [400, "request.invalid", [["line"]]],
    ]);
  });

  it("[why.http] `project` names the project read, as the decisions list's does: an agent naming none reads its own, a member reads a private one, anyone reads a public one without a token, and a private or unknown one is the 404 of nothing to explain", async () => {
    const { p } = await explained();
    const own = await tokenFor(await seedAgent({ projectId: p.projectId }));
    const member = (await seedUser(uniqueHandle("member"))).token;
    const visitor = (await seedUser(uniqueHandle("visitor"), { org: OTHER_ORG })).token;
    const named = `/v1/why?subject=${SUBJECT}&project=${p.projectId}`;
    const unknown = `/v1/why?subject=${SUBJECT}&project=${makeId("prj", ulid())}`;

    const mine = await chainOf(await get(`/v1/why?subject=${SUBJECT}`, own));
    expect(mine.status).toBe(200);
    expect(mine.result.chain).toHaveLength(5);
    expect(await chainOf(await get(named, own))).toEqual(mine);
    expect(await chainOf(await get(named, member))).toEqual(mine);
    const hidden = {
      status: 404,
      code: "why.nothing_to_explain",
      detail: `No active decision in the project explains ${SUBJECT}.`,
    };
    expect([
      await refusal(await get(named)),
      await refusal(await get(named, visitor)),
      await refusal(await get(unknown)),
      await refusal(await get(unknown, member)),
    ]).toEqual([hidden, hidden, hidden, hidden]);

    await p.open();
    expect(await chainOf(await get(named))).toEqual(mine);
    expect(await chainOf(await get(named, visitor))).toEqual(mine);
    // Public, it is no one's own: a caller without a token who names none reads nothing.
    expect(await refusal(await get(`/v1/why?subject=${SUBJECT}`))).toEqual(hidden);
  });

  it("[why.http.landings] a file no decision explains is answered 200 with the changes that landed on it most recently, each its intent saying no decision is recorded there, and a way to read each", async () => {
    const p = await project();
    const { token } = await enrolled(p.projectId);
    const changeId = makeId("chg", ulid());
    await arrive(
      p.events.declared(changeId, makeId("agt", ulid()), "Price at four times the count"),
      p.events.started(changeId),
      ...p.events.landing(changeId, LANDED, ["bench/p2.ts"]),
    );
    const response = await get("/v1/why?path=bench/p2.ts", token);
    expect(response.status).toBe(200);
    const body = await response.json<WhyBody>();
    expect(body.summary).toBe(
      "No decision is recorded on bench/p2.ts; the 1 change that landed there most recently says why it is as it is, newest first.",
    );
    expect(
      body.result.chain.map((link) => [link.record.id, link.record.message.kind, link.summary]),
    ).toEqual([
      [
        `${changeId}.intent.1`,
        "intent",
        `No decision is recorded on bench/p2.ts: ${changeId} landed it as ${LANDED.slice(0, 12)}, intending "Price at four times the count"`,
      ],
    ]);
    expect(body.next).toEqual([
      {
        kind: "read",
        title: `Read change ${changeId}, which landed on bench/p2.ts`,
        operationId: "change",
        args: { changeId },
      },
    ]);
    // A file nothing landed on is still nothing to explain.
    expect(await refusal(await get("/v1/why?path=bench/none.ts", token))).toMatchObject({
      status: 404,
    });
  });

  it("[why.http] a paused agent is refused about itself, 403 agent-paused with what to do next, and never read the 404 of a project with nothing to explain", async () => {
    const p = await project();
    const ruled = ruledConflict(p.events);
    await arrive(...ruled.conflict, ruled.recorded("premise-holds"), ruled.resolved([ruled.other]));
    const { maintainer, agentId, token } = await enrolled(p.projectId);
    const asked = `/v1/why?subject=${SUBJECT}`;
    expect((await get(asked, token)).status).toBe(200);

    const paused = await post(`/v1/agents/${agentId}/suspend`, maintainer, {
      reason: "runaway retries",
    });
    expect([paused.status, (await paused.json<{ state: string }>()).state]).toEqual([
      200,
      "suspended",
    ]);
    const refused = await get(asked, token);
    const body = await refused.json<ProblemBody>();

    expect([refused.status, body.code, body.detail]).toEqual([
      403,
      "auth.forbidden",
      "Refused: agent-paused.",
    ]);
    expect(body.nextActions).toMatchObject([
      { kind: "escalate", title: "You are paused; ask your sponsor to reinstate you" },
    ]);
    // A path asked while paused is refused the same, about the agent and not the file.
    expect(await refusal(await get(`/v1/why?path=${FILE}`, token))).toEqual({
      status: 403,
      code: "auth.forbidden",
      detail: "Refused: agent-paused.",
    });
  });
});
