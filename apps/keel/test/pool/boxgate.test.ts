// BoxGate and MergeBox in workerd: the gate counts a namespace's boxes against
// the limit its usage object holds (its own override, the instance's default,
// none while it is halted), a lease never given back is reclaimed by the
// gate's alarm at its deadline, and a box answers a compose of a version it
// does not know `unsupported`, never a crash.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DEFAULT_QUOTAS } from "@keeltown/core/domain/identity";
import type { NamespaceId } from "@keeltown/core/kernel";
import { NamespaceUsage } from "@keeltown/core/ports";
import { freshNamespace } from "@keeltown/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { NamespaceUsageRpc } from "../../src/adapters/driven/do-rpc/namespace-usage.ts";
import { armedAlarms } from "../../src/adapters/driving/do/alarm.ts";

const WAIT = { timeout: 20_000, interval: 25 };
const TTL = 600_000;

const gate = (namespace: NamespaceId) =>
  env.BOXGATE.get(env.BOXGATE.idFromName(`boxgate:${namespace}`));

const configure = (
  namespace: NamespaceId,
  settings: Parameters<NamespaceUsage["Service"]["configure"]>[1],
) =>
  Effect.runPromise(
    NamespaceUsage.use((usage) => usage.configure(namespace, settings)).pipe(
      Effect.provide(NamespaceUsageRpc(env.NAMESPACE_USAGE)),
    ),
  );

describe("BoxGate", () => {
  it("[boxgate.do.limit] grants a namespace its concurrent-containers boxes at once, renews a holder's own, frees one given back, and follows the namespace's override and halt", async () => {
    const namespace = freshNamespace();
    const limit = DEFAULT_QUOTAS["concurrent-containers"];
    const asks = Array.from({ length: limit }, (_, i) =>
      gate(namespace).acquire({ holder: `cand-${i}`, ttlMs: TTL }),
    );
    const granted = await Promise.all(asks);
    expect(granted.every((answer) => answer.granted)).toBe(true);
    const over = await gate(namespace).acquire({ holder: "cand-over", ttlMs: TTL });
    expect(over).toMatchObject({ granted: false, held: limit, limit });
    const again = await gate(namespace).acquire({ holder: "cand-0", ttlMs: TTL });
    expect(again.granted).toBe(true);
    expect(await gate(namespace).held()).toBe(limit);

    const first = granted[0];
    if (first === undefined || !first.granted) throw new Error("no first lease");
    await gate(namespace).release(first.leaseId);
    expect((await gate(namespace).acquire({ holder: "cand-over", ttlMs: TTL })).granted).toBe(true);

    await configure(namespace, {
      overrides: { "concurrent-containers": limit + 1 },
      halted: false,
    });
    expect((await gate(namespace).acquire({ holder: "cand-more", ttlMs: TTL })).granted).toBe(true);
    await configure(namespace, { overrides: {}, halted: true });
    expect(await gate(namespace).acquire({ holder: "cand-halted", ttlMs: TTL })).toMatchObject({
      granted: false,
      limit: 0,
    });
  });

  it("[boxgate.do.lapses] reclaims a lease never given back at its deadline, on the gate's own alarm, and arms nothing once none is left", async () => {
    const namespace = freshNamespace();
    const lease = await gate(namespace).acquire({ holder: "cand-lost", ttlMs: 50 });
    expect(lease.granted).toBe(true);
    const stored = () =>
      runInDurableObject(gate(namespace), (_instance, state) => ({
        leases: state.storage.kv.get<unknown[]>("leases") ?? [],
        armed: armedAlarms(state.storage).map((request) => request.reason),
      }));
    expect(await stored()).toEqual({
      leases: [expect.objectContaining({ holder: "cand-lost" })],
      armed: ["a box lease lapses"],
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await runDurableObjectAlarm(gate(namespace));
    await vi.waitFor(async () => expect(await stored()).toEqual({ leases: [], armed: [] }), WAIT);
  });
});

describe("MergeBox", () => {
  it("[mergebox.rpc-n-1] answers a compose of a version it does not know unsupported, and one of no known shape the same, never a crash", async () => {
    const box = env.MERGEBOX.get(
      env.MERGEBOX.idFromName("mergebox:prj_01J9ZZZZZZZZZZZZZZZZZZZZZA"),
    );
    expect(
      await box.compose({
        v: 2,
        candidateId: "cnd_01J9ZZZZZZZZZZZZZZZZZZZZZE",
        staging: { namespace: "keel-core", name: "prj-staging" },
        base: "a".repeat(40),
        members: [],
        rebaseFirst: true,
      }),
    ).toEqual({ kind: "unsupported", reason: "a compose of a version this box does not know" });
    expect(await box.compose({ candidate: "anything" })).toMatchObject({ kind: "unsupported" });
  });
});
