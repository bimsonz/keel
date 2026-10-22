// Proposals through the handlers the routes and the MCP tools dispatch into,
// behind the one policy: a person proposes from their fork, a maintainer
// approves the commit they read, and each refusal is told by its own code.
import type { SignedIn } from "@keeltown/core/application/identity";
import { projectRepos } from "@keeltown/core/application/integration";
import type { Principal } from "@keeltown/core/domain/identity";
import { type CommitSha, makeId, type ProjectId, type UserId } from "@keeltown/core/kernel";
import { CodeHost, Trunks } from "@keeltown/core/ports";
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
  makeProposalLedgerMemory,
  makeDecisionsMemory,
  makeProjectViewsMemory,
  makeSessionsMemory,
  invitationsMemoryLayer,
  makeIssuesMemory,
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
  CodeHostFixture,
  projectEvents,
} from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import { makeHandlers } from "../../src/adapters/driving/http/handlers.ts";
import { makeRunner } from "../../src/adapters/driving/http/run.ts";
import { doorwayOf } from "../../src/composition/doorway.ts";

const ACME = makeId("org", ulid());
const ANN = makeId("usr", ulid());
const MAY = makeId("usr", ulid());
const NOW = Date.parse("2026-10-22T04:00:00Z");
const MAIN = "refs/heads/main";
const noApps = () => Promise.reject(new Error("no app registers here"));

/**
 * Acme's public project `upstream`, which May maintains, and Ann's fork of it
 * in her own namespace: its trunk the fork point `a`, a landing `f`, and `off`,
 * a commit that never reached its main.
 */
async function world(options: { readonly proposals?: "open" | "closed" } = {}) {
  const clock = makeManualClock();
  const directory = makeAgentDirectoryMemory();
  const inbox = makeInboxMemory();
  const projects = makeProjectsMemory();
  const places = makeProjectNamespacesMemory();
  const trunks = makeTrunksMemory();
  const changes = makeChangesMemory();
  const views = makeProjectViewsMemory();
  const code = makeCodeHostMemory();
  const upstream: ProjectId = makeId("prj", ulid());
  const fork: ProjectId = makeId("prj", ulid());
  projects.setSettings(upstream, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
    visibility: "public",
    proposals: options.proposals ?? "open",
  });
  projects.setSettings(fork, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
    visibility: "public",
  });
  places.places.set(upstream, { projectId: upstream, namespace: ACME, name: "upstream" });
  places.places.set(fork, { projectId: fork, namespace: ANN, name: "fork" });
  const rows = makeBetterAuthMemory({
    users: [
      { id: ANN, username: "ann" },
      { id: MAY, username: "may" },
    ],
    orgs: [{ id: ACME, slug: "acme" }],
    members: [{ userId: MAY, organizationId: ACME, role: "maintainer" }],
  });
  const trunk = projectRepos(fork).trunk;
  const commits = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(trunk);
      const at = (ref: string, files: Record<string, string>, merged?: readonly CommitSha[]) =>
        Effect.flatMap(CodeHostFixture, (f) => f.commit(trunk, ref, files, merged));
      const a = yield* at(MAIN, { "README.md": "upstream\n" });
      const f = yield* at(MAIN, { "README.md": "upstream\n", "retry.ts": "1\n" });
      const off = yield* at("refs/heads/side", { "README.md": "side\n" }, [a]);
      return { a, f, off };
    }).pipe(Effect.provide(code.layer)),
  );
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
      changes.layer,
      inbox.layer,
      inbox.notifier,
      makeEventFeedMemory().layer,
      views.layer,
      makeDecisionsMemory().layer,
      makeVerdictsMemory().layer,
      makePlanStoreMemory().layer,
      makeProbeStoreMemory().layer,
      makeProbeLedgerMemory().layer,
      makeEscalationsMemory(clock).layer,
      code.layer,
      makeUsersMemory(rows).layer,
      makeMembershipsMemory(rows).layer,
      makeNamespacesMemory(rows).layer,
      places.layer,
    ),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const port = yield* Trunks;
      yield* port.initialize(upstream, commits.a, "seed", { kind: "empty" });
      yield* port.initialize(fork, commits.a, "fork", {
        kind: "forked",
        project: upstream,
        commit: commits.a,
      });
    }),
  );
  trunks.heads.set(fork, commits.f);
  const handlers = makeHandlers(
    makeRunner(runtime),
    { emailCode: false, github: false },
    doorwayOf("keel.test", noApps, () => new Date(NOW)),
  );
  return { handlers, upstream, fork, commits, changes, views };
}

const FRESH: SignedIn = { by: "passkey", at: NOW - 60_000 };
const person = (
  userId: UserId,
  memberships: readonly { readonly org: typeof ACME; readonly role: "maintainer" }[] = [],
): Caller => ({
  requestId: "req-1",
  principal: {
    _tag: "User",
    userId,
    handle: userId === ANN ? "ann" : "may",
    suspended: false,
    memberships: [...memberships],
  } satisfies Principal,
  signedIn: FRESH,
  signal: new AbortController().signal,
});
const ann = person(ANN);
const may = person(MAY, [{ org: ACME, role: "maintainer" }]);

const answer = (result: unknown): { status: number; body: Record<string, unknown> } => ({
  status: Number(Reflect.get(Object(result), "status")),
  body: Object(Reflect.get(Object(result), "body")),
});
const refusal = (result: unknown) => {
  const a = answer(result);
  return [a.status, a.body["code"]];
};

describe("proposals, through their handlers", () => {
  it("[proposals.http] a person proposes their fork's landing; the maintainer's approval of another commit is proposal.commit_moved, of the commit read is the change approved; the proposer closes it", async () => {
    const w = await world();
    const proposed = answer(
      await w.handlers.propose(ann, {
        projectId: w.upstream,
        fork: w.fork,
        commit: w.commits.f,
        goal: "Retry a refused push",
        "idempotency-key": "p1",
      }),
    );
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({
      origin: "proposal",
      proposal: { fork: w.fork, commit: w.commits.f, proposer: `user:${ANN}` },
      state: "submitted",
    });
    expect(proposed.body).not.toHaveProperty("agentId");
    const changeId = String(proposed.body["id"]);
    expect(
      refusal(
        await w.handlers.approveProposal(may, {
          changeId,
          commit: w.commits.a,
          "idempotency-key": "a0",
        }),
      ),
    ).toEqual([409, "proposal.commit_moved"]);
    const approved = answer(
      await w.handlers.approveProposal(may, {
        changeId,
        commit: w.commits.f,
        "idempotency-key": "a1",
      }),
    );
    expect([approved.status, approved.body["proposal"]]).toEqual([
      200,
      expect.objectContaining({ approved: w.commits.f }),
    ]);
    const closed = answer(
      await w.handlers.closeProposal(ann, { changeId, "idempotency-key": "c1" }),
    );
    expect([closed.status, closed.body["state"]]).toEqual([200, "withdrawn"]);
  });

  it("[proposals.http-refusals] each refusal of a proposal is told by its own code: not a fork, a commit off the fork, nothing to propose, closed to proposals, and the proposer approving their own", async () => {
    const w = await world();
    const stranger: ProjectId = makeId("prj", ulid());
    const asked = (over: Record<string, string>) =>
      w.handlers.propose(ann, {
        projectId: w.upstream,
        fork: w.fork,
        commit: w.commits.f,
        goal: "g",
        "idempotency-key": `k-${ulid()}`,
        ...over,
      });
    expect(refusal(await asked({ commit: w.commits.off }))).toEqual([
      409,
      "proposal.commit_not_on_fork",
    ]);
    expect(refusal(await asked({ commit: w.commits.a }))).toEqual([409, "proposal.empty"]);
    // A fork Ann may not read is no fork of hers to propose from.
    expect(refusal(await asked({ fork: stranger }))[0]).toBe(404);
    const proposed = answer(await asked({}));
    expect(
      refusal(
        await w.handlers.approveProposal(ann, {
          changeId: String(proposed.body["id"]),
          commit: w.commits.f,
          "idempotency-key": "self",
        }),
      )[0],
    ).toBe(403);
    const shut = await world({ proposals: "closed" });
    expect(
      refusal(
        await shut.handlers.propose(ann, {
          projectId: shut.upstream,
          fork: shut.fork,
          commit: shut.commits.f,
          goal: "g",
          "idempotency-key": "k",
        }),
      ),
    ).toEqual([403, "auth.forbidden"]);
  });

  it("[proposals.http-list] a project's proposals list holds its open proposals, and its closed ones when asked", async () => {
    const w = await world();
    const events = projectEvents(w.upstream);
    const open = makeId("chg", ulid());
    for (const event of events.proposed(open, w.fork, w.commits.f, `user:${ANN}`))
      await Effect.runPromise(w.views.arrive(event));
    const listed = answer(await w.handlers.proposals(ann, { projectId: w.upstream }));
    expect(listed.status).toBe(200);
    expect(listed.body["items"]).toEqual([
      expect.objectContaining({ changeId: open, origin: "proposal" }),
    ]);
    const closed = answer(
      await w.handlers.proposals(ann, { projectId: w.upstream, state: "closed" }),
    );
    expect(closed.body["items"]).toEqual([]);
  });
});
