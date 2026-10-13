import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { DEPS_BUILD_COMMAND, sha256Hex } from "@keeltown/runner-protocol";
import { Exit, Schema } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KeelDepsBox } from "../../src/adapters/driving/do/keel-deps-box.ts";
import { decodeExit, depsBoxName, DepsBuildRequest, DepsCodecs } from "../../src/rpc/index.ts";
import {
  BOX_HOSTS,
  boxNamed,
  fromBox,
  logged,
  partOf,
  pointerAt,
  put,
  refusalOf,
  reportOf,
  withoutContainers,
} from "./support/deps.ts";
import { egress, signedUrl } from "./support/probes.ts";

/** Two namespaces, by id: a build for one keeps nothing under the other. */
const X = "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0";
const Y = "org_01JZ8PT2C4E6G8J0M2N4Q6S8V1";

/** An install digest, one per case, so no two cases share a box or a pointer: `seed` repeated to 64 hex digits. */
const digest = (seed: string) => seed.repeat(64 / seed.length);

/** The candidate bundle's signed URL as keel hands it over; no stand-in fetches it. */
const BUNDLE_URL = (namespace: string) =>
  `https://bundles.keel.internal/${namespace}/${"b".repeat(64)}?exp=1900000000&sig=${"A".repeat(86)}`;

/**
 * A candidate's install inputs as keel hands them over: the format's line,
 * then the bundle manifest's line for each file an install reads, and a
 * newline after the last. No stand-in hashes them, so a case's digest need not
 * be theirs.
 */
const INPUTS = `keel.install/1\n${"1".repeat(64)}  package.json\n${"2".repeat(64)}  pnpm-lock.yaml\n`;

/** A deps build request as it crosses from keel: plain JSON. */
const request = (namespace: string, install: string, inputs: string = INPUTS) => ({
  namespace,
  need: { _tag: "Locked", install, inputs },
  bundleUrl: BUNDLE_URL(namespace),
});

const bytesOf = (text: string) => new TextEncoder().encode(text);

const answered = async (reply: Promise<unknown>) => {
  const exit = decodeExit(DepsCodecs.build, await reply);
  if (Exit.isFailure(exit)) throw new Error(`the build failed: ${JSON.stringify(exit.cause)}`);
  return exit.value;
};

/** keel-verify's own front door, as keel's VERIFIER service binding reaches it. */
const entry: unknown = exports.default;
const buildsDeps = (x: unknown): x is { buildDeps(request: unknown): Promise<unknown> } =>
  typeof Reflect.get(Object(x), "buildDeps") === "function";
const viaEntrypoint = (wire: unknown) => {
  if (!buildsDeps(entry)) throw new Error("keel-verify's entrypoint has no buildDeps");
  return answered(entry.buildDeps(wire));
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const kept = async (key: string) => ((await env.BUNDLES.head(key)) === null ? "absent" : "kept");

let restore: () => void;
beforeAll(() => {
  restore = withoutContainers();
});
afterAll(() => restore());
afterEach(() => {
  vi.restoreAllMocks();
});

describe("KeelDepsBox egress", () => {
  it("[deps.pool.box-egress] has the internet off and no HTTPS, and a handler for every host it allows", async () => {
    const box = boxNamed(`deps:${X}:${digest("0")}`);
    const fields = await runInDurableObject(box.stub, (instance: KeelDepsBox) => ({
      enableInternet: instance.enableInternet,
      interceptHttps: instance.interceptHttps,
      allowedHosts: instance.allowedHosts,
    }));
    expect(fields).toEqual({
      enableInternet: false,
      interceptHttps: false,
      allowedHosts: ["registry.npmjs.org", "*.keel.internal"],
    });
    expect(BOX_HOSTS).toEqual([
      "registry.npmjs.org",
      "bundles.keel.internal",
      "deps.keel.internal",
      "*",
    ]);
    // An allowed host with no handler of its own, and any other, is refused at once.
    for (const url of [
      "http://evidence.keel.internal/x",
      "http://bundles.keel.internal.evil.example/x",
      "http://example.com/",
      "http://registry.yarnpkg.com/hono",
    ]) {
      const response = await fromBox(box.id, url);
      expect({ url, status: response.status }).toEqual({ url, status: 403 });
    }
  });

  it("[deps.pool.box-egress] serves the box its candidate bundle over plain HTTP, by the URL keel signed", async () => {
    const box = boxNamed(`deps:${X}:${digest("0")}`);
    const hash = "9".repeat(64);
    await env.BUNDLES.put(`ns/${X}/bundles/${hash}`, "the candidate bundle");
    const signed = await signedUrl(hash, X);
    expect(signed.startsWith("https://bundles.keel.internal/")).toBe(true);
    // The box has no HTTPS: its command fetches the same URL with the scheme changed, and the signature still holds.
    const served = await fromBox(box.id, `http://${signed.slice("https://".length)}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("the candidate bundle");
    expect((await fromBox(box.id, `http://bundles.keel.internal/${X}/${hash}`)).status).toBe(403);
  });

  it("[deps.pool.registry] passes every GET on the registry host to the registry over HTTPS, with no header of the box's but accept", async () => {
    const box = boxNamed(`deps:${X}:${digest("0")}`);
    const before = await egress();
    const tarball = await fromBox(box.id, "http://registry.npmjs.org/hono/-/hono-4.13.13.tgz?a=1", {
      headers: {
        accept: "application/octet-stream",
        authorization: "Bearer a-token-from-the-candidate's-npmrc",
        cookie: "session=1",
        "npm-auth-type": "legacy",
        "x-from-the-box": "1",
      },
    });
    expect(tarball.status).toBe(200);
    const sent: unknown = await tarball.json();
    expect(sent).toMatchObject({
      method: "GET",
      url: "https://registry.npmjs.org/hono/-/hono-4.13.13.tgz?a=1",
      headers: { accept: "application/octet-stream" },
    });
    const headers = Object.keys(Object(Reflect.get(Object(sent), "headers")));
    for (const name of ["authorization", "cookie", "npm-auth-type", "x-from-the-box"])
      expect({ name, sent: headers.includes(name) }).toEqual({ name, sent: false });
    // pnpm reads more than tarballs from a frozen lockfile: packuments and attestations pass too,
    // and the registry's own answer comes back as it was given.
    expect((await fromBox(box.id, "http://registry.npmjs.org/hono")).status).toBe(200);
    expect(
      (await fromBox(box.id, "http://registry.npmjs.org/-/npm/v1/attestations/hono@4.13.13"))
        .status,
    ).toBe(404);
    // A path cannot name another host.
    const slashes = await fromBox(box.id, "http://registry.npmjs.org//evil.example/x");
    expect(await slashes.json()).toMatchObject({
      url: "https://registry.npmjs.org//evil.example/x",
    });
    expect((await egress()).slice(before.length)).toEqual([
      "GET https://registry.npmjs.org/hono/-/hono-4.13.13.tgz?a=1",
      "GET https://registry.npmjs.org/hono",
      "GET https://registry.npmjs.org/-/npm/v1/attestations/hono@4.13.13",
      "GET https://registry.npmjs.org//evil.example/x",
    ]);
  });

  it("[deps.pool.registry] refuses anything but a GET, and sends nothing on", async () => {
    const box = boxNamed(`deps:${X}:${digest("0")}`);
    const before = await egress();
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const response = await fromBox(box.id, "http://registry.npmjs.org/hono", {
        method,
        ...(method === "POST" || method === "PUT" ? { body: "a package to publish" } : {}),
      });
      expect({ method, status: response.status }).toEqual({ method, status: 405 });
    }
    expect(await egress()).toEqual(before);
  });

  it("[deps.pool.registry-redirect] hands the box a redirect from the registry as it came, and fetches nothing from where it points", async () => {
    const box = boxNamed(`deps:${X}:${digest("0")}`);
    // The pool's registry answers this path with a redirect to another host, and records every request that leaves.
    const before = await egress();
    const response = await fromBox(box.id, "http://registry.npmjs.org/-/moved/hono-4.13.13.tgz");
    expect([response.status, response.headers.get("location"), await response.text()]).toEqual([
      302,
      "https://tarballs.example/hono-4.13.13.tgz",
      "moved",
    ]);
    // One request left for it, to the registry. A redirect that was followed would be a second, to the host it names.
    const after = await egress();
    expect(after.slice(before.length)).toEqual([
      "GET https://registry.npmjs.org/-/moved/hono-4.13.13.tgz",
    ]);
    // The control: the same path, fetched the way fetch does unless it is told not to follow. The second request is
    // in the record, and what comes back is the other host's answer and not the redirect.
    const followed = await fetch("https://registry.npmjs.org/-/moved/hono-4.13.13.tgz");
    expect([followed.status, await followed.text()]).toEqual([
      599,
      "keel-verify has no outbound network in tests",
    ]);
    expect((await egress()).slice(after.length)).toEqual([
      "GET https://registry.npmjs.org/-/moved/hono-4.13.13.tgz",
      "GET https://tarballs.example/hono-4.13.13.tgz",
    ]);
  });
});

describe("a deps box's uploads", () => {
  it("[deps.pool.upload-shape] takes only a PUT to a part's own address", async () => {
    const box = boxNamed(`deps:${X}:${digest("0")}`);
    const sha = "c".repeat(64);
    for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
      const response = await fromBox(box.id, `http://deps.keel.internal/${sha}`, {
        method,
        ...(method === "POST" ? { body: "x" } : {}),
      });
      expect({ method, status: response.status }).toEqual({ method, status: 405 });
    }
    for (const path of [
      "/",
      `/${"c".repeat(63)}`,
      `/${"c".repeat(65)}`,
      `/${"C".repeat(64)}`,
      `/${sha}/`,
      `/${X}/${sha}`,
      `/ns/${X}/deps-parts/${sha}`,
    ])
      expect({ path, status: (await put(box.id, path, bytesOf("x"))).status }).toEqual({
        path,
        status: 400,
      });
  });

  it("[deps.pool.upload-addressed] keeps a part only when its body is the sha256 its path names", async () => {
    const L = digest("1");
    const box = boxNamed(`deps:${X}:${L}`);
    const [real, forged] = [bytesOf("a part of the archive"), bytesOf("another body")];
    const part = await partOf(real);
    const key = `ns/${X}/deps-parts/${part.sha256}`;
    const seen: Record<string, number | string> = {};
    box.runs(async () => {
      seen["forged"] = (await put(box.id, `/${part.sha256}`, forged)).status;
      seen["after the forged body"] = await kept(key);
      seen["real"] = (await put(box.id, `/${part.sha256}`, real)).status;
      return refusalOf("install-failed");
    });
    await answered(box.stub.build(request(X, L)));
    expect(seen).toEqual({ forged: 400, "after the forged body": "absent", real: 200 });
    const stored = await env.BUNDLES.get(key);
    expect(await stored?.text()).toBe("a part of the archive");
  });

  it("[deps.pool.upload-own-namespace] keeps a part under the building box's namespace whatever the request says, and refuses a box that is not building", async () => {
    const L = digest("2");
    const box = boxNamed(`deps:${X}:${L}`);
    const during = await partOf(bytesOf("uploaded while building"));
    const after = await partOf(bytesOf("uploaded once the build is over"));
    const seen: Record<string, number> = {};
    box.runs(async () => {
      // The box names another namespace every way a request can: a query, a header, the path.
      seen["named in a query and a header"] = (
        await put(box.id, `/${during.sha256}?namespace=${Y}`, bytesOf("uploaded while building"), {
          "x-keel-namespace": Y,
        })
      ).status;
      seen["named in the path"] = (
        await put(box.id, `/${Y}/${during.sha256}`, bytesOf("uploaded while building"))
      ).status;
      // A container that is no deps box, and a deps box that is not building, while this one is.
      seen["no container id"] = (
        await put("test", `/${during.sha256}`, bytesOf("uploaded while building"))
      ).status;
      seen["a suite box's id"] = (
        await put(
          env.SANDBOX.idFromName("a-suite-box").toString(),
          `/${during.sha256}`,
          bytesOf("uploaded while building"),
        )
      ).status;
      seen["an idle deps box"] = (
        await put(
          boxNamed(`deps:${Y}:${L}`).id,
          `/${during.sha256}`,
          bytesOf("uploaded while building"),
        )
      ).status;
      return refusalOf("install-failed");
    });
    await answered(box.stub.build(request(X, L)));
    expect(seen).toEqual({
      "named in a query and a header": 200,
      "named in the path": 400,
      "no container id": 403,
      "a suite box's id": 403,
      "an idle deps box": 403,
    });
    expect(await kept(`ns/${X}/deps-parts/${during.sha256}`)).toBe("kept");
    expect(await kept(`ns/${Y}/deps-parts/${during.sha256}`)).toBe("absent");

    // The build is over: the same box, which remembers who it built for, takes nothing more.
    expect(await box.stub.building()).toBeNull();
    const late = await put(box.id, `/${after.sha256}`, bytesOf("uploaded once the build is over"));
    expect(late.status).toBe(403);
    expect(await kept(`ns/${X}/deps-parts/${after.sha256}`)).toBe("absent");
  });

  it("[deps.pool.upload-capped] refuses a part over 32 MiB, by what it declares and by what it sends", async () => {
    const L = digest("3");
    const box = boxNamed(`deps:${X}:${L}`);
    const sha = "d".repeat(64);
    const seen: Record<string, number> = {};
    box.runs(async () => {
      seen["declared"] = (
        await put(box.id, `/${sha}`, bytesOf("small"), {
          "content-length": String(32 * 1024 * 1024 + 1),
        })
      ).status;
      // 33 chunks of 1 MiB, with no length declared.
      let chunks = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunks === 33) return controller.close();
          chunks += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      });
      seen["sent"] = (
        await fromBox(box.id, `http://deps.keel.internal/${sha}`, { method: "PUT", body })
      ).status;
      return refusalOf("install-failed");
    });
    await answered(box.stub.build(request(X, L)));
    expect(seen).toEqual({ declared: 413, sent: 413 });
    expect(await kept(`ns/${X}/deps-parts/${sha}`)).toBe("absent");
  }, 120_000);
});

describe("a deps build", () => {
  it("[deps.pool.single-flight] runs one install for two builds asked at once on one box, and answers both with it", async () => {
    const L = digest("4");
    const box = boxNamed(`deps:${X}:${L}`);
    const [first, second] = [bytesOf("part one of the archive"), bytesOf("part two")];
    const [firstPart, secondPart] = [await partOf(first), await partOf(second)];
    const parts = [firstPart, secondPart];
    const install = { held: true };
    const uploads: number[] = [];
    box.runs(async () => {
      uploads.push((await put(box.id, `/${firstPart.sha256}`, first)).status);
      uploads.push((await put(box.id, `/${secondPart.sha256}`, second)).status);
      // The install stays in flight until the case has seen both builds taken.
      while (install.held) await sleep(5);
      return reportOf(parts);
    });
    const one = box.stub.build(request(X, L));
    const two = box.stub.build(request(X, L));
    // Calls on one stub are delivered in order, so once the box says it is building, both builds
    // have been taken and each has asked for the pointer, which is not written yet.
    for (;;) {
      if ((await box.stub.building()) !== null) break;
      await sleep(5);
    }
    expect(await box.stub.building()).toEqual({ namespace: X, install: L });
    install.held = false;
    const ready = { _tag: "DepsReady", install: L, parts };
    expect([await answered(one), await answered(two)]).toEqual([ready, ready]);
    expect(box.started()).toHaveLength(1);
    expect(uploads).toEqual([200, 200]);
    expect(await box.stub.building()).toBeNull();
    expect(await pointerAt(X, L)).toEqual({
      format: "keel.deps/1",
      install: L,
      toolchain: "node v22.22.3 pnpm 11.18.0",
      parts,
      files: 1735,
      installMs: 5000,
    });
  });

  it("[deps.pool.flight-answer] answers a caller that found a build in flight with that build's refusal, and installs nothing for it", async () => {
    const L = digest("4a");
    const box = boxNamed(`deps:${X}:${L}`);
    const install = { held: true };
    box.runs(async () => {
      while (install.held) await sleep(5);
      return refusalOf("install-failed");
    });
    const one = box.stub.build(request(X, L));
    const two = box.stub.build(request(X, L));
    // As above: once the box says it is building, both builds have been taken.
    for (;;) {
      if ((await box.stub.building()) !== null) break;
      await sleep(5);
    }
    install.held = false;
    // One box has one need, so the build in flight is the second caller's own: its answer is taken as it is.
    const refused = { _tag: "DepsUnavailable", reason: "install-failed" };
    expect([await answered(one), await answered(two)]).toEqual([refused, refused]);
    expect(box.started()).toHaveLength(1);
    expect(box.destroyed()).toBe(1);
    expect(await pointerAt(X, L)).toBeNull();
  });

  it("[deps.pool.install] starts the box's command with the bundle's URL, the install digest, its inputs and the upload host, and nothing else", async () => {
    const L = "5".repeat(64);
    const box = boxNamed(`deps:${X}:${L}`);
    box.runs(async () => refusalOf("install-failed"));
    // The inputs with a file of each kind an install reads. The box hashes them itself, so they go as they were handed.
    const inputs = [
      "keel.install/1",
      `${"6".repeat(64)}  .npmrc`,
      `${"7".repeat(64)}  package.json`,
      `${"8".repeat(64)}  packages/cli/bin/cli.js`,
      `${"9".repeat(64)}  packages/cli/package.json`,
      `${"a".repeat(64)}  pnpm-lock.yaml`,
      `${"c".repeat(64)}  pnpm-workspace.yaml`,
      "",
    ].join("\n");
    expect(await answered(box.stub.build(request(X, L, inputs)))).toEqual({
      _tag: "DepsUnavailable",
      reason: "install-failed",
    });
    expect(box.started()).toEqual([
      {
        command: DEPS_BUILD_COMMAND,
        // The install's 480 seconds and three minutes around it.
        timeout: 660_000,
        env: {
          HOME: "/root",
          KEEL_BUNDLE_URL: `https://bundles.keel.internal/${X}/${"b".repeat(64)}?exp=1900000000&sig=${"A".repeat(86)}`,
          KEEL_INSTALL: "5555555555555555555555555555555555555555555555555555555555555555",
          KEEL_INSTALL_INPUTS:
            "keel.install/1\n" +
            "6666666666666666666666666666666666666666666666666666666666666666  .npmrc\n" +
            "7777777777777777777777777777777777777777777777777777777777777777  package.json\n" +
            "8888888888888888888888888888888888888888888888888888888888888888  packages/cli/bin/cli.js\n" +
            "9999999999999999999999999999999999999999999999999999999999999999  packages/cli/package.json\n" +
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  pnpm-lock.yaml\n" +
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  pnpm-workspace.yaml\n",
          KEEL_DEPS_UPLOAD: "http://deps.keel.internal",
        },
      },
    ]);
    // Five names and no other. The comparison above lets by a name given no value, and a command is started with every name it is given.
    expect(Object.keys(box.started()[0]?.env ?? {}).toSorted()).toEqual([
      "HOME",
      "KEEL_BUNDLE_URL",
      "KEEL_DEPS_UPLOAD",
      "KEEL_INSTALL",
      "KEEL_INSTALL_INPUTS",
    ]);
  });

  it("[deps.pool.pointer-after-parts] writes no pointer for a report naming a part that is not kept, or not at the size it names", async () => {
    const L = digest("6");
    const box = boxNamed(`deps:${X}:${L}`);
    const body = bytesOf("the only part");
    const part = await partOf(body);
    const never = { sha256: "e".repeat(64), bytes: 10 };

    // The box says it uploaded a part it never sent.
    box.runs(async () => {
      await put(box.id, `/${part.sha256}`, body);
      return reportOf([part, never]);
    });
    expect(await answered(box.stub.build(request(X, L)))).toEqual({
      _tag: "DepsUnavailable",
      reason: `part-missing: ${"e".repeat(64)} is not kept at 10 bytes`,
    });
    expect(await pointerAt(X, L)).toBeNull();

    // The part is kept, but the box names another size for it.
    box.runs(async () => reportOf([{ sha256: part.sha256, bytes: part.bytes + 1 }]));
    expect(await answered(box.stub.build(request(X, L)))).toEqual({
      _tag: "DepsUnavailable",
      reason: `part-missing: ${part.sha256} is not kept at ${body.byteLength + 1} bytes`,
    });
    expect(await pointerAt(X, L)).toBeNull();

    // A failed build is not remembered: the next call builds again, and this time the report is true.
    box.runs(async () => reportOf([part]));
    expect(await answered(box.stub.build(request(X, L)))).toEqual({
      _tag: "DepsReady",
      install: L,
      parts: [part],
    });
    expect(box.started()).toHaveLength(3);
    expect(await pointerAt(X, L)).toMatchObject({ format: "keel.deps/1", parts: [part] });
  });

  it("[deps.pool.no-parts] writes no pointer for a report that names no part", async () => {
    const L = digest("6a");
    const box = boxNamed(`deps:${X}:${L}`);
    // The box says it built, and names nothing it uploaded: a bundle of no part is no bundle.
    box.runs(async () => reportOf([]));
    expect(await answered(box.stub.build(request(X, L)))).toEqual({
      _tag: "DepsUnavailable",
      reason: "bad KEEL_PARTS",
    });
    expect(box.started()).toHaveLength(1);
    expect(await pointerAt(X, L)).toBeNull();
  });

  it("[deps.pool.pointer-no-parts] builds over a stored pointer that names no part, and answers none of it", async () => {
    const L = digest("6b");
    // Everything a pointer that serves has, this install digest and this toolchain included, but not one part.
    await env.BUNDLES.put(
      `ns/${X}/deps/${L}`,
      JSON.stringify({
        format: "keel.deps/1",
        install: L,
        toolchain: "node v22.22.3 pnpm 11.18.0",
        parts: [],
        files: 0,
        installMs: 900,
      }),
    );
    const box = boxNamed(`deps:${X}:${L}`);
    const body = bytesOf("the part the pointer lacked");
    const part = await partOf(body);
    box.runs(async () => {
      await put(box.id, `/${part.sha256}`, body);
      return reportOf([part]);
    });
    expect(await answered(box.stub.build(request(X, L)))).toEqual({
      _tag: "DepsReady",
      install: L,
      parts: [part],
    });
    expect(box.started()).toHaveLength(1);
    expect(await pointerAt(X, L)).toMatchObject({ install: L, parts: [part], files: 1735 });
  });

  it("[deps.pool.pointer-reused] answers a second build from the pointer, with no install", async () => {
    const L = digest("7");
    const box = boxNamed(`deps:${X}:${L}`);
    const body = bytesOf("built once");
    const part = await partOf(body);
    box.runs(async () => {
      await put(box.id, `/${part.sha256}`, body);
      return reportOf([part]);
    });
    const ready = { _tag: "DepsReady", install: L, parts: [part] };
    expect(await answered(box.stub.build(request(X, L)))).toEqual(ready);
    expect(await answered(box.stub.build(request(X, L)))).toEqual(ready);
    expect(box.started()).toHaveLength(1);
    expect(box.destroyed()).toBe(1);

    // A box that has built nothing answers from the pointer its namespace already keeps:
    // no container stands in for it, so an install here would be an answer of box-failed.
    const M = digest("8");
    const stored = { sha256: "f".repeat(64), bytes: 33_554_432 };
    await env.BUNDLES.put(
      `ns/${X}/deps/${M}`,
      JSON.stringify({
        format: "keel.deps/1",
        install: M,
        toolchain: "node v22.22.3 pnpm 11.18.0",
        parts: [stored],
        files: 12,
        installMs: 900,
      }),
    );
    const fresh = boxNamed(`deps:${X}:${M}`);
    expect(await answered(fresh.stub.build(request(X, M)))).toEqual({
      _tag: "DepsReady",
      install: M,
      parts: [stored],
    });
    expect(fresh.started()).toHaveLength(0);
    expect(fresh.destroyed()).toBe(0);
  });

  it("[deps.pool.other-toolchain-rebuilt] builds again over a pointer another toolchain made", async () => {
    const L = digest("a");
    // A pointer an older image wrote for this install digest: its node_modules is not what this toolchain installs.
    await env.BUNDLES.put(
      `ns/${X}/deps/${L}`,
      JSON.stringify({
        format: "keel.deps/1",
        install: L,
        toolchain: "node v20.19.0 pnpm 10.0.0",
        parts: [{ sha256: "f".repeat(64), bytes: 5 }],
        files: 1,
        installMs: 1,
      }),
    );
    const box = boxNamed(`deps:${X}:${L}`);
    const body = bytesOf("installed by this toolchain");
    const part = await partOf(body);
    box.runs(async () => {
      await put(box.id, `/${part.sha256}`, body);
      return reportOf([part]);
    });
    expect(await answered(box.stub.build(request(X, L)))).toEqual({
      _tag: "DepsReady",
      install: L,
      parts: [part],
    });
    expect(box.started()).toHaveLength(1);
    expect(await pointerAt(X, L)).toEqual({
      format: "keel.deps/1",
      install: L,
      toolchain: "node v22.22.3 pnpm 11.18.0",
      parts: [part],
      files: 1735,
      installMs: 5000,
    });
  });

  it("[deps.pool.toolchain] writes no pointer for a box that built with another toolchain", async () => {
    const L = digest("b");
    const box = boxNamed(`deps:${X}:${L}`);
    const body = bytesOf("built by another node");
    const part = await partOf(body);
    box.runs(async () => {
      await put(box.id, `/${part.sha256}`, body);
      return reportOf([part], "node v24.1.0 pnpm 11.18.0");
    });
    expect(await answered(box.stub.build(request(X, L)))).toEqual({
      _tag: "DepsUnavailable",
      reason:
        "toolchain-mismatch: the box built with node v24.1.0 pnpm 11.18.0, not node v22.22.3 pnpm 11.18.0",
    });
    expect(await pointerAt(X, L)).toBeNull();
  });

  it("[deps.pool.other-need] refuses a box asked for another namespace or another install digest than its first", async () => {
    const L = digest("c");
    const box = boxNamed(`deps:${X}:${L}`);
    const body = bytesOf("X's dependencies");
    const part = await partOf(body);
    box.runs(async () => {
      await put(box.id, `/${part.sha256}`, body);
      return reportOf([part]);
    });
    expect(await answered(box.stub.build(request(X, L)))).toMatchObject({ _tag: "DepsReady" });
    expect(
      await runInDurableObject(box.stub, (_instance: KeelDepsBox, state) =>
        state.storage.get("keel.deps.owner"),
      ),
    ).toEqual({ namespace: X, install: L });

    const M = digest("d");
    expect(await answered(box.stub.build(request(Y, L)))).toEqual({
      _tag: "DepsUnavailable",
      reason: `this deps box builds ${L} for ${X}, and was asked for ${L} for ${Y}`,
    });
    expect(await answered(box.stub.build(request(X, M)))).toEqual({
      _tag: "DepsUnavailable",
      reason: `this deps box builds ${L} for ${X}, and was asked for ${M} for ${X}`,
    });
    expect(box.started()).toHaveLength(1);
    expect(await pointerAt(Y, L)).toBeNull();
    expect(await pointerAt(X, M)).toBeNull();

    // The pair is the object's own, kept in its storage: an object that holds another refuses before it reads anything.
    const taken = boxNamed("deps:an-object-that-already-builds-for-Y");
    await runInDurableObject(taken.stub, (_instance: KeelDepsBox, state) =>
      state.storage.put("keel.deps.owner", { namespace: Y, install: M }),
    );
    taken.runs(async () => reportOf([part]));
    expect(await answered(taken.stub.build(request(X, L)))).toEqual({
      _tag: "DepsUnavailable",
      reason: `this deps box builds ${M} for ${Y}, and was asked for ${L} for ${X}`,
    });
    expect(taken.started()).toHaveLength(0);
  });

  it("[deps.pool.other-need] refuses a bundle URL that is not one of the namespace's bundles", async () => {
    const L = digest("e");
    const box = boxNamed(`deps:${X}:${L}`);
    box.runs(async () => refusalOf("install-failed"));
    for (const bundleUrl of [
      BUNDLE_URL(Y),
      `https://example.com/${X}/${"b".repeat(64)}`,
      `https://deps.keel.internal/${X}/${"b".repeat(64)}`,
      "not a URL",
    ])
      expect({
        bundleUrl,
        answer: await answered(box.stub.build({ ...request(X, L), bundleUrl })),
      }).toEqual({
        bundleUrl,
        answer: {
          _tag: "DepsUnavailable",
          reason: `the bundle URL is not one of ${X}'s bundles`,
        },
      });
    expect(box.started()).toHaveLength(0);
  });

  it("[deps.pool.box-destroyed] destroys the container after a build, whatever it answered", async () => {
    const built = boxNamed(`deps:${X}:${digest("f")}`);
    const body = bytesOf("a part");
    const part = await partOf(body);
    built.runs(async () => {
      await put(built.id, `/${part.sha256}`, body);
      return reportOf([part]);
    });
    expect(await answered(built.stub.build(request(X, digest("f"))))).toMatchObject({
      _tag: "DepsReady",
    });
    expect(built.destroyed()).toBe(1);

    const refused = boxNamed(`deps:${Y}:${digest("f")}`);
    refused.runs(async () => refusalOf("off-registry codeload.github.com"));
    expect(await answered(refused.stub.build(request(Y, digest("f"))))).toEqual({
      _tag: "DepsRefused",
      reason: "off-registry codeload.github.com",
    });
    expect(refused.destroyed()).toBe(1);

    const garbled = boxNamed(`deps:${Y}:${digest("1")}`);
    garbled.runs(async () => "pnpm printed this and nothing else\n");
    expect(await answered(garbled.stub.build(request(Y, digest("1"))))).toEqual({
      _tag: "DepsUnavailable",
      reason: "no deps build report",
    });
    expect(garbled.destroyed()).toBe(1);

    const broken = boxNamed(`deps:${Y}:${digest("2")}`);
    broken.runs(async () => {
      throw new Error("the container did not start");
    });
    expect(await answered(broken.stub.build(request(Y, digest("2"))))).toEqual({
      _tag: "DepsUnavailable",
      reason: "box-failed: the container did not start",
    });
    expect(broken.destroyed()).toBe(1);
    expect(await pointerAt(Y, digest("2"))).toBeNull();
  });

  it("[deps.pool.box-left] keeps a build's answer when its container cannot be destroyed, and says which box was left", async () => {
    const L = digest("f1");
    const box = boxNamed(`deps:${X}:${L}`);
    const body = bytesOf("a part from a box that was left up");
    const part = await partOf(body);
    box.runs(async () => {
      await put(box.id, `/${part.sha256}`, body);
      return reportOf([part]);
    });
    box.strands(new Error("the container would not stop"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ready = { _tag: "DepsReady", install: L, parts: [part] };
    expect(await answered(box.stub.build(request(X, L)))).toEqual(ready);
    expect(box.destroyed()).toBe(1);
    expect(logged(warn, "keel.deps.box-left")).toEqual([
      {
        event: "keel.deps.box-left",
        namespace: X,
        install: L,
        error: "the container would not stop",
      },
    ]);
    // The build is over all the same: the box is not building, and its pointer answers the next caller.
    expect(await box.stub.building()).toBeNull();
    expect(await answered(box.stub.build(request(X, L)))).toEqual(ready);
    expect(box.started()).toHaveLength(1);
  });

  it("[deps.pool.refusal-split] answers a refusal only the candidate ends as refused and any other as unavailable, logs which, and keeps no pointer for either", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const cases = [
      { install: "4e", reason: "install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE", refused: true },
      { install: "5e", reason: "install-failed exit 1 ERR_PNPM_FETCH_503", refused: false },
      { install: "6e", reason: "install-failed exit 1", refused: false },
      { install: "7e", reason: "too-large", refused: true },
      { install: "8e", reason: "upload-failed", refused: false },
    ].map((c) => ({ ...c, install: c.install.repeat(32) }));
    for (const c of cases) {
      const box = boxNamed(`deps:${X}:${c.install}`);
      box.runs(async () => refusalOf(c.reason));
      expect(await answered(box.stub.build(request(X, c.install)))).toEqual({
        _tag: c.refused ? "DepsRefused" : "DepsUnavailable",
        reason: c.reason,
      });
      expect(await pointerAt(X, c.install)).toBeNull();
    }
    expect(logged(log, "keel.deps.built")).toMatchObject(
      cases.map((c) => ({
        namespace: X,
        install: c.install,
        outcome: c.refused ? "refused" : "unavailable",
        reason: c.reason,
      })),
    );
    // Output that is no report is never read for whose fault it was, whatever words it holds.
    const garbled = boxNamed(`deps:${X}:${"9e".repeat(32)}`);
    garbled.runs(async () => "too-large\ninstall-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE\n");
    expect(await answered(garbled.stub.build(request(X, "9e".repeat(32))))).toEqual({
      _tag: "DepsUnavailable",
      reason: "no deps build report",
    });
    // Neither is the object's own stop: a box that fell over, saying a refusal's word.
    const broken = boxNamed(`deps:${X}:${"ae".repeat(32)}`);
    broken.runs(async () => {
      throw new Error("too-large");
    });
    expect(await answered(broken.stub.build(request(X, "ae".repeat(32))))).toEqual({
      _tag: "DepsUnavailable",
      reason: "box-failed: too-large",
    });
  });

  it("[deps.pool.logged] logs one line for a build, a reuse and a refusal", async () => {
    const L = digest("3");
    const box = boxNamed(`deps:${Y}:${L}`);
    const body = bytesOf("a logged part");
    const part = await partOf(body);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    box.runs(async () => refusalOf("install-timeout"));
    await answered(box.stub.build(request(Y, L)));
    box.runs(async () => {
      await put(box.id, `/${part.sha256}`, body);
      return reportOf([part]);
    });
    await answered(box.stub.build(request(Y, L)));
    await answered(box.stub.build(request(Y, L)));
    expect(logged(log, "keel.deps.built")).toMatchObject([
      { namespace: Y, install: L, outcome: "refused", reason: "install-timeout" },
      {
        namespace: Y,
        install: L,
        outcome: "built",
        parts: 1,
        bytes: body.byteLength,
        files: 1735,
        installMs: 5000,
      },
      {
        namespace: Y,
        install: L,
        outcome: "reused",
        parts: 1,
        bytes: body.byteLength,
        files: 1735,
        installMs: 5000,
      },
    ]);
  });
});

describe("keel-verify's buildDeps", () => {
  it("[deps.box-name] names one deps box per (namespace, install digest)", () => {
    const decode = Schema.decodeUnknownSync(DepsBuildRequest);
    expect(depsBoxName(decode(request(X, "a".repeat(64))))).toBe(
      `deps:org_01JZ8PT2C4E6G8J0M2N4Q6S8V0:${"a".repeat(64)}`,
    );
    expect(depsBoxName(decode(request(Y, "a".repeat(64))))).toBe(
      `deps:org_01JZ8PT2C4E6G8J0M2N4Q6S8V1:${"a".repeat(64)}`,
    );
  });

  it("[deps.pool.entrypoint] routes a build to the box of its namespace and install digest, and each namespace to its own", async () => {
    const L = "5".repeat(32) + "6".repeat(32);
    const [mine, theirs] = [boxNamed(`deps:${X}:${L}`), boxNamed(`deps:${Y}:${L}`)];
    const [mineBody, theirBody] = [bytesOf("X's node_modules"), bytesOf("Y's node_modules")];
    const [minePart, theirPart] = [await partOf(mineBody), await partOf(theirBody)];
    mine.runs(async () => {
      await put(mine.id, `/${minePart.sha256}`, mineBody);
      return reportOf([minePart]);
    });
    theirs.runs(async () => {
      await put(theirs.id, `/${theirPart.sha256}`, theirBody);
      return reportOf([theirPart]);
    });
    expect(await viaEntrypoint(request(X, L))).toEqual({
      _tag: "DepsReady",
      install: L,
      parts: [minePart],
    });
    expect([mine.started().length, theirs.started().length]).toEqual([1, 0]);
    // The same install digest in another namespace is another box, another build and another pointer.
    expect(await viaEntrypoint(request(Y, L))).toEqual({
      _tag: "DepsReady",
      install: L,
      parts: [theirPart],
    });
    expect([mine.started().length, theirs.started().length]).toEqual([1, 1]);
    expect(await kept(`ns/${Y}/deps-parts/${minePart.sha256}`)).toBe("absent");
    expect(await kept(`ns/${X}/deps-parts/${theirPart.sha256}`)).toBe("absent");
  });

  it("[deps.pool.other-settings-rebuilt] builds a bundle of its own for a candidate that differs from another in one settings file, and builds over neither", async () => {
    // Two candidates of one namespace with the same lockfile and package.json, and an .npmrc of other bytes:
    // their install inputs differ in that one line.
    const one =
      "keel.install/1\n" +
      "6666666666666666666666666666666666666666666666666666666666666666  .npmrc\n" +
      "7777777777777777777777777777777777777777777777777777777777777777  package.json\n" +
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  pnpm-lock.yaml\n";
    const other =
      "keel.install/1\n" +
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd  .npmrc\n" +
      "7777777777777777777777777777777777777777777777777777777777777777  package.json\n" +
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  pnpm-lock.yaml\n";
    // Each digest is the sha256 of its inputs, as keel takes it. Nothing here derives one, so they are written out.
    const A = "c673c5637aa45f09e91c0a54627cd9c1892e3799943214580b3234d73a4bc0de";
    const B = "67c787c2deeaf18dce749dd1ccabd09bbc693a42883018bf7f88d573719928fd";
    expect([await sha256Hex(bytesOf(one)), await sha256Hex(bytesOf(other))]).toEqual([A, B]);
    const [first, second] = [boxNamed(`deps:${X}:${A}`), boxNamed(`deps:${X}:${B}`)];
    const [firstBody, secondBody] = [
      bytesOf("installed under one .npmrc"),
      bytesOf("and the other"),
    ];
    const [firstPart, secondPart] = [await partOf(firstBody), await partOf(secondBody)];
    first.runs(async () => {
      await put(first.id, `/${firstPart.sha256}`, firstBody);
      return reportOf([firstPart]);
    });
    second.runs(async () => {
      await put(second.id, `/${secondPart.sha256}`, secondBody);
      return reportOf([secondPart]);
    });
    const built = { _tag: "DepsReady", install: A, parts: [firstPart] };
    expect(await viaEntrypoint(request(X, A, one))).toEqual(built);
    // The first candidate's pointer does not serve the second: another box installs, from its own inputs.
    expect(await viaEntrypoint(request(X, B, other))).toEqual({
      _tag: "DepsReady",
      install: B,
      parts: [secondPart],
    });
    expect([first.started(), second.started()]).toMatchObject([
      [{ env: { KEEL_INSTALL: A, KEEL_INSTALL_INPUTS: one } }],
      [{ env: { KEEL_INSTALL: B, KEEL_INSTALL_INPUTS: other } }],
    ]);
    // Two pointers side by side: the second build wrote nothing over the first.
    expect([await pointerAt(X, A), await pointerAt(X, B)]).toMatchObject([
      { install: A, parts: [firstPart] },
      { install: B, parts: [secondPart] },
    ]);
    // So the first candidate, asked for again, is answered from its own pointer, and nothing is installed.
    expect(await viaEntrypoint(request(X, A, one))).toEqual(built);
    expect([first.started().length, second.started().length]).toEqual([1, 1]);
  });

  it("[deps.pool.entrypoint] answers unavailable for a request that does not decode, and reaches no box", async () => {
    const L = "70".repeat(32);
    const box = boxNamed(`deps:${X}:${L}`);
    box.runs(async () => refusalOf("install-failed"));
    const good = request(X, L);
    for (const wire of [
      null,
      {},
      { ...good, namespace: "keel-verify" },
      { ...good, need: { _tag: "Unlocked", reason: "no-lockfile" } },
      { ...good, need: { ...good.need, install: "70".repeat(31) } },
      { ...good, need: { _tag: "Locked", install: L } },
      { ...good, need: { _tag: "Locked", inputs: good.need.inputs } },
      { ...good, need: { ...good.need, inputs: 7 } },
      { namespace: good.namespace, need: good.need },
    ])
      expect({ wire, answer: await viaEntrypoint(wire) }).toEqual({
        wire,
        answer: { _tag: "DepsUnavailable", reason: "the deps build request did not decode" },
      });
    expect(box.started()).toHaveLength(0);
    // The box says the same to a caller that reaches it directly.
    expect(await answered(box.stub.build({ ...good, bundleUrl: 7 }))).toEqual({
      _tag: "DepsUnavailable",
      reason: "the deps build request did not decode",
    });
  });
});
