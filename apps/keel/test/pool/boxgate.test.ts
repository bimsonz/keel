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
import { freshId, freshNamespace } from "@keeltown/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { NamespaceUsageRpc } from "../../src/adapters/driven/do-rpc/namespace-usage.ts";
import { armedAlarms } from "../../src/adapters/driving/do/alarm.ts";
import { TIER2_BOX_CAP, TIER2_GATE } from "../../src/adapters/driving/do/boxgate-leases.ts";

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
      halted: true,
    });
    await configure(namespace, { overrides: {}, halted: false });
    expect(await gate(namespace).acquire({ holder: "cand-later", ttlMs: TTL })).not.toHaveProperty(
      "halted",
    );
  });

  it("[boxgate.do.waiters] a lane refused for want of room is kept once and told when a box is freed, by a lapse or a release, then forgotten; one that cannot be told is logged and dropped; a refusal of a halted namespace keeps none", async () => {
    const namespace = freshNamespace();
    const lane = `lane:${freshId("prj")}:main`;
    // No Lane takes this address, so telling it fails where the gate can say so.
    const lost = "lane:not-a-lane";
    const warned = vi.spyOn(console, "warn");
    const limit = DEFAULT_QUOTAS["concurrent-containers"];
    const held = await Promise.all(
      Array.from({ length: limit }, (_, i) =>
        gate(namespace).acquire({ holder: `cand-${i}`, ttlMs: i === 0 ? 1_500 : TTL }),
      ),
    );
    const waiting = () =>
      runInDurableObject(
        gate(namespace),
        (_instance, state) => state.storage.kv.get<string[]>("waiters") ?? [],
      );
    for (const [holder, waiter] of [
      ["cand-a", lost],
      ["cand-b", lost],
    ] as const)
      expect(await gate(namespace).acquire({ holder, ttlMs: TTL, waiter })).toMatchObject({
        granted: false,
      });
    expect(await waiting()).toEqual([lost]);
    // The first lease lapses: the waiter is told once, and forgotten.
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await runDurableObjectAlarm(gate(namespace));
    await vi.waitFor(async () => expect(await waiting()).toEqual([]), WAIT);
    expect(
      warned.mock.calls.filter(([line]) => String(line).includes(`lane ${lost} not told`)),
    ).toHaveLength(1);
    // Refused again, a lane waits again; a lease given back tells it.
    expect((await gate(namespace).acquire({ holder: "cand-c", ttlMs: TTL })).granted).toBe(true);
    await gate(namespace).acquire({ holder: "cand-d", ttlMs: TTL, waiter: lane });
    expect(await waiting()).toEqual([lane]);
    const second = held[1];
    if (second === undefined || !second.granted) throw new Error("no second lease");
    await gate(namespace).release(second.leaseId);
    expect(await waiting()).toEqual([]);
    expect(warned.mock.calls.filter(([line]) => String(line).includes(`lane ${lane}`))).toEqual([]);
    // Halted, a refusal keeps no waiter: there is no room to wait for.
    await configure(namespace, { overrides: {}, halted: true });
    await gate(namespace).acquire({ holder: "cand-e", ttlMs: TTL, waiter: lane });
    expect(await waiting()).toEqual([]);
    warned.mockRestore();
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

describe("the Tier 2 gate", () => {
  it("[capacity.tier2-gate] counts keel-verify's Tier 2 boxes against their cap, whatever namespace they run for: free is the cap less the live leases", async () => {
    const tier2 = env.BOXGATE.get(env.BOXGATE.idFromName(TIER2_GATE));
    const before = await tier2.free();
    expect(before).toBe(TIER2_BOX_CAP - (await tier2.held()));
    const a = await tier2.acquire({ holder: `${freshNamespace()}/job-a/js-ts.suite`, ttlMs: TTL });
    const b = await tier2.acquire({ holder: `${freshNamespace()}/job-b/js-ts.suite`, ttlMs: TTL });
    if (!a.granted || !b.granted) throw new Error("the Tier 2 gate refused under its cap");
    expect(await tier2.free()).toBe(before - 2);
    await tier2.release(a.leaseId);
    expect(await tier2.free()).toBe(before - 1);
    await tier2.release(b.leaseId);
    expect(await tier2.free()).toBe(before);
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
