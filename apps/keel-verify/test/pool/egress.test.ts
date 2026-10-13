import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BUNDLE_HOSTS, KeelSandbox } from "../../src/adapters/driving/do/keel-sandbox.ts";
import { signedUrl } from "./support/probes.ts";

const hash = "a".repeat(64);
/** Two namespaces, by id: the bundle host serves each its own bundles and nothing of the other's. */
const X = "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0";
const Y = "org_01JZ8PT2C4E6G8J0M2N4Q6S8V1";

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
    await env.BUNDLES.put(`ns/${X}/bundles/${hash}`, "bundle bytes");
    const response = await egress(await signedUrl(hash, X));
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("bundle bytes");
  });

  it("[t5.pool.bundle-other-namespace] serves a namespace's bundle under that namespace's id only, and no path of another shape", async () => {
    const theirs = "d".repeat(64);
    await env.BUNDLES.put(`ns/${X}/bundles/${theirs}`, "X's bundle");
    // The bundle as an earlier deploy keyed it: never read again, under any address.
    const old = "e".repeat(64);
    await env.BUNDLES.put(`bundles/${old}`, "a bundle from before namespaces");

    const own = await egress(await signedUrl(theirs, X));
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("X's bundle");
    // The same hash under another namespace's id is not there, even on a URL keel signed for that namespace.
    expect((await egress(await signedUrl(theirs, Y))).status).toBe(404);
    // A bare hash, the address of before namespaces, is not an address at all.
    expect((await egress(`https://bundles.keel.internal/${theirs}`)).status).toBe(400);
    expect((await egress(`https://bundles.keel.internal/${old}`)).status).toBe(400);
    expect((await egress(await signedUrl(old, X))).status).toBe(404);
    // A first segment that is not a namespace id: a handle, the key's own prefix, an escaped slash.
    for (const first of ["keel-verify", "ns", "bundles", `ns%2F${X}`, `${X}%2F..%2F${Y}`])
      expect({
        first,
        status: (await egress(`https://bundles.keel.internal/${first}/${theirs}`)).status,
      }).toEqual({ first, status: 400 });
    // More segments than a namespace and a hash, the whole key included.
    expect((await egress(`https://bundles.keel.internal/ns/${X}/bundles/${theirs}`)).status).toBe(
      400,
    );
    expect((await egress(`https://bundles.keel.internal/${X}/${theirs}/`)).status).toBe(400);
  });

  it("[t5.pool.bundle-unsigned] reads nothing for a URL keel did not sign: a namespace's id and a bundle's hash are not enough", async () => {
    const theirs = "f".repeat(64);
    await env.BUNDLES.put(`ns/${X}/bundles/${theirs}`, "X's bundle");
    const address = `https://bundles.keel.internal/${X}/${theirs}`;
    const signed = new URL(await signedUrl(theirs, X));
    // The control: the same address, signed, is served.
    expect((await egress(signed.href)).status).toBe(200);
    const bare = await egress(address);
    expect(bare.status).toBe(403);
    expect(await bare.text()).toBe("not a bundle URL Keel signed");
    expect((await egress(`${address}?exp=${signed.searchParams.get("exp")}`)).status).toBe(403);
    expect((await egress(`${address}?sig=${signed.searchParams.get("sig")}`)).status).toBe(403);
    expect(
      (await egress(`${address}?exp=${signed.searchParams.get("exp")}&sig=${"A".repeat(86)}`))
        .status,
    ).toBe(403);
    // A HEAD learns nothing either: not even whether the bundle is there.
    expect((await egress(address, { method: "HEAD" })).status).toBe(403);
    expect(
      (await egress(`https://bundles.keel.internal/${X}/${"0".repeat(64)}`, { method: "HEAD" }))
        .status,
    ).toBe(403);
  });

  it("[t5.pool.bundle-signed-for-another] a sandbox's own signed URL opens no other bundle: not another namespace's, and not another of its own", async () => {
    const [mine, other, theirs] = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
    await env.BUNDLES.put(`ns/${X}/bundles/${mine}`, "X's candidate");
    await env.BUNDLES.put(`ns/${X}/bundles/${other}`, "another of X's bundles");
    await env.BUNDLES.put(`ns/${Y}/bundles/${theirs}`, "Y's candidate");
    // What a sandbox running X's candidate holds: one URL, for that bundle.
    const held = new URL(await signedUrl(mine, X));
    expect((await egress(held.href)).status).toBe(200);
    expect(
      (await egress(`https://bundles.keel.internal/${Y}/${theirs}${held.search}`)).status,
    ).toBe(403);
    expect((await egress(`https://bundles.keel.internal/${X}/${other}${held.search}`)).status).toBe(
      403,
    );
    // Y's own URL still opens Y's bundle.
    expect((await egress(await signedUrl(theirs, Y))).status).toBe(200);
  });

  it("[t5.pool.bundle-expired] a signed URL past its expiry reads nothing", async () => {
    const mine = "4".repeat(64);
    await env.BUNDLES.put(`ns/${X}/bundles/${mine}`, "X's candidate");
    expect((await egress(await signedUrl(mine, X, 60))).status).toBe(200);
    expect((await egress(await signedUrl(mine, X, -1))).status).toBe(403);
  });

  it("refuses anything that is not a read of a well-formed hash", async () => {
    expect(
      (await egress(`https://bundles.keel.internal/${X}/${hash}`, { method: "PUT", body: "x" }))
        .status,
    ).toBe(405);
    expect((await egress("https://bundles.keel.internal/../secrets")).status).toBe(400);
    expect((await egress(`https://bundles.keel.internal/${X}/../secrets`)).status).toBe(400);
    expect((await egress(await signedUrl("b".repeat(64), X))).status).toBe(404);
  });

  it("serves nothing outside bundles/, whatever else the bucket holds", async () => {
    // Evidence lives in ARCHIVE, never here; but whatever sits beside the
    // bundles must stay out of reach of a sandbox that learns its key.
    const other = "c".repeat(64);
    await env.BUNDLES.put(`ns/${X}/evidence/${other}`, "someone else's evidence");
    await env.BUNDLES.put(`ns/${X}/deps/${other}`, "a deps pointer");
    await env.BUNDLES.put(other, "a bare key");
    expect((await egress(await signedUrl(other, X))).status).toBe(404);
    expect((await egress(`https://bundles.keel.internal/${X}/evidence/${other}`)).status).toBe(400);
    expect((await egress(`https://bundles.keel.internal/${X}/deps/${other}`)).status).toBe(400);
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
