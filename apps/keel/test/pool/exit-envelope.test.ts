import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { AGENT, HELD_LEASE, INBOX, SESSION } from "@keeltown/core/application/identity";
import { Agent, AgentNotKnown } from "@keeltown/core/domain/identity";
import { Session } from "@keeltown/core/domain/memory";
import { type AgentId, Instant, makeId } from "@keeltown/core/kernel";
import { NotImplemented } from "@keeltown/core/not-implemented";
import { Cause, Effect, Exit, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { AgentSessionDO } from "../../src/adapters/driving/do/agent-session.ts";
import { AgentSessionCodecs, decodeExit } from "../../src/rpc/index.ts";
import { sampleProjectId } from "@keeltown/testing";

/** A fresh AgentSession DO, reached through its binding exactly as other Workers and DOs reach it. */
function session() {
  const agentId = makeId("agt", ulid());
  return { agentId, stub: env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)) };
}

/** Writes rows straight into the object's entity table, as its own transactions would. */
async function seed(
  stub: DurableObjectStub<AgentSessionDO>,
  rows: readonly (readonly [kind: string, id: string, value: unknown])[],
) {
  await runInDurableObject(stub, (_instance: AgentSessionDO, state) => {
    for (const [kind, id, value] of rows)
      state.storage.sql.exec(
        "INSERT INTO entities (kind, id, value) VALUES (?, ?, ?)",
        kind,
        id,
        JSON.stringify(value),
      );
  });
}

const enrolled = (agentId: AgentId) =>
  Schema.encodeSync(Agent)({
    id: agentId,
    projectId: sampleProjectId,
    name: "envelope-agent",
    kind: "interactive",
    scopes: ["agent:work"],
    state: "active",
    revocationEpoch: 0,
    createdAt: Instant(1_760_000_000_000),
  });

describe("the Exit envelope over real Durable Object RPC", () => {
  it("brings a tagged error back across the boundary as an instance of that error", async () => {
    const { agentId, stub } = session();
    const exit = decodeExit(AgentSessionCodecs.describe, await stub.describe());
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(error).toBeInstanceOf(AgentNotKnown);
    expect(error).toMatchObject({ _tag: "AgentNotKnown", agentId });
  });

  it("brings a success value back decoded", async () => {
    const { agentId, stub } = session();
    const current: Session = {
      id: makeId("ses", ulid()),
      agentId,
      harness: "claude-code",
      openedAt: Instant(1_760_000_100_000),
    };
    await seed(stub, [
      [AGENT, agentId, enrolled(agentId)],
      [SESSION.current.kind, SESSION.current.id, Schema.encodeSync(Session)(current)],
      [HELD_LEASE, makeId("chg", ulid()), makeId("lse", ulid())],
      [INBOX.head.kind, INBOX.head.id, 3],
    ]);
    const exit = decodeExit(AgentSessionCodecs.describe, await stub.describe());
    expect(exit).toEqual(
      Exit.succeed({ agentId, session: current, inboxDepth: 3, openLeases: 1, fidelity: null }),
    );
  });

  it("brings a defect back as a defect, never as a tagged error", async () => {
    const { agentId, stub } = session();
    await seed(stub, [
      [AGENT, agentId, enrolled(agentId)],
      [SESSION.current.kind, SESSION.current.id, { corrupt: true }],
    ]);
    const exit = decodeExit(AgentSessionCodecs.describe, await stub.describe());
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false);
  });

  // Every AgentSession method is built now, so the object answers an unbuilt use-case's program directly.
  it("brings NotImplemented back as a defect named for its use-case", async () => {
    const { stub } = session();
    const json = await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance["answer"](
        AgentSessionCodecs.openSession,
        Effect.die(new NotImplemented("identity/somethingUnbuilt")),
      ),
    );
    const exit = decodeExit(AgentSessionCodecs.openSession, json);
    const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(defect).toBeInstanceOf(Error);
    expect(String(defect)).toContain("identity/somethingUnbuilt");
  });
});
