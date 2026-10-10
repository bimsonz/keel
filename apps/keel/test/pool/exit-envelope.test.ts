import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { AgentNotKnown } from "@keeltown/core/domain/identity";
import { makeId } from "@keeltown/core/kernel";
import { Cause, Exit } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { type AgentSessionDO, SNAPSHOT } from "../../src/adapters/driving/do/agent-session.ts";
import { AgentSessionCodecs, decodeExit } from "../../src/rpc/index.ts";

/** A fresh AgentSession DO, reached through its binding exactly as other Workers and DOs reach it. */
function session() {
  const agentId = makeId("agt", ulid());
  return { agentId, stub: env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)) };
}

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
    const snapshot = { agentId, session: null, inboxDepth: 3, openLeases: 1, fidelity: 0.75 };
    await runInDurableObject(stub, (instance: AgentSessionDO, state) => {
      void instance;
      state.storage.sql.exec(
        "INSERT INTO entities (kind, id, value) VALUES (?, ?, ?)",
        SNAPSHOT.kind,
        SNAPSHOT.id,
        JSON.stringify(snapshot),
      );
    });
    const exit = decodeExit(AgentSessionCodecs.describe, await stub.describe());
    expect(exit).toEqual(Exit.succeed(snapshot));
  });

  it("brings a defect back as a defect, never as a tagged error", async () => {
    const { stub } = session();
    await runInDurableObject(stub, (_instance: AgentSessionDO, state) => {
      state.storage.sql.exec("INSERT INTO entities (kind, id, value) VALUES (?, ?, ?)", SNAPSHOT.kind, SNAPSHOT.id, JSON.stringify({ corrupt: true }));
    });
    const exit = decodeExit(AgentSessionCodecs.describe, await stub.describe());
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false);
  });

  it("brings NotImplemented back as a defect named for its use-case", async () => {
    const { stub } = session();
    const exit = decodeExit(AgentSessionCodecs.openSession, await stub.openSession({}));
    const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(defect).toBeInstanceOf(Error);
    expect(String(defect)).toContain("identity/openSession");
  });
});
