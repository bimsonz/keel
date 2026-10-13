import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@keeltown/core/kernel";
import { Lanes } from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
/** A project no lane has heard of. */
const freshProject = () => Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);

export function describeLanesContract(adapter: string, make: () => Layer.Layer<Lanes>) {
  describe(`Lanes contract: ${adapter}`, () => {
    it.live(
      "[lanes.contract.view] a project whose lane no change ever joined is shown its one lane, by the id its events would name, holding nothing: never a defect",
      () =>
        Effect.gen(function* () {
          const lanes = yield* Lanes;
          const projectId = freshProject();
          const empty = [{ id: `lane:${projectId}:main`, queued: 0, inFlight: 0 }];
          expect(yield* lanes.view(projectId)).toEqual(empty);
          // Looking makes nothing: the next reader is shown the same lane.
          expect(yield* lanes.view(projectId)).toEqual(empty);
        }).pipe(Effect.provide(make())),
    );
    it.todo("Lanes.destroy");
  });
}
