import { env } from "cloudflare:workers";
import { EventEnvelope, makeId } from "@keeltown/core/kernel";
import type { AgentId } from "@keeltown/core/kernel";
import type { AgentNotice } from "@keeltown/core/ports";
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
import { InboxRpc } from "../../src/adapters/driven/do-rpc/inbox.ts";
import { NotifierRpc } from "../../src/adapters/driven/do-rpc/notifier.ts";
import { TokenIssuerJose } from "../../src/adapters/driven/jose/token-issuer.ts";

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

// Enrolment commits on the new agent's AgentSession DO, which writes the D1 row the suite reads.
PORTS.Enrolments.contract("AgentSession DO over RPC", () => ({
  layer: Layer.merge(EnrolmentsRpc(agentSession), AgentDirectoryD1(env.DB)),
}));
