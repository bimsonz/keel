// Spike S11: what one request pays for its Effect runtime. The isolate keeps
// one ManagedRuntime per Env (composition/isolate.ts); the alternative builds
// the Layer for every request. Both run the bearer gate's real work: verify an
// Ed25519 token with the jose adapter, then whoami against the directory.
//   node apps/keel/test/bench/runtime.ts
// Node runs V8 as workerd does; inside a Worker the clock is frozen during CPU
// work, so the per-request CPU cost is measured here, not there.
import { whoami } from "@keeltown/core/application/identity";
import type { Agent } from "@keeltown/core/domain/identity";
import { Instant, makeId } from "@keeltown/core/kernel";
import { TokenIssuer } from "@keeltown/core/ports";
import { makeAgentDirectoryMemory, sampleProjectId } from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TokenIssuerJose } from "../../src/adapters/driven/jose/token-issuer.ts";
import { ClockLive } from "../../src/adapters/driven/system.ts";

const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
if (!("privateKey" in pair)) throw new Error("Ed25519 did not generate a key pair");
const privateJwk = JSON.stringify(Object.assign(await crypto.subtle.exportKey("jwk", pair.privateKey), { kid: "bench" }));

const agent: Agent = {
  id: makeId("agt", "01J9ZQ3V7KX2M4N6P8R0S2T4V6"),
  projectId: sampleProjectId,
  name: "bench",
  kind: "interactive",
  scopes: ["agent:read", "agent:work"],
  state: "active",
  revocationEpoch: 0,
  createdAt: Instant(Date.UTC(2026, 9, 10)),
};
const directory = makeAgentDirectoryMemory();
directory.seed(agent, { clientId: "bench", agentId: agent.id, secretHash: "sha256:00" });

const layer = Layer.mergeAll(directory.layer, TokenIssuerJose({ privateJwk, issuer: "keel.bench" }).pipe(Layer.provide(ClockLive)));
const runtime = ManagedRuntime.make(layer);
const { token } = await runtime.runPromise(TokenIssuer.use((issuer) => issuer.issue({ agentId: agent.id, projectId: agent.projectId, scopes: agent.scopes, revocationEpoch: 0 }, 3600)));

const request = TokenIssuer.use((issuer) => issuer.verify(token)).pipe(Effect.flatMap(whoami));
const bare = whoami({ agentId: agent.id, projectId: agent.projectId, scopes: agent.scopes, revocationEpoch: 0 });

async function measure(label: string, run: () => Promise<unknown>, iterations = 3000): Promise<void> {
  for (let i = 0; i < 300; i += 1) await run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) => (samples[Math.floor(q * (samples.length - 1))] ?? 0).toFixed(3);
  console.log(`${label.padEnd(58)} p50 ${at(0.5)} ms  p95 ${at(0.95)} ms  p99 ${at(0.99)} ms`);
}

console.log("bearer gate (verify an Ed25519 token, then whoami):");
await measure("  runtime per isolate (what Keel does)", () => runtime.runPromise(request));
await measure("  Layer per request", () => Effect.runPromise(request.pipe(Effect.provide(layer))));
console.log("the runtime alone (whoami against the in-memory directory, no crypto):");
await measure("  runtime per isolate", () => runtime.runPromise(bare));
await measure("  Layer per request", () => Effect.runPromise(bare.pipe(Effect.provide(directory.layer))));
await runtime.dispose();
