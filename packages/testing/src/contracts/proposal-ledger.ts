import { describe, expect, it } from "@effect/vitest";
import { MAX_OPEN_PROPOSALS } from "@keeltown/core/application/coordination";
import { type ChangeId, makeId, type ProjectId, userActor } from "@keeltown/core/kernel";
import { ProposalLedger } from "@keeltown/core/ports";
import { Effect, type Layer } from "effect";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const fresh = () =>
  Array.from({ length: 26 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join("");

/**
 * The `ProposalLedger` suite: a change id reserved per proposer and key, a
 * retry answered the same, another body under the key a conflict, and the cap
 * on what one proposer holds open on one project.
 */
export function describeProposalLedgerContract(
  adapter: string,
  make: () => Layer.Layer<ProposalLedger>,
) {
  describe(`ProposalLedger contract: ${adapter}`, () => {
    it.live(
      "[proposals.contract] reserves one change id per proposer and key, answers a retry the same, refuses another body under the key, and holds a proposer to MAX_OPEN_PROPOSALS on a project",
      () =>
        Effect.gen(function* () {
          const ledger = yield* ProposalLedger;
          const projectId: ProjectId = makeId("prj", fresh());
          const ann = userActor(makeId("usr", fresh()));
          const bob = userActor(makeId("usr", fresh()));
          const reserve = (proposer: typeof ann, key: string, body = key) =>
            ledger.reserve(projectId, { proposer, idempotencyKey: key, fingerprint: body });
          const ids: ChangeId[] = [];
          for (let n = 1; n <= MAX_OPEN_PROPOSALS; n += 1) ids.push(yield* reserve(ann, `k${n}`));
          expect(new Set(ids).size).toBe(MAX_OPEN_PROPOSALS);
          expect(yield* reserve(ann, "k1")).toBe(ids[0]);
          expect(yield* Effect.flip(reserve(ann, "k1", "another"))).toMatchObject({
            _tag: "IdempotencyConflict",
          });
          expect(yield* Effect.flip(reserve(ann, "k6"))).toMatchObject({
            _tag: "ProposalLimit",
            projectId,
            limit: MAX_OPEN_PROPOSALS,
          });
          expect(ids).not.toContain(yield* reserve(bob, "k1"));
        }).pipe(Effect.provide(make())),
    );
  });
}
