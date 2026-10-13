import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BundleCheckout,
  type BundleServed,
  KeelSandbox,
  serveBundle,
} from "../../src/adapters/driving/do/keel-sandbox.ts";
import { signedUrl } from "./support/probes.ts";

/** The namespace whose bundles these reads are of, by id, and where the bucket keeps one of them. */
const NAMESPACE = "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0";
const bundleKey = (hash: string) => `ns/org_01JZ8PT2C4E6G8J0M2N4Q6S8V0/bundles/${hash}`;

const sha256Hex = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** Bytes that span several stream chunks, so a reader can stop part-way. */
const bundleBytes = () => crypto.getRandomValues(new Uint8Array(60_000));

/** The JSON log lines carrying `event`, as plain objects for `toMatchObject`. */
const logged = (spy: { mock: { calls: unknown[][] } }, event: string): unknown[] =>
  spy.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string") return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" &&
        parsed !== null &&
        "event" in parsed &&
        parsed.event === event
        ? [parsed]
        : [];
    } catch {
      return [];
    }
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bundle reads are logged, so a short read can be told from an extract fault", () => {
  it("[bundle.served] logs a full read with R2's size and etag and the sha256 actually read", async () => {
    const bytes = bundleBytes();
    const hash = await sha256Hex(bytes);
    await env.BUNDLES.put(bundleKey(hash), bytes);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await serveBundle(new Request(await signedUrl(hash)), env, {
      containerId: "box-1",
    });
    const served = new Uint8Array(await response.arrayBuffer());
    expect(await sha256Hex(served)).toBe(hash);
    const [entry, ...more] = logged(log, "keel.bundle.served");
    expect(more).toEqual([]);
    const object = await env.BUNDLES.head(bundleKey(hash));
    if (object === null) throw new Error("the bundle was not stored");
    expect(entry).toMatchObject({
      containerId: "box-1",
      namespace: "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      requested: hash,
      etag: object.etag,
      size: bytes.length,
      bytesRead: bytes.length,
      sha256Read: hash,
      ended: "end",
    } satisfies Partial<BundleServed>);
  });

  it("[bundle.served] logs a reader that hangs up early as a short, cancelled read", async () => {
    const bytes = bundleBytes();
    const hash = await sha256Hex(bytes);
    await env.BUNDLES.put(bundleKey(hash), bytes);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await serveBundle(new Request(await signedUrl(hash)), env, {
      containerId: "box-2",
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const first = await reader.read();
    await reader.cancel("curl went away");
    const short = first.value?.byteLength ?? 0;
    expect(short).toBeGreaterThan(0);
    expect(short).toBeLessThan(bytes.length);
    const [entry] = logged(log, "keel.bundle.served");
    expect(entry).toMatchObject({
      ended: "cancel",
      error: "curl went away",
      bytesRead: short,
    } satisfies Partial<BundleServed>);
    expect(entry).not.toMatchObject({ sha256Read: hash });
  });

  it("logs nothing for a HEAD, which reads no body", async () => {
    const bytes = bundleBytes();
    const hash = await sha256Hex(bytes);
    await env.BUNDLES.put(bundleKey(hash), bytes);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await serveBundle(
      new Request(await signedUrl(hash), { method: "HEAD" }),
      env,
      { containerId: "box-3" },
    );
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(logged(log, "keel.bundle.served")).toEqual([]);
  });
});

/** The base exec the engine reaches, faked: the pool cannot start a container. */
class FakeSandbox {
  readonly ctx = { id: { toString: () => "do-1" } };
  commands: string[] = [];
  async execWithSessionToken(command: string) {
    this.commands.push(command);
    return {
      exitCode: 2,
      stdout: "",
      stderr: "gzip: stdin: unexpected end of file\ntar: Child returned status 1",
    };
  }
}

/**
 * Runs `fn` against a KeelSandbox whose base is `FakeSandbox`, its own overrides
 * exactly as deployed. `super` resolves at call time, so the fake base stays in
 * place until `fn` settles.
 */
const overFake = async <T>(fn: (sandbox: KeelSandbox & FakeSandbox) => Promise<T>) => {
  const base = Reflect.getPrototypeOf(KeelSandbox);
  const baseProto = Reflect.getPrototypeOf(KeelSandbox.prototype);
  Reflect.setPrototypeOf(KeelSandbox, FakeSandbox);
  Reflect.setPrototypeOf(KeelSandbox.prototype, FakeSandbox.prototype);
  try {
    const built: unknown = Reflect.construct(KeelSandbox, [{}, env]);
    if (!(built instanceof KeelSandbox && built instanceof FakeSandbox))
      throw new Error("KeelSandbox did not construct over the fake base");
    return await fn(built);
  } finally {
    Reflect.setPrototypeOf(KeelSandbox, base);
    Reflect.setPrototypeOf(KeelSandbox.prototype, baseProto);
  }
};

describe("the engine's archive checkout is logged with its exit code and stderr", () => {
  const hash = "d".repeat(64);
  const checkout = `rm -rf '/workspace' && mkdir -p '/workspace' && curl --connect-timeout 10 --max-time 300 --fail --silent --show-error --location 'https://bundles.keel.internal/${NAMESPACE}/${hash}?exp=1800000000&sig=${"A".repeat(86)}' | tar -xz --strip-components=1 -C '/workspace'`;

  it("[bundle.checkout] logs the checkout's exit code and stderr, and passes its result through", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await overFake((sandbox) => sandbox.execWithSessionToken(checkout, "s"));
    expect(result.exitCode).toBe(2);
    const [entry, ...more] = logged(log, "keel.bundle.checkout");
    expect(more).toEqual([]);
    expect(entry).toMatchObject({
      containerId: "do-1",
      requested: hash,
      exitCode: 2,
      stderr: "gzip: stdin: unexpected end of file\ntar: Child returned status 1",
    } satisfies Partial<BundleCheckout>);
  });

  it("logs no other command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const commands = await overFake(async (sandbox) => {
      await sandbox.execWithSessionToken("test -c /dev/fuse", "s");
      return sandbox.commands;
    });
    expect(commands).toEqual(["test -c /dev/fuse"]);
    expect(logged(log, "keel.bundle.checkout")).toEqual([]);
  });
});
