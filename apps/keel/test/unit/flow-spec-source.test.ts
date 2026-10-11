import { describe, expect, it } from "@effect/vitest";
import { CodeHost, FlowSpecSource } from "@keeltown/core/ports";
import { describeFlowSpecSourceContract, makeCodeHostMemory } from "@keeltown/testing";
import { Effect, Layer } from "effect";
import { FlowSpecSourceCodeHost } from "../../src/adapters/driven/gitcore/flow-spec-source.ts";

const MAIN = "refs/heads/main";

/** FlowSpecSourceCodeHost over the in-memory CodeHost, which keeps real git objects. */
const harness = () => {
  const host = makeCodeHostMemory();
  return {
    host,
    layer: FlowSpecSourceCodeHost.pipe(Layer.provide(host.layer)),
    commit: (files: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const repo = yield* (yield* CodeHost).create(host.fixture.scratch());
        const base = yield* host.fixture.commit(repo, MAIN, files);
        return { repo, base };
      }).pipe(Effect.provide(host.layer), Effect.orDie),
  };
};

describeFlowSpecSourceContract("CodeHost", harness);

describe("FlowSpecSourceCodeHost", () => {
  it.effect(
    "[flow-source.base-not-head] reads the commit it is given, not the ref's newer head",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const { repo, base } = yield* h.commit({ ".keel/flow.json": "base", "package.json": "{}" });
        yield* h.host.fixture
          .commit(repo, MAIN, { ".keel/flow.json": "head", "package.json": "{}" })
          .pipe(Effect.provide(h.host.layer), Effect.orDie);
        const sources = yield* (yield* FlowSpecSource).read(repo, base);
        expect(sources.flowJson).toBe("base");
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect(
    "[flow-source.no-symlink] a symlinked package.json or flow is not followed: it reads as absent",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const repo = yield* (yield* CodeHost).create(h.host.fixture.scratch());
        const base = yield* h.host.fixture.commit(repo, MAIN, {
          "package.json": { mode: "120000", data: "../elsewhere/package.json" },
          ".keel/flow.json": { mode: "120000", data: "../../flow.json" },
        });
        const sources = yield* Effect.gen(function* () {
          return yield* (yield* FlowSpecSource).read(repo, base);
        }).pipe(Effect.provide(h.layer));
        expect(sources.packageJson).toBeUndefined();
        expect(sources.flowJson).toBeUndefined();
      }).pipe(Effect.provide(h.host.layer), Effect.orDie);
    },
  );
});
