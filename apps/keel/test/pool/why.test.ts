import { env } from "cloudflare:workers";
import { type EventEnvelope, EventEnvelope as Envelope, makeId } from "@keeltown/core/kernel";
import { ruledConflict } from "@keeltown/testing";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { ProblemBody } from "../../src/adapters/driving/http/problems.ts";
import {
  BASE,
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

type Link = { readonly summary: string; readonly record: { readonly kind: string; id: string } };
type WhyBody = {
  readonly summary: string;
  readonly result: { readonly chain: readonly Link[] };
  readonly next: readonly unknown[];
};

const SUBJECT = "authz.permission-evaluation";
const FILE = "src/authz/check.ts";
const LANDED = "d".repeat(40);

describe("[why.http] why, over REST and MCP, from the Projector's decision index", () => {
  it("[why.http] the project's own agent is answered the chain of a subject and of a file anchored to it, the same over MCP; nothing to explain, another project's agent and a person all read the one 404", async () => {
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
    const own = await tokenFor(await seedAgent({ projectId: p.projectId }));
    const neighbour = await tokenFor(await seedAgent({ projectId: makeId("prj", ulid()) }));
    const member = (await seedUser(uniqueHandle("member"))).token;
    const visitor = (await seedUser(uniqueHandle("visitor"), { org: OTHER_ORG })).token;

    const asked = await get(`/v1/why?subject=${SUBJECT}`, own);
    expect(asked.status).toBe(200);
    const body = await asked.json<WhyBody>();
    expect(body.result.chain.map((link) => [link.record.kind, link.record.id])).toEqual([
      ["decision", ruled.decisionId],
      ["premise", `${ruled.conflictId}.premise`],
      ["intent", `${ruled.other}.intent.1`],
      ["observation", ruled.guardId],
      ["verdict", `${ruled.holder}.landed`],
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
      detail: "No active decision in your project explains billing.invoices.",
    });
    expect(await refusal(await get("/v1/why?path=src/billing.ts", own))).toMatchObject({
      status: 404,
      code: "why.nothing_to_explain",
    });
    // Another project's agent reads its own project, where nothing explains the subject; a person, or no one, has no project of their own to read.
    const hidden = {
      status: 404,
      code: "why.nothing_to_explain",
      detail: `No active decision in your project explains ${SUBJECT}.`,
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
});
