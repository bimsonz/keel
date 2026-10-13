import { eventActorOf } from "@keeltown/core/domain/identity";
import type { AgentId } from "@keeltown/core/kernel";
import { Sponsorships } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import {
  AgentSessionCodecs,
  ApproveSponsorCommand,
  AskSponsorCommand,
  EndSponsorCommand,
} from "../../../rpc/index.ts";
import { callObject, fingerprintOf, sha256Of } from "./answer.ts";

/** The AgentSession DO methods `Sponsorships` calls (`agent:<id>`), answering Exit envelopes. */
export interface SponsorshipsStub {
  askSponsor(command: typeof AskSponsorCommand.Encoded): Promise<unknown>;
  approveSponsor(command: typeof ApproveSponsorCommand.Encoded): Promise<unknown>;
  endSponsorship(command: typeof EndSponsorCommand.Encoded): Promise<unknown>;
}

const encodeAsk = Schema.encodeSync(AskSponsorCommand);
const encodeApprove = Schema.encodeSync(ApproveSponsorCommand);
const encodeEnd = Schema.encodeSync(EndSponsorCommand);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 32 random characters of Crockford base32, 160 bits: the code an agent shows a person, kept only as its hash. */
function freshCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => CROCKFORD[byte % 32] ?? "0")
    .join("");
}

/**
 * `Sponsorships` over each agent's AgentSession DO. The code is minted here
 * and only its hash crosses, in the request and in the approval alike, so the
 * object never holds a code. The fingerprint hashes who approves and how the
 * agent asked, so a retry is told apart from a reused key.
 */
export function SponsorshipsRpc(
  agentSession: (agentId: AgentId) => SponsorshipsStub,
): Layer.Layer<Sponsorships> {
  return Layer.succeed(
    Sponsorships,
    Sponsorships.of({
      ask: (agentId) =>
        Effect.gen(function* () {
          const code = freshCode();
          const codeHash = yield* Effect.promise(() => sha256Of(code));
          const expiresAt = yield* callObject(AgentSessionCodecs.askSponsor, () =>
            agentSession(agentId).askSponsor(encodeAsk({ codeHash })),
          );
          return { code, expiresAt };
        }),
      approve: (approval) =>
        Effect.gen(function* () {
          const { asked } = approval;
          const codeHash =
            asked._tag === "Code" ? yield* Effect.promise(() => sha256Of(asked.code)) : undefined;
          const fingerprint = yield* Effect.promise(() =>
            fingerprintOf({ by: approval.by, asked: asked._tag, codeHash: codeHash ?? null }),
          );
          return yield* callObject(AgentSessionCodecs.approveSponsor, () =>
            agentSession(approval.agentId).approveSponsor(
              encodeApprove({
                by: approval.by,
                ...(codeHash === undefined ? {} : { codeHash }),
                idempotencyKey: approval.idempotencyKey,
                fingerprint,
              }),
            ),
          );
        }),
      end: (actor, ending) =>
        Effect.gen(function* () {
          const by = eventActorOf(actor);
          const fingerprint = yield* Effect.promise(() => fingerprintOf({ end: by }));
          return yield* callObject(AgentSessionCodecs.endSponsorship, () =>
            agentSession(ending.agentId).endSponsorship(
              encodeEnd({
                by,
                ...(ending.run === undefined ? {} : { run: ending.run }),
                idempotencyKey: ending.idempotencyKey,
                fingerprint,
              }),
            ),
          );
        }),
    }),
  );
}
