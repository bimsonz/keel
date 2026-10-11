import {
  BOOTSTRAP_AGENT,
  BOOTSTRAP_AGENT_ID,
  BOOTSTRAP_CLIENT_ID,
} from "@keeltown/core/domain/identity";
import { AgentDirectory } from "@keeltown/core/ports";
import { Effect, Layer, Option } from "effect";

/** A shorter secret leaves the bootstrap credential off: it is the key to the first operator. */
export const MIN_BOOTSTRAP_SECRET_LENGTH = 32;

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Compares two secrets by their digests, in time independent of where they differ. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i += 1) difference |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return difference === 0;
}

/**
 * The AgentDirectory with the bootstrap credential in front of it. Exchanging
 * `keel-bootstrap` with the Worker's KEEL_BOOTSTRAP_SECRET verifies as the
 * bootstrap agent, an operator in the platform project that is never stored,
 * so no D1 row exists to read or to revoke: rotating the secret retires it.
 * Without a secret of at least 32 characters the credential does not exist.
 * Everything else passes through to the projection underneath.
 */
export function AgentDirectoryWithBootstrap(
  secret: string | undefined,
): Layer.Layer<AgentDirectory, never, AgentDirectory> {
  const enabled = secret !== undefined && secret.length >= MIN_BOOTSTRAP_SECRET_LENGTH;
  return Layer.effect(
    AgentDirectory,
    Effect.gen(function* () {
      const inner = yield* AgentDirectory;
      return AgentDirectory.of({
        findAgent: (agentId) =>
          agentId === BOOTSTRAP_AGENT_ID
            ? Effect.succeed(enabled ? Option.some(BOOTSTRAP_AGENT) : Option.none())
            : inner.findAgent(agentId),
        // The bootstrap credential is never read back, so its secret never leaves this adapter.
        findCredential: (clientId) =>
          clientId === BOOTSTRAP_CLIENT_ID
            ? Effect.succeed(Option.none())
            : inner.findCredential(clientId),
        verifyCredential: (clientId, offered) => {
          if (clientId !== BOOTSTRAP_CLIENT_ID) return inner.verifyCredential(clientId, offered);
          if (!enabled) return Effect.succeed(Option.none());
          return Effect.map(
            Effect.promise(() => sameSecret(offered, secret)),
            (same) => (same ? Option.some(BOOTSTRAP_AGENT_ID) : Option.none()),
          );
        },
        upsert: (agent, credential) =>
          agent.id === BOOTSTRAP_AGENT_ID || credential.clientId === BOOTSTRAP_CLIENT_ID
            ? Effect.die(new Error("the bootstrap credential is never stored"))
            : inner.upsert(agent, credential),
        // The bootstrap agent has no row and no standing: rotating the secret retires it.
        standing: (agentId, standing, seq) =>
          agentId === BOOTSTRAP_AGENT_ID
            ? Effect.die(new Error("the bootstrap agent has no standing to change"))
            : inner.standing(agentId, standing, seq),
      });
    }),
  );
}
