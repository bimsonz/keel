import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeId } from "@keeltown/core/kernel";
import { Enrolments, Sponsorships } from "@keeltown/core/ports";
import { sampleProjectId } from "@keeltown/testing";
import { Effect, Exit, Layer } from "effect";
import { ulid } from "ulid";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { EnrolmentsRpc } from "../../src/adapters/driven/do-rpc/enrolments.ts";
import { SponsorshipsRpc } from "../../src/adapters/driven/do-rpc/sponsorships.ts";
import { AgentSessionCodecs, decodeExit } from "../../src/rpc/index.ts";
import { drainAfter } from "./helpers.ts";

const agentSession = (agentId: string) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

const layer = Layer.mergeAll(
  SponsorshipsRpc(agentSession),
  EnrolmentsRpc(agentSession).pipe(Layer.provide(AgentDirectoryD1(env.DB))),
);

const run = <A, E>(effect: Effect.Effect<A, E, Sponsorships | Enrolments>) =>
  Effect.runPromise(Effect.provide(effect, layer));

const person = () => ({ _tag: "User" as const, userId: makeId("usr", ulid()) });

/** What an inbox page says of each notice: its kind, its detail, and the operations its next actions name. */
const told = async (reading: Promise<unknown>) => {
  const page = decodeExit(AgentSessionCodecs.inbox, await reading);
  if (!Exit.isSuccess(page)) throw new Error("the inbox read failed");
  return {
    cursor: page.value.cursor,
    notices: page.value.notices.map((notice) => [
      notice.kind,
      notice.detail,
      notice.nextActions?.map((action) => action.operationId),
    ]),
  };
};

describe("the sponsor link on the real AgentSession DO", () => {
  it("[link.told] tells the agent of a move on its sponsor link that somebody else made, waking a waiting read, and never of its own", async () => {
    const first = person();
    const second = person();
    const { agent } = await run(
      Enrolments.use((enrolments) =>
        enrolments.enrol(first, {
          name: "told-agent",
          kind: "interactive",
          scopes: ["agent:read", "agent:work"],
          projectId: sampleProjectId,
          org: makeId("org", ulid()),
          sponsor: first.userId,
          idempotencyKey: `enrol-${ulid()}`,
        }),
      ),
    );
    const agentId = agent.id;
    const session = agentSession(agentId);
    const empty = await told(session.inbox({ waitMs: 0 }));
    expect(empty.notices).toEqual([]);

    // The member who enrolled it leaves: a read already waiting is answered by that move.
    const started = Date.now();
    const waiting = told(session.inbox({ cursor: empty.cursor, waitMs: 20_000 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await run(
      Sponsorships.use((links) => links.end(first, { agentId, idempotencyKey: `end-${ulid()}` })),
    );
    const left = await waiting;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(left.notices).toEqual([
      ["AgentUnsponsored", "nobody stands behind you now", ["whoami"]],
    ]);

    // Another person stands behind it, then the agent itself leaves: it is told of the first only.
    await run(
      Sponsorships.use((links) =>
        links.approve({
          agentId,
          by: second.userId,
          asked: { _tag: "Consent" },
          idempotencyKey: `approve-${ulid()}`,
        }),
      ),
    );
    await run(
      Sponsorships.use((links) =>
        links.end({ _tag: "Agent", agentId }, { agentId, idempotencyKey: `leave-${ulid()}` }),
      ),
    );
    const after = await told(session.inbox({ cursor: left.cursor, waitMs: 0 }));
    expect(after.notices).toEqual([
      [
        "AgentSponsored",
        "a person now stands behind you: your questions go to them, and they may pause you",
        ["whoami"],
      ],
    ]);
  });
});
