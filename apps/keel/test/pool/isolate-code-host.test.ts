// The HTTP isolate's CodeHost as composed for keel.town: a change's diff reads
// its workspace in keel-ws-00 until it lands, so the isolate serves that
// namespace as well as the core one, as every other CodeHost does.
import { env } from "cloudflare:workers";
import { CommitSha } from "@keeltown/core/kernel";
import { CodeHost } from "@keeltown/core/ports";
import { Effect, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { isolateLayer } from "../../src/composition/isolate.ts";

/** The head the fake namespace gives a repo it creates: the SHA-1 of its name. */
async function headOf(name: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(name));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("the isolate's CodeHost", () => {
  it("[isolate.workspace-reads] reads a repo in the workspaces namespace, where a change not yet landed is", async () => {
    if (env.TEST_ARTIFACTS === undefined) throw new Error("vitest.config.ts binds TEST_ARTIFACTS");
    const name = `ws-${ulid().toLowerCase()}`;
    await env.TEST_ARTIFACTS.create(name);
    const repo = { namespace: "keel-ws-00", name };
    const head = CommitSha.make(await headOf(name));
    const runtime = ManagedRuntime.make(isolateLayer(env));
    try {
      const held = await runtime.runPromise(
        CodeHost.use((host) =>
          Effect.all([
            host.hasCommit(repo, head),
            host.hasCommit(repo, CommitSha.make("0".repeat(40))),
          ]),
        ),
      );
      expect(held).toEqual([true, false]);
    } finally {
      await runtime.dispose();
    }
  });
});
