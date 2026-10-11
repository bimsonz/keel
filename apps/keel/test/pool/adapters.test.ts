import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { EventEnvelope, makeId } from "@keeltown/core/kernel";
import type { AgentId, ProjectId } from "@keeltown/core/kernel";
import { type AgentNotice, Enrolments, Sessions } from "@keeltown/core/ports";
import {
  describeAgentDirectoryContract,
  describeNotifierContract,
  describeTokenIssuerContract,
  makeClockMemory,
  PORTS,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { ulid } from "ulid";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { EnrolmentsRpc } from "../../src/adapters/driven/do-rpc/enrolments.ts";
import { LiveChangesRpc } from "../../src/adapters/driven/do-rpc/live-changes.ts";
import { SessionsRpc } from "../../src/adapters/driven/do-rpc/sessions.ts";
import { InboxRpc } from "../../src/adapters/driven/do-rpc/inbox.ts";
import { NotifierRpc } from "../../src/adapters/driven/do-rpc/notifier.ts";
import { TokenIssuerJose } from "../../src/adapters/driven/jose/token-issuer.ts";
import { drainAfter, drainOutbox } from "./helpers.ts";

// The real adapters pass the same contract suites as the in-memory ones, inside workerd.
describeAgentDirectoryContract("d1", () => AgentDirectoryD1(env.DB));
describeTokenIssuerContract("jose ed25519", () =>
  TokenIssuerJose({ privateJwk: env.KEEL_SIGNING_KEY, issuer: "keel.localhost" }).pipe(
    Layer.provide(makeClockMemory().layer),
  ),
);

const agentSession = (agentId: string) =>
  env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`));

/** A notice reaches the AgentSession DO as an event its agent hears of. */
const deliver = (agentId: AgentId, notice: AgentNotice) =>
  Effect.promise(async () => {
    const entity = { kind: "change", id: makeId("chg", ulid()) };
    await agentSession(agentId).receive([
      Schema.encodeSync(EventEnvelope)(
        Schema.decodeUnknownSync(EventEnvelope)({
          eventId: makeId("evt", ulid()),
          type: "ChangeBounced",
          entity,
          seq: 1,
          at: notice.at,
          dedupeKey: `change:${entity.id}/${notice.id}/ChangeBounced#1`,
          affected: [],
          notified: [],
          payload: { _tag: "ChangeBounced" },
        }),
      ),
    ]);
  });

// The piggyback and the inbox over the AgentSession DO.
describeNotifierContract("AgentSession DO over RPC", () => ({
  layer: Layer.merge(NotifierRpc(agentSession), InboxRpc(agentSession)),
  deliver,
}));
PORTS.Inbox.contract("AgentSession DO over RPC", () => ({
  layer: InboxRpc(agentSession),
  deliver,
}));

const projectObject = (projectId: ProjectId) =>
  drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));

// The live-change index on each project's Project DO, fed through its `receive` as the fan-out feeds it.
PORTS.LiveChanges.contract("Project DO over RPC", () => ({
  layer: LiveChangesRpc(projectObject),
  hear: (projectId, event) =>
    Effect.promise(async () => {
      await projectObject(projectId).receive([Schema.encodeSync(EventEnvelope)(event)]);
    }),
}));

/**
 * Enrolment commits AgentEnrolled on the new agent's AgentSession DO, which
 * writes the D1 row the suite reads. Each enrolment then waits for that
 * object's outbox to go quiet, so its flush to the Projector never outlives
 * the file.
 */
const drainedEnrolments = Layer.effect(
  Enrolments,
  Effect.gen(function* () {
    const enrolments = yield* Enrolments;
    return Enrolments.of({
      enrol: (principal, input) =>
        enrolments
          .enrol(principal, input)
          .pipe(
            Effect.tap((enrolled) =>
              Effect.promise(() => drainOutbox(agentSession(enrolled.agent.id))),
            ),
          ),
    });
  }),
).pipe(Layer.provide(EnrolmentsRpc(agentSession)));

PORTS.Enrolments.contract("AgentSession DO over RPC", () => ({
  layer: Layer.merge(drainedEnrolments, AgentDirectoryD1(env.DB)),
}));

/** Opening a session commits SessionOpened on the agent's AgentSession DO; each open waits for its outbox to go quiet. */
const drainedSessions = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    return Sessions.of({
      ...sessions,
      open: (principal, input) =>
        sessions
          .open(principal, input)
          .pipe(
            Effect.ensuring(Effect.promise(() => drainOutbox(agentSession(principal.agentId)))),
          ),
    });
  }),
).pipe(Layer.provide(SessionsRpc(agentSession)));

PORTS.Sessions.contract("AgentSession DO over RPC", () => ({
  layer: Layer.mergeAll(drainedSessions, drainedEnrolments, AgentDirectoryD1(env.DB)),
  // The DO holds the agent; push P brings the operator's suspend, so the harness rewrites the row.
  suspend: (agentId) =>
    Effect.promise(() =>
      runInDurableObject(agentSession(agentId), (_instance, state) => {
        const [row] = state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM entities WHERE kind = 'agent' AND id = ?",
            agentId,
          )
          .toArray();
        if (row === undefined) throw new Error(`${agentId} is not enrolled`);
        state.storage.sql.exec(
          "UPDATE entities SET value = ? WHERE kind = 'agent' AND id = ?",
          JSON.stringify({ ...JSON.parse(row.value), state: "suspended" }),
          agentId,
        );
      }),
    ),
}));
