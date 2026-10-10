import { CodeHost } from "@keeltown/core/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CodeHostArtifacts } from "../../src/adapters/driven/artifacts/code-host.ts";
import { FakeArtifacts } from "./fake-artifacts.ts";

describe("CodeHost on Artifacts: credentials", () => {
  it("[artifacts.no-standing-token] revokes the write token that create and fork hand back", async () => {
    const binding = new FakeArtifacts();
    const run = Effect.gen(function* () {
      const host = yield* CodeHost;
      const source = yield* host.create({ namespace: "keel-ws-00", name: "mirror" });
      yield* host.fork(source, { namespace: "keel-ws-00", name: "ws-1" });
    }).pipe(Effect.provide(CodeHostArtifacts({ "keel-ws-00": binding })));
    await Effect.runPromise(run);
    const states = [...binding.repos].map(([name, tokens]) => [name, tokens.map((t) => t.state)]);
    expect(states).toEqual([
      ["mirror", ["revoked"]],
      ["ws-1", ["revoked"]],
    ]);
  });
});
