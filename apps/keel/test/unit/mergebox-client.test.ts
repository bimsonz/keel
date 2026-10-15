// MergeBox as the Lane's composer reaches it: a lease from the namespace's
// gate, held by the candidate, the compose in the project's box, and the lease
// given back whatever the box answered. What git refuses is the candidate's;
// what the box cannot do for its own sake is infra's, which the Lane holds.
import { CompositionRefused } from "@keeltown/core/domain/integration";
import { CommitSha, Instant, makeId, NamespaceId } from "@keeltown/core/kernel";
import type { CandidateRequest } from "@keeltown/core/ports";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  BOX_COMPOSE_MS,
  BOX_LEASE_MS,
  type BoxObjects,
  boxComposerRpc,
} from "../../src/adapters/driven/do-rpc/mergebox.ts";

const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const PROJECT = makeId("prj", "01J9ZZZZZZZZZZZZZZZZZZZZZA");
const NAMESPACE = Schema.decodeUnknownSync(NamespaceId)(
  makeId("org", "01J9ZZZZZZZZZZZZZZZZZZZZZC"),
);
const CANDIDATE = makeId("cnd", "01J9ZZZZZZZZZZZZZZZZZZZZZE");
const TIMINGS = { startMs: 0, composeMs: 10, checkMs: 5, checkBytes: 300 };
const CHECK = { canary: "found", tokens: "none" };

const REQUEST: CandidateRequest = {
  candidateId: CANDIDATE,
  staging: { namespace: "keel-core", name: "prj-staging" },
  base: sha("a"),
  at: Instant(1_791_709_200_250),
  members: [
    {
      changeId: makeId("chg", "01J9ZZZZZZZZZZZZZZZZZZZZZB"),
      repo: { namespace: "keel-ws-00", name: "prj-ws-1" },
      base: sha("b"),
      head: sha("c"),
      title: "Retry the webhook on 503",
    },
  ],
};

/** A gate that answers `lease`, a box that answers `answer`, and what each was asked. */
function objects(
  init: {
    placed?: boolean;
    lease?: () => Promise<unknown>;
    answer?: () => Promise<unknown>;
    release?: () => Promise<unknown>;
  } = {},
) {
  const asked: string[] = [];
  const requests: unknown[] = [];
  const boxes: BoxObjects = {
    namespaceOf: (projectId) => {
      asked.push(`place ${projectId}`);
      return Effect.succeed(init.placed === false ? Option.none() : Option.some(NAMESPACE));
    },
    gate: (namespace) => ({
      acquire: async (ask) => {
        asked.push(`acquire ${namespace} ${ask.holder} ${ask.ttlMs}`);
        return (init.lease ?? (async () => ({ granted: true, leaseId: "lse-1", expiresAt: 1 })))();
      },
      release: async (leaseId) => {
        asked.push(`release ${leaseId}`);
        return (init.release ?? (async () => undefined))();
      },
    }),
    box: (projectId) => ({
      compose: async (request) => {
        asked.push(`compose ${projectId}`);
        requests.push(request);
        return (
          init.answer ??
          (async () => ({
            kind: "composed",
            trees: ["1".repeat(40)],
            scratch: `refs/keel/box/${CANDIDATE}`,
            tip: "2".repeat(40),
            boxCheck: CHECK,
            timings: TIMINGS,
          }))
        )();
      },
    }),
  };
  return { boxes, asked, requests };
}

const composeWith = (boxes: BoxObjects) =>
  Effect.runPromise(Effect.exit(boxComposerRpc(() => PROJECT, boxes).compose(REQUEST)));

const refusalOf = (exit: Exit.Exit<unknown, CompositionRefused>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

const refused = (reason: string, paths: string[] = [], detail?: string) =>
  new CompositionRefused({ reason, paths, ...(detail === undefined ? {} : { detail }) });

/** A refusal's reason and paths, whatever its detail. */
const reasonOf = (exit: Exit.Exit<unknown, CompositionRefused>) => {
  const refusal = refusalOf(exit);
  return refusal instanceof CompositionRefused
    ? { reason: refusal.reason, paths: refusal.paths }
    : refusal;
};

const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("MergeBox's client", () => {
  it("[mergebox.client-composed] leases a box from the project's namespace's gate as the candidate, asks the project's box the candidate's compose, answers its trees and check, and gives the lease back", async () => {
    const world = objects();
    const exit = await composeWith(world.boxes);
    expect(exit).toEqual(
      Exit.succeed({
        trees: ["1".repeat(40)],
        scratch: `refs/keel/box/${CANDIDATE}`,
        tip: "2".repeat(40),
        boxCheck: CHECK,
      }),
    );
    expect(world.asked).toEqual([
      `place ${PROJECT}`,
      `acquire ${NAMESPACE} ${CANDIDATE} ${BOX_LEASE_MS}`,
      `compose ${PROJECT}`,
      "release lse-1",
    ]);
    expect(world.requests).toEqual([
      {
        v: 1,
        candidateId: CANDIDATE,
        staging: REQUEST.staging,
        base: REQUEST.base,
        members: [
          { repo: { namespace: "keel-ws-00", name: "prj-ws-1" }, base: sha("b"), head: sha("c") },
        ],
      },
    ]);
  });

  it("[mergebox.client-busy] a gate with no room, or one that does not answer, is box-unavailable, and the box is never asked", async () => {
    for (const lease of [
      async () => ({ granted: false, retryAfterMs: 30_000, held: 2, limit: 2 }),
      async () => {
        throw new Error("the gate is overloaded");
      },
      async () => ({ granted: "maybe" }),
    ]) {
      const world = objects({ lease });
      expect(refusalOf(await composeWith(world.boxes))).toEqual(refused("box-unavailable"));
      expect(world.asked.filter((line) => /^(compose|release)/.test(line))).toEqual([]);
    }
  });

  it("[mergebox.client-unplaced] a project with no namespace has no gate to ask: box-unavailable, nothing asked", async () => {
    const world = objects({ placed: false });
    expect(refusalOf(await composeWith(world.boxes))).toEqual(refused("box-unavailable"));
    expect(world.asked).toEqual([`place ${PROJECT}`]);
  });

  it("[mergebox.client-refusals] a conflict bounces with the box's paths, git crashing is git-crashed, and a box that fails, knows not the request, fails its check or does not answer is infra's; the lease is given back each time", async () => {
    const cases: [() => Promise<unknown>, CompositionRefused][] = [
      [
        async () => ({
          kind: "refused",
          member: 0,
          paths: ["src/a.ts", "src/b.ts"],
          timings: TIMINGS,
        }),
        refused("conflict", ["src/a.ts", "src/b.ts"]),
      ],
      [async () => ({ kind: "crashed", exitCode: 134 }), refused("git-crashed")],
      [async () => ({ kind: "failed", reason: "the box exited 3" }), refused("box-failed")],
      [async () => ({ kind: "unsupported", reason: "v2" }), refused("box-failed")],
      [async () => ({ kind: "check-failed", reason: "token-found" }), refused("box-check")],
      [async () => ({ kind: "composed" }), refused("box-failed")],
      [
        async () => {
          throw new Error("the container never started");
        },
        refused("box-failed"),
      ],
    ];
    for (const [answer, expected] of cases) {
      const world = objects({ answer });
      expect(reasonOf(await composeWith(world.boxes))).toEqual({
        reason: expected.reason,
        paths: expected.paths,
      });
      expect(world.asked.at(-1)).toBe("release lse-1");
    }
  });

  it.effect(
    "[mergebox.client-hung] a box that never answers is given up at BOX_COMPOSE_MS as one that did not answer: box-failed, naming the timeout, with the lease given back",
    () =>
      Effect.gen(function* () {
        const world = objects({ answer: () => new Promise<unknown>(() => {}) });
        const compose = yield* Effect.forkChild(
          Effect.exit(boxComposerRpc(() => PROJECT, world.boxes).compose(REQUEST)),
        );
        for (let i = 0; i < 1_000 && world.asked.at(-1) !== `compose ${PROJECT}`; i++)
          yield* Effect.yieldNow;
        expect(world.asked.at(-1)).toBe(`compose ${PROJECT}`);
        yield* TestClock.adjust(BOX_COMPOSE_MS);
        expect(refusalOf(yield* Fiber.join(compose))).toMatchObject({
          reason: "box-failed",
          detail: expect.stringMatching(/timed out/i),
        });
        expect(world.asked.at(-1)).toBe("release lse-1");
      }),
  );

  it("[mergebox.client-box-cause] a box that fails, or throws, says what failed as the refusal's detail, with no remote, account id or token", async () => {
    const thrown = objects({
      answer: async () => {
        throw new Error(
          `the box was not readied: trust exit 124: fatal: https://${ACCOUNT}.example/git/ws art_v1_leaked`,
        );
      },
    });
    expect(refusalOf(await composeWith(thrown.boxes))).toEqual(
      refused(
        "box-failed",
        [],
        "the box did not answer: the box was not readied: trust exit 124: fatal: <remote> <token>",
      ),
    );
    const failed = objects({
      answer: async () => ({ kind: "failed", reason: `fetch-failed: account ${ACCOUNT}` }),
    });
    expect(refusalOf(await composeWith(failed.boxes))).toEqual(
      refused("box-failed", [], "failed: fetch-failed: account <id>"),
    );
    const unknown = objects({ answer: async () => ({ kind: "unsupported", reason: "v2" }) });
    expect(refusalOf(await composeWith(unknown.boxes))).toEqual(
      refused("box-failed", [], "unsupported: v2"),
    );
  });

  it("[mergebox.client-release-fails] a lease that cannot be given back is left to its deadline, and the compose still answers", async () => {
    const world = objects({
      release: async () => {
        throw new Error("the gate is gone");
      },
    });
    const exit = await composeWith(world.boxes);
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
