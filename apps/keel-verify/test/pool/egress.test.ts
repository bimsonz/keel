import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BUNDLE_HOSTS, KeelSandbox } from "../../src/adapters/driving/do/keel-sandbox.ts";
import { signedPartUrl, signedUrl } from "./support/probes.ts";

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

async function egress(url: string, init?: RequestInit, bindings: typeof env = env) {
  const handler = handlerFor(new URL(url).hostname);
  if (handler === undefined) throw new Error(`no outbound handler for ${url}`);
  return handler(new Request(url, init), bindings, {
    containerId: "test",
    className: "KeelSandbox",
  });
}

/** The pool's bindings, with the name of every call made of BUNDLES noted in `asked` before it is made. */
function watching(asked: string[]): typeof env {
  const bundles = new Proxy(env.BUNDLES, {
    get(bucket, name) {
      const member: unknown = Reflect.get(bucket, name);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        asked.push(String(name));
        return Reflect.apply(member, bucket, args);
      };
    },
  });
  return new Proxy(env, {
    get: (bindings, name) => (name === "BUNDLES" ? bundles : Reflect.get(bindings, name)),
  });
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
    // No registry host, and no handler that writes: a suite box reads its bundle and its deps parts, and that is all.
    expect(Object.keys(KeelSandbox.outboundByHost ?? {})).toEqual([
      "deps.keel.internal",
      BUNDLE_HOSTS,
      "*",
    ]);
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
    await env.BUNDLES.put(`ns/${X}/deps-parts/${other}`, "a deps part");
    await env.BUNDLES.put(`ns/${X}/probe-deps/${other}`, "a probe deps pointer");
    await env.BUNDLES.put(other, "a bare key");
    expect((await egress(await signedUrl(other, X))).status).toBe(404);
    expect((await egress(`https://bundles.keel.internal/${X}/evidence/${other}`)).status).toBe(400);
    expect((await egress(`https://bundles.keel.internal/${X}/deps/${other}`)).status).toBe(400);
    expect((await egress(`https://bundles.keel.internal/${X}/deps-parts/${other}`)).status).toBe(
      400,
    );
    expect((await egress(`https://bundles.keel.internal/evidence/${other}`)).status).toBe(400);
    expect((await egress(`https://bundles.keel.internal/bundles/${other}`)).status).toBe(400);
  });

  it("[deps.pool.serve-other-namespace] serves a deps part to the namespace its URL was signed for, and to no other URL", async () => {
    const part = "5".repeat(64);
    await env.BUNDLES.put(`ns/${X}/deps-parts/${part}`, "a part of X's node_modules");
    const held = new URL(await signedPartUrl(part, X));
    expect(held.origin + held.pathname).toBe(`https://deps.keel.internal/${X}/${part}`);
    const own = await egress(held.href);
    expect(own.status).toBe(200);
    expect(own.headers.get("content-length")).toBe("26");
    expect(await own.text()).toBe("a part of X's node_modules");
    const head = await egress(held.href, { method: "HEAD" });
    expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([
      200,
      "26",
      "",
    ]);

    // The same part under another namespace's id is not there, even on a URL keel signed for that namespace.
    expect((await egress(await signedPartUrl(part, Y))).status).toBe(404);
    // X's own signature opens nothing of Y's, and no other part of X's.
    await env.BUNDLES.put(`ns/${Y}/deps-parts/${part}`, "a part of Y's node_modules");
    const other = "6".repeat(64);
    await env.BUNDLES.put(`ns/${X}/deps-parts/${other}`, "another part of X's");
    expect((await egress(`https://deps.keel.internal/${Y}/${part}${held.search}`)).status).toBe(
      403,
    );
    expect((await egress(`https://deps.keel.internal/${X}/${other}${held.search}`)).status).toBe(
      403,
    );

    // No signature, half of one, one that is not keel's, and one out of date.
    const address = `https://deps.keel.internal/${X}/${part}`;
    const bare = await egress(address);
    expect([bare.status, await bare.text()]).toEqual([403, "not a deps part URL Keel signed"]);
    expect((await egress(`${address}?exp=${held.searchParams.get("exp")}`)).status).toBe(403);
    expect((await egress(`${address}?sig=${held.searchParams.get("sig")}`)).status).toBe(403);
    expect(
      (await egress(`${address}?exp=${held.searchParams.get("exp")}&sig=${"A".repeat(86)}`)).status,
    ).toBe(403);
    expect((await egress(address, { method: "HEAD" })).status).toBe(403);
    expect((await egress(await signedPartUrl(part, X, -1))).status).toBe(403);

    // A bundle URL's signature is no part's, for the same namespace, hash and expiry: and a part's is no bundle's.
    await env.BUNDLES.put(`ns/${X}/bundles/${part}`, "a bundle with a part's hash");
    const bundle = new URL(await signedUrl(part, X));
    expect((await egress(bundle.href)).status).toBe(200);
    expect((await egress(`${address}${bundle.search}`)).status).toBe(403);
    expect((await egress(`https://bundles.keel.internal/${X}/${part}${held.search}`)).status).toBe(
      403,
    );

    // Only `/<namespace id>/<sha256>` is an address: not a bare hash, not the key, not another family.
    for (const path of [
      `/${part}`,
      `/ns/${X}/deps-parts/${part}`,
      `/${X}/deps-parts/${part}`,
      `/${X}/${part}/`,
      `/keel-verify/${part}`,
    ])
      expect({
        path,
        status: (await egress(`https://deps.keel.internal${path}${held.search}`)).status,
      }).toEqual({ path, status: 400 });
    // A part URL reads parts alone: the namespace's bundle and its pointer are not parts.
    const bundleOnly = "7".repeat(64);
    await env.BUNDLES.put(`ns/${X}/bundles/${bundleOnly}`, "a bundle");
    await env.BUNDLES.put(`ns/${X}/deps/${bundleOnly}`, "a pointer");
    expect((await egress(await signedPartUrl(bundleOnly, X))).status).toBe(404);
  });

  it("[deps.pool.part-head] answers a HEAD of a deps part with its size, and opens no body to learn it", async () => {
    const part = "9".repeat(64);
    await env.BUNDLES.put(`ns/${X}/deps-parts/${part}`, "a part nobody reads to learn its size");
    const held = await signedPartUrl(part, X);
    // R2's `head` answers what an object is and opens nothing; `get` opens its body, read or not.
    const asked: string[] = [];
    const head = await egress(held, { method: "HEAD" }, watching(asked));
    expect([
      head.status,
      head.headers.get("content-length"),
      head.headers.get("content-type"),
      head.body,
    ]).toEqual([200, "37", "application/octet-stream", null]);
    expect(asked).toEqual(["head"]);

    // A GET opens the part, and says the same of it.
    const read: string[] = [];
    const got = await egress(held, undefined, watching(read));
    expect([got.status, got.headers.get("content-length"), await got.text()]).toEqual([
      200,
      "37",
      "a part nobody reads to learn its size",
    ]);
    expect(read).toEqual(["get"]);
    expect(got.headers.get("etag")).not.toBeNull();
    expect(head.headers.get("etag")).toBe(got.headers.get("etag"));

    // A part that is not kept is not found, by the same question.
    const absent: string[] = [];
    const missing = await egress(
      await signedPartUrl("0".repeat(63) + "9", X),
      { method: "HEAD" },
      watching(absent),
    );
    expect(missing.status).toBe(404);
    expect(absent).toEqual(["head"]);
  });

  it("[deps.pool.suite-box-cannot-write] refuses every write from a suite box, to the deps host and to the bundle host", async () => {
    const part = "8".repeat(64);
    const held = new URL(await signedPartUrl(part, X));
    for (const [method, url] of [
      // A deps box's own upload, as a suite box would try it.
      ["PUT", `http://deps.keel.internal/${part}`],
      ["PUT", `https://deps.keel.internal/${part}`],
      // The address a suite box reads a part at, with the signature it holds.
      ["PUT", held.href],
      ["POST", held.href],
      ["DELETE", held.href],
      ["PUT", `https://bundles.keel.internal/${X}/${part}${held.search}`],
    ] as const) {
      const response = await egress(url, {
        method,
        ...(method === "DELETE" ? {} : { body: "what a suite would leave for the next run" }),
      });
      expect({ method, url, status: response.status }).toEqual({ method, url, status: 405 });
    }
    expect(await env.BUNDLES.head(`ns/${X}/deps-parts/${part}`)).toBeNull();
    expect(await env.BUNDLES.head(`ns/${X}/bundles/${part}`)).toBeNull();
    expect((await env.BUNDLES.list({ prefix: `ns/${X}/deps-parts/${part}` })).objects).toEqual([]);
  });

  it("denies every other host at once, over HTTP and HTTPS", async () => {
    for (const url of [
      "https://registry.npmjs.org/hono",
      "http://registry.npmjs.org/hono",
      "http://example.com/",
      "https://api.cloudflare.com/client/v4",
      "https://keel.internal.evil.com/",
    ]) {
      const response = await egress(url);
      expect({ url, status: response.status }).toEqual({ url, status: 403 });
    }
  });
});
