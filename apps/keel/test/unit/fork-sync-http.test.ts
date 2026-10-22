// A fork's sync through the handler the route and the MCP tool dispatch into:
// its owners sync it only while they may read the project it was forked from,
// and a path Keel cannot merge is told as such, naming it.
import type { SignedIn } from "@keeltown/core/application/identity";
import type { Principal } from "@keeltown/core/domain/identity";
import { CommitSha, makeId, type ProjectId } from "@keeltown/core/kernel";
import { Trunks } from "@keeltown/core/ports";
import {
  makeAgentDirectoryMemory,
  makeAgentSignUpsMemory,
  makeBetterAuthMemory,
  makeChangesMemory,
  makeCodeHostMemory,
  makeEnrolmentsMemory,
  makeEscalationsMemory,
  makeEventFeedMemory,
  makeIdsMemory,
  makeInboxMemory,
  makeManualClock,
  makeMembershipsMemory,
  makeNamespacesMemory,
  makeProbeLedgerMemory,
  makeProbeStoreMemory,
  makeProjectNamespacesMemory,
  makeProjectsMemory,
  makeDecisionsMemory,
  makeProjectViewsMemory,
  makeSessionsMemory,
  invitationsMemoryLayer,
  makeIssuesMemory,
  makeProposalLedgerMemory,
  makeSponsorshipsMemory,
  makeStandingsMemory,
  makeTokenIssuerMemory,
  makeRepoServerMemory,
  makeLanesMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
  makeUsersMemory,
  makeNamespaceUsageMemory,
  deliveryMemoryLayer,
  makeVerdictsMemory,
  makePlanStoreMemory,
} from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import { makeHandlers } from "../../src/adapters/driving/http/handlers.ts";
import { makeRunner } from "../../src/adapters/driving/http/run.ts";
import { doorwayOf } from "../../src/composition/doorway.ts";

const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const ACME = makeId("org", ulid());
const ANN = makeId("usr", ulid());
const NOW = Date.parse("2026-10-22T03:00:00Z");
const noApps = () => Promise.reject(new Error("no app registers here"));

/**
 * Acme's project `upstream` at `c`, `visibility` to Ann, who is no member of
 * acme, and Ann's fork of it in her own namespace, taken at `a`.
 */
async function world(visibility: "public" | "private") {
  const clock = makeManualClock();
  const directory = makeAgentDirectoryMemory();
  const inbox = makeInboxMemory();
  const projects = makeProjectsMemory();
  const places = makeProjectNamespacesMemory();
  const trunks = makeTrunksMemory();
  const upstream: ProjectId = makeId("prj", ulid());
  const fork: ProjectId = makeId("prj", ulid());
  for (const [projectId, seen] of [
    [upstream, visibility],
    [fork, "public"],
  ] as const)
    projects.setSettings(projectId, {
      protectedPaths: [],
      maxBatchSize: 1,
      verification: "required",
      visibility: seen,
    });
  places.places.set(upstream, { projectId: upstream, namespace: ACME, name: "upstream" });
  places.places.set(fork, { projectId: fork, namespace: ANN, name: "fork" });
  const rows = makeBetterAuthMemory({
    users: [{ id: ANN, username: "ann" }],
    orgs: [{ id: ACME, slug: "acme" }],
  });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeNamespaceUsageMemory().layer,
      directory.layer,
      projects.layer,
      trunks.layer,
      makeLanesMemory().layer,
      makeRepoServerMemory({ repos: new Map() }).layer,
      makeWorkspacePoolMemory().layer,
      makeEnrolmentsMemory().layer.pipe(Layer.provide(directory.layer)),
      makeAgentSignUpsMemory(rows).layer.pipe(Layer.provide(directory.layer)),
      makeSessionsMemory().layer.pipe(Layer.provide(directory.layer)),
      makeStandingsMemory().layer.pipe(Layer.provide(directory.layer)),
      makeSponsorshipsMemory().layer.pipe(Layer.provide(directory.layer)),
      invitationsMemoryLayer(),
      makeIssuesMemory().layer,
      makeProposalLedgerMemory().layer,
      deliveryMemoryLayer(),
      makeTokenIssuerMemory().layer.pipe(Layer.provide(clock.layer)),
      clock.layer,
      makeIdsMemory().layer,
      makeChangesMemory().layer,
      inbox.layer,
      inbox.notifier,
      makeEventFeedMemory().layer,
      makeProjectViewsMemory().layer,
      makeDecisionsMemory().layer,
      makeVerdictsMemory().layer,
      makePlanStoreMemory().layer,
      makeProbeStoreMemory().layer,
      makeProbeLedgerMemory().layer,
      makeEscalationsMemory(clock).layer,
      makeCodeHostMemory().layer,
      makeUsersMemory(rows).layer,
      makeMembershipsMemory(rows).layer,
      makeNamespacesMemory(rows).layer,
      places.layer,
    ),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const port = yield* Trunks;
      yield* port.initialize(upstream, sha("c"), "seed", { kind: "empty" });
      yield* port.initialize(fork, sha("a"), "fork", {
        kind: "forked",
        project: upstream,
        commit: sha("a"),
      });
    }),
  );
  const handlers = makeHandlers(
    makeRunner(runtime),
    { emailCode: false, github: false },
    doorwayOf("keel.test", noApps, () => new Date(NOW)),
  );
  return { handlers, trunks, upstream, fork };
}

const FRESH: SignedIn = { by: "passkey", at: NOW - 60_000 };
const ann: Caller = {
  requestId: "req-1",
  principal: {
    _tag: "User",
    userId: ANN,
    handle: "ann",
    suspended: false,
    memberships: [],
  } satisfies Principal,
  signedIn: FRESH,
  signal: new AbortController().signal,
};

const answer = (result: unknown): { status: number; body: Record<string, unknown> } => ({
  status: Number(Reflect.get(Object(result), "status")),
  body: Object(Reflect.get(Object(result), "body")),
});

describe("a fork's sync, through its handler", () => {
  it("[fork-sync.upstream-unread] a fork's owner who may no longer read its upstream is refused, and nothing is read or moved; one who may syncs", async () => {
    const hidden = await world("private");
    const refused = answer(
      await hidden.handlers.Operator_syncUpstream(ann, { projectId: hidden.fork }),
    );
    expect([refused.status, refused.body["code"]]).toEqual([403, "auth.forbidden"]);
    expect(String(refused.body["detail"])).toMatch(
      /may no longer read the project this fork was taken from/,
    );
    expect(hidden.trunks.syncedUp()).toEqual([]);
    const open = await world("public");
    const synced = answer(await open.handlers.Operator_syncUpstream(ann, { projectId: open.fork }));
    expect([synced.status, synced.body]).toEqual([
      200,
      { from: sha("a"), to: sha("c"), synced: true },
    ]);
  });

  it("[fork-sync.conflict-told] a path Keel cannot merge is 409 trunk.sync_conflicts naming it, with the way through: a change in the fork that takes the upstream's version, then sync again", async () => {
    const w = await world("public");
    w.trunks.conflictsOnSync(w.fork, "src/a.ts");
    const refused = answer(await w.handlers.Operator_syncUpstream(ann, { projectId: w.fork }));
    expect([refused.status, refused.body["code"]]).toEqual([409, "trunk.sync_conflicts"]);
    expect(String(refused.body["detail"])).toContain("src/a.ts");
    expect(refused.body["nextActions"]).toEqual([
      expect.objectContaining({ kind: "call", operationId: "declare" }),
      expect.objectContaining({ kind: "call", operationId: "Operator_syncUpstream" }),
    ]);
  });
});
