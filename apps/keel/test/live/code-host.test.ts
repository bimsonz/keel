// The CodeHost contract against Artifacts itself: the staging workspace
// namespace, through the WORKSPACES binding. Every repo it makes is deleted
// afterwards.
import { CodeHost } from "@keeltown/core/ports";
import { PORTS } from "@keeltown/testing";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { afterAll, expect, it } from "vitest";
import { CodeHostArtifacts } from "../../src/adapters/driven/artifacts/code-host.ts";
import { artifactsFixture } from "./fixture.ts";

const NAMESPACE = "keel-ws-00";
const host = CodeHostArtifacts({ [NAMESPACE]: env.WORKSPACES });
const fixture = artifactsFixture(NAMESPACE, env.WORKSPACES);

PORTS.CodeHost.contract("artifacts (keel-ws-00)", () => Layer.mergeAll(host, fixture.layer));

/** The states of a repo's tokens, as the binding lists them. */
async function tokenStates(name: string): Promise<string[]> {
  const handle = await env.WORKSPACES.get(name);
  try {
    return (await handle.listTokens()).tokens.map((t) => t.state);
  } finally {
    handle[Symbol.dispose]();
  }
}

it("[artifacts.no-standing-token] leaves no active token on a repo it created or forked; a raw create leaves one", async () => {
  const [source, target, control] = [
    fixture.fixture.scratch(),
    fixture.fixture.scratch(),
    fixture.fixture.scratch(),
  ];
  await Effect.runPromise(
    Effect.gen(function* () {
      const codeHost = yield* CodeHost;
      yield* codeHost.create(source);
      yield* codeHost.fork(source, target);
    }).pipe(Effect.provide(host)),
  );
  await env.WORKSPACES.create(control.name);
  const [created, forked, raw] = await Promise.all([
    tokenStates(source.name),
    tokenStates(target.name),
    tokenStates(control.name),
  ]);
  console.log(
    `LIVE token states: created ${JSON.stringify(created)}, forked ${JSON.stringify(forked)}, raw create ${JSON.stringify(raw)}`,
  );
  expect([...created, ...forked].filter((state) => state === "active")).toEqual([]);
  // The control: without the revoke, the binding lists the initial token as active.
  expect(raw).toContain("active");
});

afterAll(async () => {
  await Promise.all(fixture.made.map((repo) => env.WORKSPACES.delete(repo.name)));
  console.log(`LIVE cleanup: deleted ${fixture.made.length} scratch repos`);
});
