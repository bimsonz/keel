// Keel's OAuth client on Cloudflare, as the adapter speaks it: no step runs
// without a registered client, a consent URL carries the S256 challenge of the
// verifier it hands back, and a Basic credential escapes what RFC 6749 says.
import { readFileSync } from "node:fs";
import { makeId } from "@keeltown/core/kernel";
import { CloudflareOAuth } from "@keeltown/core/ports";
import { Effect, Exit, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import {
  challengeOf,
  CLOUDFLARE_SCOPES,
  CloudflareOAuthLive,
  formEncode,
} from "../../src/adapters/driven/deploy/cloudflare-oauth.ts";

const PROJECT = makeId("prj", "01M4P00000000000000000000P");

const run = <A, E>(clientId: string, program: Effect.Effect<A, E, CloudflareOAuth>) => {
  const asked: string[] = [];
  const layer = CloudflareOAuthLive({
    clientId,
    clientSecret: async () => "secret",
    redirectUri: "https://keel.test/v1/cloudflare/callback",
    fetch: async (url) => {
      asked.push(url);
      return Response.json({}, { status: 500 });
    },
  });
  return { asked, exit: Effect.runPromiseExit(program.pipe(Effect.provide(layer))) };
};

/** What a failed run's cause says, or `succeeded`. */
const causeOf = async (exit: Promise<Exit.Exit<unknown, unknown>>) => {
  const ended = await exit;
  return Exit.isFailure(ended) ? JSON.stringify(ended.cause) : "succeeded";
};

describe("Keel's OAuth client on Cloudflare", () => {
  it("[oauth.unconfigured] with no client registered, no step runs and nothing is asked of Cloudflare", async () => {
    const begun = run(
      "",
      CloudflareOAuth.use((oauth) => oauth.begin(PROJECT)),
    );
    const exchanged = run(
      "",
      CloudflareOAuth.use((oauth) => oauth.exchange("code", "verifier")),
    );
    for (const { asked, exit } of [
      { asked: begun.asked, exit: causeOf(begun.exit) },
      { asked: exchanged.asked, exit: causeOf(exchanged.exit) },
    ]) {
      expect(await exit).toContain('"unconfigured"');
      expect(asked).toEqual([]);
    }
  });

  it("[oauth.begin] a consent URL carries the S256 challenge of the verifier it answers, and a nonce of its own", async () => {
    const first = await run(
      "client",
      CloudflareOAuth.use((oauth) => oauth.begin(PROJECT)),
    ).exit;
    const second = await run(
      "client",
      CloudflareOAuth.use((oauth) => oauth.begin(PROJECT)),
    ).exit;
    if (!Exit.isSuccess(first) || !Exit.isSuccess(second)) throw new Error("begin failed");
    const query = new URL(first.value.url).searchParams;
    expect(query.get("code_challenge")).toBe(await challengeOf(first.value.verifier));
    expect(query.get("state")).toBe(`${PROJECT}.${first.value.nonce}`);
    expect(first.value.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.value.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.value.nonce).not.toBe(first.value.nonce);
    expect(second.value.verifier).not.toBe(first.value.verifier);
  });

  it("[oauth.refused] an exchange Cloudflare refuses names the step and its status, never the code", async () => {
    const { exit } = run(
      "client",
      CloudflareOAuth.use((oauth) => oauth.exchange("the-code", "the-verifier")),
    );
    const ended = await exit;
    const said = Exit.isFailure(ended) ? JSON.stringify(ended.cause) : "";
    expect(said).toContain('"exchange"');
    expect(said).toContain("500");
    expect(said.includes("the-code") || said.includes("the-verifier")).toBe(false);
  });

  it("[oauth.form-encode] each half of a Basic credential is form-encoded, as RFC 6749 asks", () => {
    expect(formEncode("a-b_c.d")).toBe("a-b_c.d");
    expect(formEncode("x y")).toBe("x+y");
    expect(formEncode("!'()~")).toBe("%21%27%28%29%7E");
    expect(formEncode("a/b:c")).toBe("a%2Fb%3Ac");
    expect(Redacted.value(Redacted.make(formEncode("s")))).toBe("s");
  });

  it("[oauth.scopes-registered] the client asks for exactly the scopes Terraform registers it with", () => {
    const infra = readFileSync(
      new URL("../../../../infra/staging/main.tf", import.meta.url),
      "utf8",
    );
    const client =
      /resource "cloudflare_oauth_client" "keel" \{([\s\S]*?)\n\}/.exec(infra)?.[1] ?? "";
    const registered = /\n\s*scopes\s*=\s*\[([^\]]*)\]/.exec(client)?.[1] ?? "";
    expect([...registered.matchAll(/"([^"]+)"/g)].map((match) => match[1])).toEqual([
      ...CLOUDFLARE_SCOPES,
    ]);
  });
});
