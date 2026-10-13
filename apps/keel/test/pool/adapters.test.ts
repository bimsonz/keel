import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type EntityRef, EventEnvelope, makeId } from "@keeltown/core/kernel";
import type { AgentId, ProjectId } from "@keeltown/core/kernel";
import {
  type AgentNotice,
  AgentSignUps,
  Enrolments,
  EntityStore,
  EventOutbox,
  PROJECTOR,
  Sessions,
  Sponsorships,
  Standings,
} from "@keeltown/core/ports";
import { SPONSOR_ASK } from "@keeltown/core/application/identity";
import {
  namespaceAddress,
  subjectAddress,
  suspectConflict,
} from "@keeltown/core/application/coordination";
import {
  type EscalationsHarness,
  describeAgentDirectoryContract,
  describeNotifierContract,
  describeTokenIssuerContract,
  makeClockMemory,
  PORTS,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { ulid } from "ulid";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { NamespacesD1 } from "../../src/adapters/driven/d1/namespaces.ts";
import { EnrolmentsRpc } from "../../src/adapters/driven/do-rpc/enrolments.ts";
import { AgentSignUpsRpc } from "../../src/adapters/driven/do-rpc/sign-ups.ts";
import { LiveChangesRpc } from "../../src/adapters/driven/do-rpc/live-changes.ts";
import { ConflictMovesRpc } from "../../src/adapters/driven/do-rpc/conflict-moves.ts";
import { EscalationsRpc } from "../../src/adapters/driven/do-rpc/escalations.ts";
import { HumanGateRpc } from "../../src/adapters/driven/do-rpc/human-gate.ts";
import { ProbeLedgerRpc } from "../../src/adapters/driven/do-rpc/probe-ledger.ts";
import type { NamespaceDO } from "../../src/adapters/driving/do/namespace.ts";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { SessionsRpc } from "../../src/adapters/driven/do-rpc/sessions.ts";
import { SponsorshipsRpc } from "../../src/adapters/driven/do-rpc/sponsorships.ts";
import { StandingsRpc } from "../../src/adapters/driven/do-rpc/standings.ts";
import type { AgentSessionDO } from "../../src/adapters/driving/do/agent-session.ts";
import { InboxRpc } from "../../src/adapters/driven/do-rpc/inbox.ts";
import { NotifierRpc } from "../../src/adapters/driven/do-rpc/notifier.ts";
import { TokenIssuerJose } from "../../src/adapters/driven/jose/token-issuer.ts";
import { drainAfter, drainOutbox, placeProject } from "./helpers.ts";

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

/** A namespace's object, drained after each case. */
const namespaceObject = (address: string) =>
  drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(address)));

const theProjector = () => env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR));

/** An object's committed events on one entity, read inside the object. */
const logOf = (stub: DurableObjectStub<NamespaceDO | SubjectDO>, entity: EntityRef) =>
  Effect.promise(() =>
    runInDurableObject(stub, (instance: NamespaceDO | SubjectDO) =>
      instance["runtime"].runPromise(Effect.map(EventOutbox, (outbox) => outbox.log(entity))),
    ),
  );

/**
 * Escalations are raised and ruled on the real namespace object, and read
 * from the real Projector, which hears them by delivery: `settled` waits for
 * the namespace's outbox to have delivered everything.
 */
const escalationsHarness = (): EscalationsHarness => ({
  layer: Layer.mergeAll(
    HumanGateRpc(namespaceObject),
    EscalationsRpc(theProjector, namespaceObject),
  ),
  settled: (namespace) =>
    Effect.promise(() => drainOutbox(namespaceObject(namespaceAddress(namespace)))),
  log: (namespace, entity) => logOf(namespaceObject(namespaceAddress(namespace)), entity),
});
PORTS.HumanGate.contract("namespace object over RPC", escalationsHarness);
PORTS.Escalations.contract("namespace object and Projector over RPC", escalationsHarness);

/**
 * A party's move is made on the real Subject DO, which finds its project's
 * namespace in D1 and raises the escalation on the real namespace object;
 * the suite reads what was asked from the real Projector.
 */
PORTS.ConflictMoves.contract("Subject DO, namespace object and Projector over RPC", () => ({
  layer: Layer.mergeAll(
    ConflictMovesRpc(subjectObject),
    ProbeLedgerRpc(subjectObject),
    EscalationsRpc(theProjector, namespaceObject),
  ),
  suspect: (at, conflictId, suspect) =>
    Effect.promise(() =>
      runInDurableObject(
        subjectObject(subjectAddress(at.projectId, at.key)),
        (instance: SubjectDO) =>
          instance["runtime"].runPromise(suspectConflict(at.projectId, conflictId, suspect)),
      ),
    ),
  log: (at, entity) => logOf(subjectObject(subjectAddress(at.projectId, at.key)), entity),
  place: (projectId, namespace) => Effect.promise(() => placeProject(projectId, namespace)),
  settled: (at, namespace) =>
    Effect.promise(async () => {
      await drainOutbox(subjectObject(subjectAddress(at.projectId, at.key)));
      await drainOutbox(namespaceObject(namespaceAddress(namespace)));
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
      enrol: (actor, input) =>
        enrolments
          .enrol(actor, input)
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

/** A sign-up commits AgentSignedUp on the agent's own AgentSession DO; each one waits for that object's outbox to go quiet. */
const drainedSignUps = Layer.effect(
  AgentSignUps,
  Effect.gen(function* () {
    const signUps = yield* AgentSignUps;
    return AgentSignUps.of({
      signUp: (input) =>
        signUps
          .signUp(input)
          .pipe(Effect.ensuring(Effect.promise(() => drainOutbox(agentSession(input.agentId))))),
    });
  }),
).pipe(Layer.provide(AgentSignUpsRpc(agentSession)));

PORTS.AgentSignUps.contract("AgentSession DO over RPC", () => ({
  layer: Layer.mergeAll(drainedSignUps, AgentDirectoryD1(env.DB), NamespacesD1(env.DB)),
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

/** A move on an agent's standing commits on its AgentSession DO; each waits for its outbox to go quiet. */
const drainedStandings = Layer.effect(
  Standings,
  Effect.gen(function* () {
    const standings = yield* Standings;
    const drained =
      (move: "suspend" | "reinstate" | "revoke"): (typeof standings)["suspend"] =>
      (actor, input) =>
        standings[move](actor, input).pipe(
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

/** Waits for an agent's AgentSession DO to deliver what it owes. */
const drain = (agentId: AgentId) => Effect.promise(() => drainOutbox(agentSession(agentId)));

/** A move on an agent's sponsor link commits on its AgentSession DO; each waits for its outbox to go quiet. */
const drainedSponsorships = Layer.effect(
  Sponsorships,
  Effect.gen(function* () {
    const links = yield* Sponsorships;
    return Sponsorships.of({
      ask: links.ask,
      approve: (approval) => links.approve(approval).pipe(Effect.ensuring(drain(approval.agentId))),
      end: (actor, ending) => links.end(actor, ending).pipe(Effect.ensuring(drain(ending.agentId))),
    });
  }),
).pipe(Layer.provide(SponsorshipsRpc(agentSession)));

PORTS.Sponsorships.contract("AgentSession DO over RPC", () => ({
  layer: Layer.mergeAll(
    drainedSponsorships,
    drainedStandings,
    drainedEnrolments,
    AgentDirectoryD1(env.DB),
  ),
  // The request's own row on the agent's object, rewritten as already run out.
  expire: (agentId) =>
    Effect.promise(() =>
      runInDurableObject(agentSession(agentId), (instance: AgentSessionDO) =>
        instance["runtime"].runPromise(
          Effect.map(EntityStore, (store) => {
            const ask = store.get(SPONSOR_ASK, agentId);
            if (ask === undefined) return;
            const { codeHash } = Schema.decodeUnknownSync(
              Schema.Struct({ codeHash: Schema.String }),
            )(ask);
            store.put(SPONSOR_ASK, agentId, { codeHash, expiresAt: 0 });
          }),
        ),
      ),
    ),
}));

const suiteMaintainer = { _tag: "User" as const, userId: makeId("usr", ulid()) };

PORTS.Sessions.contract("AgentSession DO over RPC", () => ({
  layer: Layer.mergeAll(drainedSessions, drainedEnrolments, AgentDirectoryD1(env.DB)),
  // A maintainer's own suspend, on the agent's AgentSession DO.
  suspend: (agentId) =>
    Standings.use((standings) =>
      standings.suspend(suiteMaintainer, {
        agentId,
        reason: "suspended by the Sessions suite",
        idempotencyKey: `suspend-${agentId}`,
      }),
    ).pipe(Effect.asVoid, Effect.orDie, Effect.provide(drainedStandings)),
}));
