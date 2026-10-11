import type { AgentId, ProjectId } from "@keeltown/core/kernel";
import { makeId } from "@keeltown/core/kernel";
import { Enrolments } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import { AgentSessionCodecs, EnrolCommand } from "../../../rpc/index.ts";
import { callObject, derivedUlid, fingerprintOf, sha256Of } from "./answer.ts";
import type { AgentSessionStub } from "./changes.ts";

const encodeEnrol = Schema.encodeSync(EnrolCommand);

/** 32 random bytes, base64url: the client secret, shown once and kept only as its hash. */
function freshSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * `Enrolments` over the new agent's AgentSession DO, the agents' source of
 * truth. The agent id is derived from the operator and the Idempotency-Key, so
 * a retry reaches the same DO. The secret is minted here and only its hash
 * crosses; the DO writes the D1 projection before answering, and a retry
 * replaces the hash, so the secret this call returns is the one that works.
 */
export function EnrolmentsRpc(
  agentSession: (agentId: AgentId) => Pick<AgentSessionStub, "enrol">,
): Layer.Layer<Enrolments> {
  return Layer.succeed(
    Enrolments,
    Enrolments.of({
      enrol: (principal, input) =>
        Effect.gen(function* () {
          const agentId = makeId(
            "agt",
            yield* Effect.promise(() => derivedUlid(principal.agentId, input.idempotencyKey)),
          );
          const projectId: ProjectId = input.projectId ?? principal.projectId;
          // The sponsor joins the fingerprint only when named, so a key enrolled without one replays unchanged.
          const sponsor = input.onBehalfOf === undefined ? {} : { onBehalfOf: input.onBehalfOf };
          const fingerprint = yield* Effect.promise(() =>
            fingerprintOf({
              name: input.name,
              kind: input.kind,
              scopes: input.scopes,
              projectId,
              ...sponsor,
            }),
          );
          const clientId = `client-${agentId.toLowerCase()}`;
          const clientSecret = freshSecret();
          const secretHash = yield* Effect.promise(() => sha256Of(clientSecret));
          const agent = yield* callObject(AgentSessionCodecs.enrol, () =>
            agentSession(agentId).enrol(
              encodeEnrol({
                projectId,
                name: input.name,
                kind: input.kind,
                scopes: input.scopes,
                ...sponsor,
                clientId,
                secretHash,
                idempotencyKey: input.idempotencyKey,
                fingerprint,
              }),
            ),
          );
          return { agent, clientId, clientSecret };
        }),
    }),
  );
}
