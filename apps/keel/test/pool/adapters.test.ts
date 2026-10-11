import { env } from "cloudflare:workers";
import { EventEnvelope, makeId } from "@keeltown/core/kernel";
import {
  describeAgentDirectoryContract,
  describeNotifierContract,
  describeTokenIssuerContract,
  makeClockMemory,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { ulid } from "ulid";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
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

// The piggyback and the inbox over the AgentSession DO; a notice reaches it as an event the agent hears of.
describeNotifierContract("AgentSession DO over RPC", () => ({
  layer: Layer.merge(NotifierRpc(agentSession), InboxRpc(agentSession)),
  deliver: (agentId, notice) =>
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
    }),
}));
