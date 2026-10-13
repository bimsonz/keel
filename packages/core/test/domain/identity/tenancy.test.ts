import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  admitQuota,
  type Agent,
  DAILY_QUOTAS,
  DEFAULT_QUOTAS,
  eventActorOf,
  MembershipChanged,
  type QuotaKind,
  type Quotas,
  revokedBy,
  type Role,
  SPEND_QUOTAS,
} from "../../../src/domain/identity/index.ts";
import { Actor, Instant, makeId } from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";
import { assertReaching } from "../../support/reach.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const DAY = 86_400_000;
const KINDS = Object.keys(DEFAULT_QUOTAS).filter((k): k is QuotaKind => k in DEFAULT_QUOTAS);
const ORG_1 = makeId("org", ulid(1));
const ORG_2 = makeId("org", ulid(2));
const ORGS = [ORG_1, ORG_2];
const ADA = makeId("usr", ulid(1));
const USERS = [ADA, makeId("usr", ulid(2))];
const ROLES: readonly Role[] = ["owner", "maintainer", "member"];

const nowArb = fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }).map(Instant);
const limitArb = fc.integer({ min: 0, max: 2000 });
const limitsArb: fc.Arbitrary<Quotas> = fc.record({
  projects: limitArb,
  agents: limitArb,
  "active-changes": limitArb,
  "repo-bytes": limitArb,
  "container-minutes": limitArb,
  "model-calls": limitArb,
  "concurrent-containers": limitArb,
});
/** An org's overrides: some kinds, each its own limit. */
const overridesArb = fc
  .subarray(KINDS)
  .chain((kinds) => fc.tuple(...kinds.map((k) => limitArb.map((n) => [k, n] as const))))
  .map((pairs): Partial<Quotas> => Object.fromEntries(pairs));
const limitOf = (kind: QuotaKind, defaults: Quotas, overrides: Partial<Quotas>): number =>
  overrides[kind] ?? defaults[kind];

/** An ask whose total often lands exactly on the limit, or one either side of it. */
const askArb = fc
  .record({
    kind: fc.constantFrom(...KINDS),
    defaults: limitsArb,
    overrides: overridesArb,
    now: nowArb,
    offset: fc.oneof(fc.constantFrom(-1, 0, 1), fc.integer({ min: -50, max: 50 })),
    amount: fc.integer({ min: 0, max: 20 }),
    halted: fc.boolean(),
  })
  .map(({ offset, ...a }) => ({
    ...a,
    used: Math.max(0, limitOf(a.kind, a.defaults, a.overrides) - a.amount + offset),
  }));

describe("quota admission", () => {
  it("[quota.boundary] an ask is admitted exactly when the org's total stays within its limit, its override first", () => {
    let atLimit = 0;
    assertReaching(
      fc.property(askArb, (ask) => {
        const limit = limitOf(ask.kind, ask.defaults, ask.overrides);
        if (ask.used + ask.amount === limit) atLimit++;
        const result = admitQuota(ask);
        if (ask.halted && SPEND_QUOTAS.has(ask.kind)) return Result.isFailure(result);
        return Result.isSuccess(result)
          ? ask.used + ask.amount <= limit &&
              result.success.remaining === limit - ask.used - ask.amount
          : ask.used + ask.amount > limit && result.failure.limit === limit;
      }),
    );
    expect(atLimit).toBeGreaterThan(0);
    const now = Instant(1_760_000_000_000);
    expect(
      Result.isSuccess(admitQuota({ kind: "projects", amount: 1, used: 9, now, halted: false })),
    ).toBe(true);
    expect(
      Result.isSuccess(admitQuota({ kind: "projects", amount: 1, used: 10, now, halted: false })),
    ).toBe(false);
    expect(
      Result.isSuccess(
        admitQuota({
          kind: "projects",
          amount: 1,
          used: 10,
          now,
          halted: false,
          overrides: { projects: 11 },
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        admitQuota({ kind: "agents", amount: Number.NaN, used: 0, now, halted: false }),
      ),
    ).toBe(false);
  });

  it("[quota.halt] the kill switch refuses every kind that spends on verification, and nothing else", () => {
    fc.assert(
      fc.property(askArb, (a) => {
        const ask = { ...a, halted: true };
        const halted = admitQuota(ask);
        const running = admitQuota({ ...ask, halted: false });
        return SPEND_QUOTAS.has(ask.kind)
          ? Result.isFailure(halted) && halted.failure.reason === "halted"
          : Result.isSuccess(halted) === Result.isSuccess(running);
      }),
    );
    expect([...SPEND_QUOTAS].toSorted()).toEqual([
      "concurrent-containers",
      "container-minutes",
      "model-calls",
    ]);
    const now = Instant(1_760_000_000_000);
    const refused = admitQuota({ kind: "model-calls", amount: 1, used: 0, now, halted: true });
    expect(Result.isFailure(refused) && refused.failure.reason).toBe("halted");
  });

  it("[quota.retry-at] a daily kind over its limit may retry at the next UTC midnight; a running total names no time", () => {
    fc.assert(
      fc.property(askArb, (a) => {
        const ask = { ...a, halted: false, used: limitOf(a.kind, a.defaults, a.overrides) + 1 };
        const result = admitQuota({ ...ask, amount: Math.max(1, ask.amount) });
        if (Result.isSuccess(result)) return false;
        const { retryAt } = result.failure;
        if (!DAILY_QUOTAS.has(ask.kind)) return retryAt === undefined;
        return (
          retryAt !== undefined &&
          retryAt % DAY === 0 &&
          retryAt > ask.now &&
          retryAt - ask.now <= DAY &&
          result.failure.nextActions.some((n) => n.kind === "wait")
        );
      }),
    );
    const refused = admitQuota({
      kind: "container-minutes",
      amount: 1,
      used: 120,
      now: Instant(Date.UTC(2026, 9, 14, 23, 59)),
      halted: false,
    });
    expect(Result.isFailure(refused) && refused.failure.retryAt).toBe(Date.UTC(2026, 9, 15));
  });
});

const agentArb: fc.Arbitrary<Agent> = fc
  .record({
    n: fc.integer({ min: 1, max: 99 }),
    org: fc.option(fc.constantFrom(...ORGS), { nil: undefined }),
    sponsor: fc.option(fc.constantFrom(...USERS), { nil: undefined }),
    state: fc.constantFrom("active", "suspended", "revoked"),
  })
  .map(({ n, org, sponsor, state }) => ({
    id: makeId("agt", ulid(n)),
    projectId: makeId("prj", ulid(1)),
    name: `agent-${n}`,
    kind: "interactive",
    scopes: ["agent:work", "agent:read"],
    ...(org === undefined ? {} : { org }),
    ...(sponsor === undefined ? {} : { sponsor }),
    state,
    revocationEpoch: 0,
    createdAt: Instant(0),
  }));
const changeArb = fc
  .record({
    orgId: fc.constantFrom(...ORGS),
    userId: fc.constantFrom(...USERS),
    from: fc.option(fc.constantFrom(...ROLES), { nil: undefined }),
    to: fc.option(fc.constantFrom(...ROLES), { nil: undefined }),
  })
  .filter((c) => c.from !== c.to)
  .map(({ from, to, ...c }) =>
    MembershipChanged.make({
      ...c,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    }),
  );

describe("tenancy", () => {
  it("[tenancy.ended-membership-revokes] ending a membership revokes exactly the live agents its user sponsored in that org", () => {
    let revoked = 0;
    assertReaching(
      fc.property(changeArb, fc.array(agentArb, { maxLength: 8 }), (change, agents) => {
        const got = revokedBy(change, agents);
        revoked += got.length;
        const expected =
          change.to === undefined
            ? agents
                .filter(
                  (a) =>
                    a.state !== "revoked" && a.org === change.orgId && a.sponsor === change.userId,
                )
                .map((a) => a.id)
            : [];
        return JSON.stringify(got) === JSON.stringify(expected);
      }),
    );
    expect(revoked).toBeGreaterThan(0);
    expect(
      revokedBy(MembershipChanged.make({ orgId: ORG_1, userId: ADA, from: "member" }), [
        { ...base(1), org: ORG_1, sponsor: ADA },
        { ...base(2), org: ORG_2, sponsor: ADA },
      ]),
    ).toEqual([makeId("agt", ulid(1))]);
  });

  it("[events.membership-changed] a membership change names the role left or the role taken, and they differ", () => {
    const decode = Schema.decodeUnknownResult(MembershipChanged);
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom(...ROLES), { nil: undefined }),
        fc.option(fc.constantFrom(...ROLES), { nil: undefined }),
        (from, to) =>
          Result.isSuccess(
            decode({
              _tag: "MembershipChanged",
              orgId: ORG_1,
              userId: ADA,
              ...(from === undefined ? {} : { from }),
              ...(to === undefined ? {} : { to }),
            }),
          ) ===
          (from !== to),
      ),
    );
    expect(Result.isSuccess(decode({ _tag: "MembershipChanged", orgId: ORG_1, userId: ADA }))).toBe(
      false,
    );
  });
});

function base(n: number): Agent {
  return {
    id: makeId("agt", ulid(n)),
    projectId: makeId("prj", ulid(1)),
    name: `agent-${n}`,
    kind: "interactive",
    scopes: ["agent:work"],
    state: "active",
    revocationEpoch: 0,
    createdAt: Instant(0),
  };
}

describe("who an event is by", () => {
  it("[tenancy.event-actor] a granted agent is named agent:<its id> and a granted user user:<their id>, and an envelope takes both", () => {
    const agentId = makeId("agt", ulid(7));
    expect(eventActorOf({ _tag: "Agent", agentId })).toBe("agent:agt_00000000000000000000000007");
    expect(eventActorOf({ _tag: "User", userId: ADA })).toBe("user:usr_00000000000000000000000001");

    const isActor = Schema.is(Actor);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (n) => {
        const byAgent = eventActorOf({ _tag: "Agent", agentId: makeId("agt", ulid(n)) });
        const byUser = eventActorOf({ _tag: "User", userId: makeId("usr", ulid(n)) });
        return (
          isActor(byAgent) &&
          isActor(byUser) &&
          byAgent === `agent:agt_${ulid(n)}` &&
          byUser === `user:usr_${ulid(n)}`
        );
      }),
    );
  });
});
