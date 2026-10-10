import { CompositionRefused, UnexpectedHead } from "@keeltown/core/domain/integration";
import { CommitSha } from "@keeltown/core/kernel";
import { CandidateComposer, TrunkWriter } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";

const sha = async (text: string): Promise<CommitSha> => {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return Schema.decodeUnknownSync(CommitSha)(hex);
};

/**
 * Composes deterministically: the tree id is a hash of the base and the
 * members, so recomposing the same batch gives the same id. `refuse` lists
 * change ids whose composition is refused, as GitCore refuses when unsure.
 */
export function makeCandidateComposerMemory(options: { readonly refuse?: readonly string[] } = {}) {
  return {
    layer: Layer.succeed(
      CandidateComposer,
      CandidateComposer.of({
        compose: (base, members) =>
          Effect.gen(function* () {
            const refused = members.filter((m) => options.refuse?.includes(m.changeId));
            if (refused.length > 0) return yield* new CompositionRefused({ reason: "overlapping edits", paths: [] });
            const treeSha = yield* Effect.promise(() => sha([base, ...members.map((m) => m.commit)].join("\n")));
            return { treeSha, tier: { tier: 0, reason: "path-disjoint members" } };
          }),
      }),
    ),
  };
}

/** One head. A push from anything but the head is refused, as a fenced writer must refuse it. */
export function makeTrunkWriterMemory(initial: CommitSha) {
  let current = initial;
  return {
    head: () => current,
    /** Moves trunk behind the writer's back, to exercise the read-back freeze. */
    interfere: (to: CommitSha) => {
      current = to;
    },
    layer: Layer.succeed(
      TrunkWriter,
      TrunkWriter.of({
        head: Effect.sync(() => current),
        push: (from, to) =>
          Effect.suspend(() => {
            if (from !== current) return Effect.fail(new UnexpectedHead({ expected: from, observed: current }));
            current = to;
            return Effect.void;
          }),
      }),
    ),
  };
}
