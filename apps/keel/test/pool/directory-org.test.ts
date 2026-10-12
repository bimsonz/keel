// The AgentDirectory's D1 row keeps an agent's place: an upsert without an
// org and a sponsor, as an enrolment recorded before tenancy replays, never
// unplaces an agent the cutover placed.
import { env } from "cloudflare:workers";
import type { Agent } from "@keeltown/core/domain/identity";
import { Instant, makeId } from "@keeltown/core/kernel";
import { AgentDirectory } from "@keeltown/core/ports";
import { hashSecret, sampleProjectId } from "@keeltown/testing";
import { Effect, Option } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { POOL_ORG, POOL_SPONSOR } from "./helpers.ts";

const directory = <A>(effect: Effect.Effect<A, never, AgentDirectory>) =>
  Effect.runPromise(effect.pipe(Effect.provide(AgentDirectoryD1(env.DB))));

describe("[tenancy.directory-org-kept] the directory row keeps an agent's org and sponsor", () => {
  it("[tenancy.directory-org-kept] an upsert of the same agent without them, as an enrol replay writes it, leaves org_id and sponsor_user as they were", async () => {
    const agentId = makeId("agt", ulid());
    const credential = {
      clientId: `client-${agentId.toLowerCase()}`,
      agentId,
      secretHash: await hashSecret("secret"),
    };
    const unplaced: Agent = {
      id: agentId,
      projectId: sampleProjectId,
      name: "kept-agent",
      kind: "interactive",
      scopes: ["agent:read", "agent:work"],
      state: "active",
      revocationEpoch: 0,
      createdAt: Instant(Date.UTC(2026, 9, 12)),
    };
    const placed: Agent = { ...unplaced, org: POOL_ORG, sponsor: POOL_SPONSOR };
    const row = () =>
      env.DB.prepare("SELECT org_id, sponsor_user, name FROM agents WHERE id = ?")
        .bind(agentId)
        .first<{ org_id: string | null; sponsor_user: string | null; name: string }>();

    await directory(AgentDirectory.use((d) => d.upsert(placed, credential)));
    expect(await row()).toEqual({
      org_id: POOL_ORG,
      sponsor_user: POOL_SPONSOR,
      name: "kept-agent",
    });

    // The replay still writes what it carries: the name moves, the place stays.
    await directory(
      AgentDirectory.use((d) => d.upsert({ ...unplaced, name: "replayed-agent" }, credential)),
    );
    expect(await row()).toEqual({
      org_id: POOL_ORG,
      sponsor_user: POOL_SPONSOR,
      name: "replayed-agent",
    });
    const found = await directory(AgentDirectory.use((d) => d.findAgent(agentId)));
    expect(Option.getOrUndefined(found)).toMatchObject({ org: POOL_ORG, sponsor: POOL_SPONSOR });
  });
});
