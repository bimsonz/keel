import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { EventEnvelope, makeId } from "@keeltown/core/kernel";
import type { AgentId, ProjectId } from "@keeltown/core/kernel";
import {
  type AgentNotice,
  Enrolments,
  EventOutbox,
  Sessions,
  Standings,
} from "@keeltown/core/ports";
import { subjectAddress, suspectConflict } from "@keeltown/core/application/coordination";
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
import { ProbeLedgerRpc } from "../../src/adapters/driven/do-rpc/probe-ledger.ts";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { SessionsRpc } from "../../src/adapters/driven/do-rpc/sessions.ts";
import { StandingsRpc } from "../../src/adapters/driven/do-rpc/standings.ts";
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

/** A subject's Subject DO, drained after each case. */
const subjectObject = (address: string) =>
  drainAfter(env.SUBJECT.get(env.SUBJECT.idFromName(address)));

/** The Subject DO runs the ledger: the suite opens its conflict inside the object, as its fallout does. */
PORTS.ProbeLedger.contract("Subject DO over RPC", () => ({
  layer: ProbeLedgerRpc(subjectObject),
  suspect: (at, conflictId, suspect) =>
    Effect.promise(() =>
      runInDurableObject(
        subjectObject(subjectAddress(at.projectId, at.key)),
        (instance: SubjectDO) =>
          instance["runtime"].runPromise(suspectConflict(at.projectId, conflictId, suspect)),
      ),
    ),
  log: (at, entity) =>
    Effect.promise(() =>
      runInDurableObject(
        subjectObject(subjectAddress(at.projectId, at.key)),
        (instance: SubjectDO) =>
          instance["runtime"].runPromise(Effect.map(EventOutbox, (outbox) => outbox.log(entity))),
      ),
    ),
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

/** An operator's move commits on the agent's AgentSession DO; each waits for its outbox to go quiet. */
const drainedStandings = Layer.effect(
  Standings,
  Effect.gen(function* () {
    const standings = yield* Standings;
    const drained =
      (move: "suspend" | "reinstate" | "revoke"): (typeof standings)["suspend"] =>
      (principal, input) =>
        standings[move](principal, input).pipe(
          Effect.ensuring(Effect.promise(() => drainOutbox(agentSession(input.agentId)))),
        );
    return Standings.of({
      suspend: drained("suspend"),
      reinstate: drained("reinstate"),
      revoke: drained("revoke"),
    });
  }),
).pipe(Layer.provide(StandingsRpc(agentSession)));

PORTS.Standings.contract("AgentSession DO over RPC", () => ({
  layer: Layer.mergeAll(drainedStandings, drainedEnrolments, AgentDirectoryD1(env.DB)),
}));

const suiteOperator = {
  agentId: makeId("agt", ulid()),
  projectId: makeId("prj", ulid()),
  scopes: ["operator" as const],
  revocationEpoch: 0,
};

PORTS.Sessions.contract("AgentSession DO over RPC", () => ({
  layer: Layer.mergeAll(drainedSessions, drainedEnrolments, AgentDirectoryD1(env.DB)),
  // The operator's own suspend, on the agent's AgentSession DO.
  suspend: (agentId) =>
    Standings.use((standings) =>
      standings.suspend(suiteOperator, {
        agentId,
        reason: "suspended by the Sessions suite",
        idempotencyKey: `suspend-${agentId}`,
      }),
    ).pipe(Effect.asVoid, Effect.orDie, Effect.provide(drainedStandings)),
}));
