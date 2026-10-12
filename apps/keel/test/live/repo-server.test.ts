// RepoServer against Artifacts itself, on scratch repos in the staging
// workspace namespace: what a git client's fetch asks of the host's remote, in
// protocol v0 and v2, through a read token minted per request. Every repo it
// makes is deleted afterwards.
import { PORTS } from "@keeltown/testing";
import { env } from "cloudflare:workers";
import { Layer } from "effect";
import { afterAll } from "vitest";
import { CodeHostArtifacts } from "../../src/adapters/driven/artifacts/code-host.ts";
import { RepoServerArtifacts } from "../../src/adapters/driven/artifacts/repo-server.ts";
import { artifactsFixture } from "./fixture.ts";

const NAMESPACE = "keel-ws-00";
const host = CodeHostArtifacts({ [NAMESPACE]: env.WORKSPACES });
const fixture = artifactsFixture(NAMESPACE, env.WORKSPACES);

afterAll(async () => {
  await Promise.all(fixture.made.map((repo) => env.WORKSPACES.delete(repo.name)));
});

PORTS.RepoServer.contract("artifacts (keel-ws-00)", () =>
  Layer.mergeAll(RepoServerArtifacts().pipe(Layer.provide(host)), host, fixture.layer),
);
