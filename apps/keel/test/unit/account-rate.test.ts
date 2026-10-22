// Per-account daily limits on what an account opens: proposals, issues and
// issue comments, counted against a person, or an agent's sponsor.
import { describe, expect, it } from "@effect/vitest";
import { accountOf } from "@keeltown/core/application/identity";
import {
  type AgentPrincipal,
  DAILY_QUOTAS,
  DEFAULT_QUOTAS,
  resetAt,
  type UserPrincipal,
} from "@keeltown/core/domain/identity";
import { Instant, makeId } from "@keeltown/core/kernel";
import { ulid } from "ulid";

const person = (): UserPrincipal => ({
  _tag: "User",
  userId: makeId("usr", ulid()),
  handle: "ann",
  suspended: false,
  memberships: [],
});
const agent = (sponsor?: UserPrincipal): AgentPrincipal => ({
  _tag: "Agent",
  agentId: makeId("agt", ulid()),
  namespace: makeId("org", ulid()),
  scopes: ["agent:work", "agent:read"],
  paused: false,
  standing: { _tag: "Governs" },
  sponsored: sponsor !== undefined,
  ...(sponsor === undefined ? {} : { sponsor: sponsor.userId }),
});

describe("per-account daily limits", () => {
  it("[rate.kinds-daily] an account opens at most 10 proposals, moves them 50 times, and opens 10 issues and 200 issue comments a UTC day by default, counted afresh at midnight", () => {
    expect([
      DEFAULT_QUOTAS.proposals,
      DEFAULT_QUOTAS["proposal-moves"],
      DEFAULT_QUOTAS.issues,
      DEFAULT_QUOTAS["issue-comments"],
    ]).toEqual([10, 50, 10, 200]);
    for (const kind of ["proposals", "proposal-moves", "issues", "issue-comments"] as const)
      expect(DAILY_QUOTAS.has(kind)).toBe(true);
    const noon = Instant(Date.UTC(2026, 9, 22, 12));
    expect(resetAt("issues", noon)).toBe(Date.UTC(2026, 9, 23));
  });

  it("[rate.sponsor-shares] what a person opens counts against their own namespace, what an agent opens against its sponsor's, so one person's agents share one allowance; an agent nobody sponsors counts against its own", () => {
    const ann = person();
    const [one, two] = [agent(ann), agent(ann)];
    const loose = agent();
    expect(accountOf(ann)).toBe(ann.userId);
    expect(accountOf(one)).toBe(ann.userId);
    expect(accountOf(two)).toBe(ann.userId);
    expect(accountOf(loose)).toBe(loose.agentId);
  });
});
