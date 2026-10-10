import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_HOSTS,
  bundleKey,
  KeelSandbox,
} from "../../src/adapters/driving/do/keel-sandbox.ts";

const hash = "a".repeat(64);

const glob = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replaceAll(".", "\\."))
      .join(".*")}$`,
  );

/** The handler the containers proxy would pick for `host`: exact match, then the first matching glob. */
function handlerFor(host: string) {
  const handlers = KeelSandbox.outboundByHost ?? {};
  return (
    handlers[host] ?? Object.entries(handlers).find(([pattern]) => glob(pattern).test(host))?.[1]
  );
}

async function egress(url: string, init?: RequestInit) {
  const handler = handlerFor(new URL(url).hostname);
  if (handler === undefined) throw new Error(`no outbound handler for ${url}`);
  return handler(new Request(url, init), env, { containerId: "test", className: "KeelSandbox" });
}

describe("KeelSandbox egress", () => {
  it("allows only the bundle hosts, with the internet off and every request intercepted", () => {
    // The pool cannot start a container DO, so construct KeelSandbox over an
    // empty base for a moment: `super()` resolves the base at call time, and
    // the class's own field initialisers then run exactly as deployed.
    const base = Reflect.getPrototypeOf(KeelSandbox);
    Reflect.setPrototypeOf(KeelSandbox, Object);
    let constructed: unknown;
    try {
      constructed = Reflect.construct(KeelSandbox, [{}, env]);
    } finally {
      Reflect.setPrototypeOf(KeelSandbox, base);
    }
    if (!(constructed instanceof KeelSandbox)) throw new Error("KeelSandbox did not construct");
    const sandbox = constructed;
    expect({
      enableInternet: sandbox.enableInternet,
      interceptHttps: sandbox.interceptHttps,
      allowedHosts: sandbox.allowedHosts,
    }).toEqual({
      enableInternet: false,
      interceptHttps: true,
      allowedHosts: [BUNDLE_HOSTS],
    });
    expect(Object.keys(KeelSandbox.outboundByHost ?? {})).toEqual([BUNDLE_HOSTS, "*"]);
  });

  it("serves a bundle from BUNDLES on the virtual host", async () => {
    await env.BUNDLES.put(bundleKey(hash), "bundle bytes");
    const response = await egress(`https://bundles.keel.internal/${hash}`);
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("bundle bytes");
  });

  it("refuses anything that is not a read of a well-formed hash", async () => {
    expect(
      (await egress(`https://bundles.keel.internal/${hash}`, { method: "PUT", body: "x" })).status,
    ).toBe(405);
    expect((await egress("https://bundles.keel.internal/../secrets")).status).toBe(400);
    expect((await egress(`https://bundles.keel.internal/${"b".repeat(64)}`)).status).toBe(404);
  });

  it("serves nothing outside bundles/, whatever else the bucket holds", async () => {
    // Evidence lives in ARCHIVE, never here; but whatever sits beside the
    // bundles must stay out of reach of a sandbox that learns its key.
    const other = "c".repeat(64);
    await env.BUNDLES.put(`evidence/${other}`, "someone else's evidence");
    await env.BUNDLES.put(other, "a bare key");
    expect((await egress(`https://bundles.keel.internal/${other}`)).status).toBe(404);
    expect((await egress(`https://bundles.keel.internal/evidence/${other}`)).status).toBe(400);
    expect((await egress(`https://bundles.keel.internal/bundles/${other}`)).status).toBe(400);
  });

  it("denies every other host at once, over HTTP and HTTPS", async () => {
    for (const url of [
      "https://registry.npmjs.org/hono",
      "http://example.com/",
      "https://api.cloudflare.com/client/v4",
      "https://keel.internal.evil.com/",
    ]) {
      const response = await egress(url);
      expect({ url, status: response.status }).toEqual({ url, status: 403 });
    }
  });
});
