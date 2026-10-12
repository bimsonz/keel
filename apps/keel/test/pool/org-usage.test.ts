// The OrgUsage DO in workerd: the whole OrgUsage contract through the port
// adapter and the real object, each org's object on a clock the suite moves,
// and the object's own deadline, which forgets the keys a week old.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "@effect/vitest";
import { USAGE_KEY_TTL_MS, usageAddress } from "@keeltown/core/application/identity";
import { DEFAULT_QUOTAS, type QuotaKind } from "@keeltown/core/domain/identity";
import type { OrgId } from "@keeltown/core/kernel";
import { OrgUsage } from "@keeltown/core/ports";
import {
  freshOrg,
  type ManualClock,
  makeManualClock,
  type OrgUsageHarness,
  PORTS,
} from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { vi } from "vitest";
import { OrgUsageRpc } from "../../src/adapters/driven/do-rpc/org-usage.ts";
import { armedAlarms, scheduleAlarm } from "../../src/adapters/driving/do/alarm.ts";
import {
  type OrgUsageDO,
  USAGE_PRUNE,
  USAGE_PRUNE_EVERY_MS,
} from "../../src/adapters/driving/do/org-usage.ts";
import { backbone } from "../../src/composition/do.ts";

/** How long a test waits for an alarm the platform may already be running. */
const WAIT = { timeout: 20_000, interval: 25 };
const LIMIT = DEFAULT_QUOTAS.projects;

const usageStub = (org: OrgId) => env.ORG_USAGE.get(env.ORG_USAGE.idFromName(usageAddress(org)));

/**
 * Runs the org's object on `clock` instead of the system's. Test-only: it
 * replaces the instance's runtime from inside the object, which shares the
 * test's isolate, so the clock the test moves is the one the object reads.
 */
const onClock = (org: OrgId, clock: ManualClock) =>
  runInDurableObject(usageStub(org), (instance: OrgUsageDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(Layer.merge(backbone(state.storage), clock.layer)),
    );
  });

/** The port over the real objects; every org it hands out has its object on the harness's clock. */
function throughTheObject(): OrgUsageHarness {
  const clock = makeManualClock(Date.now());
  return {
    layer: OrgUsageRpc(env.ORG_USAGE),
    org: () =>
      Effect.promise(async () => {
        const org = freshOrg();
        await onClock(org, clock);
        return org;
      }),
    now: Effect.sync(clock.now),
    advance: (ms) => Effect.sync(() => clock.advance(ms)),
  };
}

PORTS.OrgUsage.contract("do-rpc", throughTheObject);

describe("the OrgUsage DO", () => {
  it("[orgusage.do.prune] the prune is armed a day after a count and never postponed, forgets a key at seven days, and stays armed only while a key is held", async () => {
    const org = freshOrg();
    const clock = makeManualClock(Date.now());
    await onClock(org, clock);
    const stub = usageStub(org);
    const layer = OrgUsageRpc(env.ORG_USAGE);
    const admit = (kind: QuotaKind, amount: number, key: string) =>
      Effect.runPromise(
        Effect.flatMap(OrgUsage, (usage) => usage.admit(org, kind, amount, key)).pipe(
          Effect.provide(layer),
        ),
      );
    const record = (kind: QuotaKind, amount: number, key: string) =>
      Effect.runPromise(
        Effect.flatMap(OrgUsage, (usage) => usage.record(org, kind, amount, key)).pipe(
          Effect.provide(layer),
        ),
      );
    const armed = () =>
      runInDurableObject(stub, (_instance: OrgUsageDO, state) =>
        armedAlarms(state.storage).find((alarm) => alarm.reason === USAGE_PRUNE),
      );
    /** Brings the prune due now and runs it; answers when it was brought due. */
    const prune = async () => {
      const at = Date.now();
      await runInDurableObject(stub, (_instance: OrgUsageDO, state) =>
        scheduleAlarm(state.storage, { kind: "deadline", reason: USAGE_PRUNE, at }),
      );
      // The platform may run a due alarm before this line does; the caller waits for its effect.
      await runDurableObjectAlarm(stub);
      return at;
    };

    expect(await armed()).toBeUndefined();
    const before = Date.now();
    expect(await admit("projects", 4, "first")).toEqual({ limit: LIMIT, remaining: LIMIT - 4 });
    const first = await armed();
    expect(first?.at).toBeGreaterThanOrEqual(before + USAGE_PRUNE_EVERY_MS);
    expect(first?.at).toBeLessThanOrEqual(Date.now() + USAGE_PRUNE_EVERY_MS);

    // A day on, a second key; storing it does not postpone the prune already armed.
    clock.advance(USAGE_PRUNE_EVERY_MS);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await record("projects", 1, "second");
    expect(await armed()).toEqual(first);

    // A moment short of seven days after the first key: nothing is forgotten, and the prune is armed again.
    clock.advance(USAGE_KEY_TTL_MS - USAGE_PRUNE_EVERY_MS - 1);
    const early = await prune();
    await vi.waitFor(
      async () => expect((await armed())?.at).toBeGreaterThanOrEqual(early + USAGE_PRUNE_EVERY_MS),
      WAIT,
    );
    // Still the first key's answer, and still counted once.
    expect(await admit("projects", 4, "first")).toEqual({ limit: LIMIT, remaining: LIMIT - 4 });

    // At seven days the first key is forgotten; the second is a day younger, so the prune stays armed.
    clock.advance(1);
    const due = await prune();
    await vi.waitFor(
      async () => expect((await armed())?.at).toBeGreaterThanOrEqual(due + USAGE_PRUNE_EVERY_MS),
      WAIT,
    );
    // Forgotten, the first key is a new one and counts again: 4 and 1 before, 4 now.
    expect(await admit("projects", 4, "first")).toEqual({ limit: LIMIT, remaining: LIMIT - 9 });

    // A week later every key is older than seven days: all forgotten, and nothing is left armed.
    clock.advance(USAGE_KEY_TTL_MS);
    await prune();
    await vi.waitFor(async () => expect(await armed()).toBeUndefined(), WAIT);
    await record("projects", 1, "second");
    expect(await admit("projects", 0, "left")).toEqual({ limit: LIMIT, remaining: LIMIT - 10 });
  });
});
