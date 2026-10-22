// WorkspaceRebaser over a recording git server. pushTrunk: trunk's pack is
// fetched with the change's base (and the trunk last given) as haves, then
// pushed to the workspace's keel/trunk with that ref's current value as the
// explicit old one. pushProposal: a fork's commit is fetched from the fork's
// trunk past the haves it is given, admitted on its pack's length before any
// write token is minted, and pushed to the workspace's keel/proposal the same
// way. Artifacts' own compare-and-swap is proven live ([rebaser.live]); this
// proves what the adapter asks it to compare.
import { describe, expect, it } from "@effect/vitest";
import { QuotaExceeded } from "@keeltown/core/domain/identity";
import { CommitSha, makeId } from "@keeltown/core/kernel";
import {
  CodeHost,
  KEEL_PROPOSAL_REF,
  KEEL_TRUNK_REF,
  type RepoRef,
  WorkspaceRebaser,
} from "@keeltown/core/ports";
import { makeCodeHostMemory } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { afterEach, vi } from "vitest";
import { WorkspaceRebaserGitCore } from "../../src/adapters/driven/gitcore/workspace-rebaser.ts";
import { gitServer, PACK, type Reply } from "./git-server.ts";

const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const PROJECT = makeId("prj", "01KRBSRCNTRCT0000000000000");
const TRUNK: RepoRef = { namespace: "memory", name: "prj" };
const WORKSPACE: RepoRef = { namespace: "memory", name: "prj-ws-01" };
const BASE = sha("a");
const HEAD = sha("b");
const ZERO = "0".repeat(40);

/** Trunk and the workspace in memory, every minted token recorded, and the server's requests. */
function rebasing(replies: Reply[]) {
  const server = gitServer(replies);
  vi.stubGlobal("fetch", server.fetch);
  const code = makeCodeHostMemory();
  const minted: string[] = [];
  const spied = Layer.effect(
    CodeHost,
    Effect.map(CodeHost, (h) =>
      CodeHost.of({
        ...h,
        mintToken: (repo, access, ttl) => {
          minted.push(`${repo.name} ${access} ${ttl}s`);
          return h.mintToken(repo, access, ttl);
        },
      }),
    ),
  ).pipe(Layer.provide(code.layer));
  const layer = WorkspaceRebaserGitCore(() => TRUNK).pipe(Layer.provide(spied));
  const seeded = Effect.gen(function* () {
    const h = yield* CodeHost;
    yield* h.create(TRUNK);
    yield* h.create(WORKSPACE);
  }).pipe(Effect.provide(code.layer));
  /** The workspace's keel/trunk at a commit of its own: a trunk given by an earlier rebase. */
  const given = code.fixture.commit(WORKSPACE, KEEL_TRUNK_REF, { "README.md": "given\n" });
  const pushTo = (head: CommitSha) =>
    Effect.flatMap(WorkspaceRebaser, (r) => r.pushTrunk(PROJECT, WORKSPACE, BASE, head)).pipe(
      Effect.provide(layer),
    );
  return { server, minted, seeded, given, pushTo, push: pushTo(HEAD) };
}

/** A recorded request, with the token's per-mint counter dropped. */
const plainRequest = ({ auth, ...r }: { readonly auth: string | null }) => ({
  ...r,
  auth: auth?.replace(/_\d+$/, ""),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkspaceRebaser.pushTrunk", () => {
  it.effect(
    "[rebaser.cas] fetches trunk's head past the change's base and pushes it to keel/trunk with the ref's current value as old",
    () =>
      Effect.gen(function* () {
        const first = rebasing(["ok"]);
        yield* first.seeded;
        expect(yield* first.push).toBe("advanced");
        expect(first.server.requests.map(plainRequest)).toEqual([
          {
            service: "upload-pack",
            repo: "memory/prj.git",
            auth: "Bearer memrepo_read_memory/prj",
            lines: [expect.stringMatching(new RegExp(`^want ${HEAD} `)), `have ${BASE}`, "done"],
          },
          {
            service: "receive-pack",
            repo: "memory/prj-ws-01.git",
            auth: "Bearer memrepo_write_memory/prj-ws-01",
            lines: [`${ZERO} ${HEAD} ${KEEL_TRUNK_REF}`],
          },
        ]);
        expect(first.minted).toEqual(["prj read 60s", "prj-ws-01 write 60s"]);

        vi.unstubAllGlobals();
        const again = rebasing(["ok"]);
        yield* again.seeded;
        const held = yield* again.given;
        expect(yield* again.push).toBe("advanced");
        expect(again.server.requests.map((r) => [r.service, r.lines.slice(1)])).toEqual([
          ["upload-pack", [`have ${BASE}`, `have ${held}`, "done"]],
          ["receive-pack", []],
        ]);
        expect(again.server.requests[1]?.lines[0]).toBe(`${held} ${HEAD} ${KEEL_TRUNK_REF}`);
      }),
  );

  it.effect(
    "[rebaser.stale] a keel/trunk that moved under the push is read again and pushed from its new value; one that keeps moving is PushRejected stale",
    () =>
      Effect.gen(function* () {
        const once = rebasing(["stale", "ok"]);
        yield* once.seeded;
        expect(yield* once.push).toBe("advanced");
        expect(once.server.requests.filter((r) => r.service === "receive-pack")).toHaveLength(2);

        vi.unstubAllGlobals();
        const always = rebasing(["stale", "stale", "stale", "stale"]);
        yield* always.seeded;
        expect(yield* Effect.flip(always.push)).toMatchObject({
          _tag: "PushRejected",
          reason: "stale",
        });
        expect(always.server.requests.filter((r) => r.service === "receive-pack")).toHaveLength(4);
      }),
  );

  it.effect(
    "[rebaser.busy] a workspace that stays busy is PushRejected busy; a keel/trunk already at the head sends nothing",
    () =>
      Effect.gen(function* () {
        const busy = rebasing(["busy", "busy", "busy", "busy"]);
        yield* busy.seeded;
        expect(yield* Effect.flip(busy.push)).toMatchObject({
          _tag: "PushRejected",
          reason: "busy",
        });

        vi.unstubAllGlobals();
        const done = rebasing([]);
        yield* done.seeded;
        const held = yield* done.given;
        expect(yield* done.pushTo(held)).toBe("unchanged");
        expect(done.server.requests).toEqual([]);
      }),
  );
});

const FORK: RepoRef = { namespace: "memory", name: "fork" };
const PROPOSED = sha("c");
const GRANTED = sha("d");
const FULL: QuotaExceeded = new QuotaExceeded({
  kind: "repo-bytes",
  reason: "limit",
  limit: 1,
  used: 1,
  requested: PACK.length,
  nextActions: [{ kind: "escalate", title: "Ask an owner to free space" }],
});

/** The fork's trunk and the workspace in memory; every token minted and every admission, in order. */
function proposing(replies: Reply[], pack: Uint8Array = PACK) {
  const server = gitServer(replies, pack);
  vi.stubGlobal("fetch", server.fetch);
  const code = makeCodeHostMemory();
  const said: string[] = [];
  const spied = Layer.effect(
    CodeHost,
    Effect.map(CodeHost, (h) =>
      CodeHost.of({
        ...h,
        mintToken: (repo, access, ttl) => {
          said.push(`${repo.name} ${access} ${ttl}s`);
          return h.mintToken(repo, access, ttl);
        },
      }),
    ),
  ).pipe(Layer.provide(code.layer));
  const layer = WorkspaceRebaserGitCore(() => TRUNK).pipe(Layer.provide(spied));
  const seeded = Effect.gen(function* () {
    const h = yield* CodeHost;
    yield* h.create(FORK);
    yield* h.create(WORKSPACE);
  }).pipe(Effect.provide(code.layer));
  const admitted = (bytes: number) => Effect.sync(() => void said.push(`admit ${bytes}`));
  const refused = (bytes: number) =>
    Effect.suspend(() => {
      said.push(`admit ${bytes}`);
      return Effect.fail(FULL);
    });
  const propose = (
    commit: CommitSha,
    admit: (bytes: number) => Effect.Effect<void, QuotaExceeded> = admitted,
  ) =>
    Effect.flatMap(WorkspaceRebaser, (r) =>
      r.pushProposal(FORK, WORKSPACE, commit, [BASE, GRANTED], admit),
    ).pipe(Effect.provide(layer));
  /** The workspace's keel/proposal at a commit of its own: one proposed before. */
  const given = code.fixture.commit(WORKSPACE, KEEL_PROPOSAL_REF, { "README.md": "proposed\n" });
  return { server, said, seeded, given, propose, refused };
}

describe("WorkspaceRebaser.pushProposal", () => {
  it.effect(
    "[rebaser.proposal] fetches the fork's commit past the haves it is given, admits the pack's length before any write token is minted, and pushes it to keel/proposal with the ref's current value as old",
    () =>
      Effect.gen(function* () {
        const first = proposing(["ok"]);
        yield* first.seeded;
        expect(yield* first.propose(PROPOSED)).toBe("advanced");
        expect(first.server.requests.map(plainRequest)).toEqual([
          {
            service: "upload-pack",
            repo: "memory/fork.git",
            auth: "Bearer memrepo_read_memory/fork",
            lines: [
              expect.stringMatching(new RegExp(`^want ${PROPOSED} `)),
              `have ${BASE}`,
              `have ${GRANTED}`,
              "done",
            ],
          },
          {
            service: "receive-pack",
            repo: "memory/prj-ws-01.git",
            auth: "Bearer memrepo_write_memory/prj-ws-01",
            lines: [`${ZERO} ${PROPOSED} ${KEEL_PROPOSAL_REF}`],
          },
        ]);
        expect(first.said).toEqual([
          "fork read 60s",
          `admit ${PACK.length}`,
          "prj-ws-01 write 60s",
        ]);

        // A proposal moved to another commit: pushed from the one it held, the pack fetched and admitted once.
        vi.unstubAllGlobals();
        const again = proposing(["stale", "ok"]);
        yield* again.seeded;
        const held = yield* again.given;
        expect(yield* again.propose(PROPOSED)).toBe("advanced");
        const pushes = again.server.requests.filter((r) => r.service === "receive-pack");
        expect(pushes.map((r) => r.lines[0])).toEqual([
          `${held} ${PROPOSED} ${KEEL_PROPOSAL_REF}`,
          `${held} ${PROPOSED} ${KEEL_PROPOSAL_REF}`,
        ]);
        expect(again.said.filter((line) => line.startsWith("admit"))).toEqual([
          `admit ${PACK.length}`,
        ]);
        expect(again.server.requests.filter((r) => r.service === "upload-pack")).toHaveLength(1);
      }),
  );

  it.effect(
    "[rebaser.proposal-refused] an admission refused writes nothing and mints no write token; a pack over the cap is PackTooLarge, admitted and pushed nowhere; a keel/proposal that keeps moving is PushRejected stale, a busy one busy; one already at the commit sends nothing",
    () =>
      Effect.gen(function* () {
        const full = proposing(["ok"]);
        yield* full.seeded;
        expect(yield* Effect.flip(full.propose(PROPOSED, full.refused))).toMatchObject({
          _tag: "QuotaExceeded",
          kind: "repo-bytes",
        });
        expect(full.server.requests.map((r) => r.service)).toEqual(["upload-pack"]);
        expect(full.said).toEqual(["fork read 60s", `admit ${PACK.length}`]);

        vi.unstubAllGlobals();
        const big = new Uint8Array(61 * 1024 * 1024);
        big.set(PACK);
        const over = proposing(["ok"], big);
        yield* over.seeded;
        expect(yield* Effect.flip(over.propose(PROPOSED))).toMatchObject({
          _tag: "PackTooLarge",
          repo: WORKSPACE,
        });
        expect(over.server.requests.map((r) => r.service)).toEqual(["upload-pack"]);
        expect(over.said).toEqual(["fork read 60s"]);

        vi.unstubAllGlobals();
        const moving = proposing(["stale", "stale", "stale", "stale"]);
        yield* moving.seeded;
        expect(yield* Effect.flip(moving.propose(PROPOSED))).toMatchObject({
          _tag: "PushRejected",
          reason: "stale",
        });
        expect(moving.server.requests.filter((r) => r.service === "receive-pack")).toHaveLength(4);

        vi.unstubAllGlobals();
        const busy = proposing(["busy", "busy", "busy", "busy"]);
        yield* busy.seeded;
        expect(yield* Effect.flip(busy.propose(PROPOSED))).toMatchObject({
          _tag: "PushRejected",
          reason: "busy",
        });

        vi.unstubAllGlobals();
        const done = proposing([]);
        yield* done.seeded;
        const held = yield* done.given;
        expect(yield* done.propose(held)).toBe("unchanged");
        expect(done.server.requests).toEqual([]);
      }),
  );
});
