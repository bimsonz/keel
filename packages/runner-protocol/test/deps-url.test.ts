import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BundleUnreadable,
  bundleTexts,
  bundleUrlSigned,
  DEPS_HOST,
  depsPartUrlSigned,
  signedBundleUrl,
  signedDepsPartUrl,
  writeBundle,
} from "../src/index.ts";
import { fc } from "./support/fast-check.ts";

const pem = (label: string, der: ArrayBuffer): string =>
  `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END ${label}-----\n`;

/** A fresh Ed25519 pair, each half in the PEM Terraform's `tls_private_key` outputs, and the public half as a key. */
const keys = async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Ed25519 did not generate a key pair");
  return {
    signingKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
    verifier: pair.publicKey,
  };
};

const X = "usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0";
const Y = "org_01JZ8PT2C4E6G8J0M2N4Q6S8V1";
const HEX = "ab".repeat(32);
const OTHER_HEX = "cd".repeat(32);
const EXPIRES = 1_800_000_000;

/** What a host is asked: the path's namespace and hash, and the query as it arrived. */
const asked = (url: string) => {
  const { host, pathname, searchParams } = new URL(url);
  const [, namespace = "", sha256 = ""] = pathname.split("/");
  return { host, namespace, sha256, query: searchParams };
};

/** Whether `url`'s signature is the key's over exactly `text`, checked with nothing of the package. */
const signedOver = async (verifier: CryptoKey, url: string, text: string): Promise<boolean> => {
  const sig = new URL(url).searchParams.get("sig") ?? "";
  const raw = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  return crypto.subtle.verify("Ed25519", verifier, raw, new TextEncoder().encode(text));
};

describe("a signed deps part URL", () => {
  it("[deps.url.signed] names the namespace's part on the deps host, when it expires and a signature the public key verifies until then", async () => {
    const { signingKey, publicKey } = await keys();
    const url = await signedDepsPartUrl(signingKey, X, HEX, EXPIRES);
    expect(url).toMatch(
      /^https:\/\/deps\.keel\.internal\/usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0\/(ab){32}\?exp=1800000000&sig=[A-Za-z0-9_-]{86}$/,
    );
    const { host, namespace, sha256, query } = asked(url);
    expect([host, namespace, sha256]).toEqual([DEPS_HOST, X, HEX]);
    expect(await depsPartUrlSigned(publicKey, X, HEX, query, EXPIRES - 1_800)).toBe(true);
    expect(await depsPartUrlSigned(publicKey, X, HEX, query, EXPIRES)).toBe(true);
  });

  it("[deps.url.expired] is refused once its expiry has passed", async () => {
    const { signingKey, publicKey } = await keys();
    const { query } = asked(await signedDepsPartUrl(signingKey, X, HEX, EXPIRES));
    expect(await depsPartUrlSigned(publicKey, X, HEX, query, EXPIRES + 1)).toBe(false);
  });

  it("[deps.url.other-namespace] fetches nothing for another namespace, another part or a later expiry", async () => {
    const { signingKey, publicKey } = await keys();
    const { query } = asked(await signedDepsPartUrl(signingKey, X, HEX, EXPIRES));
    const now = EXPIRES - 60;
    // X's signature, asked of Y's id with the same hash: the hash alone opens nothing.
    expect(await depsPartUrlSigned(publicKey, Y, HEX, query, now)).toBe(false);
    expect(await depsPartUrlSigned(publicKey, X, OTHER_HEX, query, now)).toBe(false);
    const later = new URLSearchParams(query);
    later.set("exp", String(EXPIRES + 3_600));
    expect(await depsPartUrlSigned(publicKey, X, HEX, later, now)).toBe(false);
    expect(await depsPartUrlSigned(publicKey, X, HEX, query, now)).toBe(true);
  });

  it("[deps.url.not-a-bundles] a bundle URL's signature is no part's, and a part's no bundle's, for the same namespace, hash and expiry", async () => {
    const { signingKey, publicKey } = await keys();
    const bundle = asked(await signedBundleUrl(signingKey, X, `sha256:${HEX}`, EXPIRES));
    const part = asked(await signedDepsPartUrl(signingKey, X, HEX, EXPIRES));
    const now = EXPIRES - 60;
    // Each is good as what it was signed as: the refusals below are the family's doing.
    expect(await bundleUrlSigned(publicKey, X, HEX, bundle.query, now)).toBe(true);
    expect(await depsPartUrlSigned(publicKey, X, HEX, part.query, now)).toBe(true);
    expect(await depsPartUrlSigned(publicKey, X, HEX, bundle.query, now)).toBe(false);
    expect(await bundleUrlSigned(publicKey, X, HEX, part.query, now)).toBe(false);
  });

  it("[deps.url.signed-text] signs exactly the family, the namespace, the hash and the expiry, and a bundle URL still signs what it always has", async () => {
    const { signingKey, verifier } = await keys();
    const part = await signedDepsPartUrl(signingKey, X, HEX, EXPIRES);
    const bundle = await signedBundleUrl(signingKey, X, `sha256:${HEX}`, EXPIRES);
    expect(await signedOver(verifier, part, `deps-parts|${X}|${HEX}|${EXPIRES}`)).toBe(true);
    expect(await signedOver(verifier, bundle, `${X}|${HEX}|${EXPIRES}`)).toBe(true);
    expect(await signedOver(verifier, part, `${X}|${HEX}|${EXPIRES}`)).toBe(false);
    expect(await signedOver(verifier, bundle, `deps-parts|${X}|${HEX}|${EXPIRES}`)).toBe(false);
  });

  it("[deps.url.unsigned] is refused with no signature, no expiry, or either malformed", async () => {
    const { signingKey, publicKey } = await keys();
    const { query } = asked(await signedDepsPartUrl(signingKey, X, HEX, EXPIRES));
    const now = EXPIRES - 60;
    const without = (name: string) => {
      const q = new URLSearchParams(query);
      q.delete(name);
      return q;
    };
    const having = (name: string, value: string) => {
      const q = new URLSearchParams(query);
      q.set(name, value);
      return q;
    };
    const queries = [
      new URLSearchParams(),
      without("sig"),
      without("exp"),
      having("sig", "A".repeat(86)),
      having("sig", "not a signature"),
      having("exp", "never"),
    ];
    expect(
      await Promise.all(queries.map((q) => depsPartUrlSigned(publicKey, X, HEX, q, now))),
    ).toEqual(queries.map(() => false));
  });

  it("[deps.url.other-key] is refused when another key signed it", async () => {
    const [ours, theirs] = [await keys(), await keys()];
    const { query } = asked(await signedDepsPartUrl(theirs.signingKey, X, HEX, EXPIRES));
    expect(await depsPartUrlSigned(ours.publicKey, X, HEX, query, EXPIRES - 60)).toBe(false);
    expect(await depsPartUrlSigned(theirs.publicKey, X, HEX, query, EXPIRES - 60)).toBe(true);
  });

  it("[deps.url.tampered] verifies only for exactly what was signed, and never as a bundle's", async () => {
    const { signingKey, publicKey } = await keys();
    const hex = fc.stringMatching(/^[0-9a-f]{64}$/);
    const id = fc.stringMatching(/^(org|usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$/);
    await fc.assert(
      fc.asyncProperty(
        id,
        hex,
        // Nothing: asked for the namespace, or the part, that was signed.
        fc.option(id, { nil: undefined }),
        fc.option(hex, { nil: undefined }),
        fc.integer({ min: -3_600, max: 3_600 }),
        async (namespace, sha256, anotherNamespace, anotherSha256, skew) => {
          const { query } = asked(await signedDepsPartUrl(signingKey, namespace, sha256, EXPIRES));
          const [askedNamespace, askedSha256] = [
            anotherNamespace ?? namespace,
            anotherSha256 ?? sha256,
          ];
          const same = askedNamespace === namespace && askedSha256 === sha256;
          const now = EXPIRES + skew;
          expect(await depsPartUrlSigned(publicKey, askedNamespace, askedSha256, query, now)).toBe(
            same && skew <= 0,
          );
          expect(await bundleUrlSigned(publicKey, askedNamespace, askedSha256, query, now)).toBe(
            false,
          );
          // And asked for exactly what was signed, every time: good as a part's until it
          // expires, and at no time as a bundle's.
          expect(await depsPartUrlSigned(publicKey, namespace, sha256, query, now)).toBe(skew <= 0);
          expect(await bundleUrlSigned(publicKey, namespace, sha256, query, now)).toBe(false);
        },
      ),
    );
  });

  it("[deps.url.refused] refuses to sign for anything that is not a namespace id and a part's sha256", async () => {
    const { signingKey } = await keys();
    await expect(signedDepsPartUrl(signingKey, "../x", HEX, EXPIRES)).rejects.toThrow(
      "not a namespace id",
    );
    await expect(signedDepsPartUrl(signingKey, `deps-parts|${X}`, HEX, EXPIRES)).rejects.toThrow(
      "not a namespace id",
    );
    await Promise.all(
      [`sha256:${HEX}`, HEX.slice(1), HEX.toUpperCase(), `${HEX}?x=1`].map((sha256) =>
        expect(signedDepsPartUrl(signingKey, X, sha256, EXPIRES)).rejects.toThrow(
          "not a part's sha256",
        ),
      ),
    );
  });
});

describe("a bundle's texts", () => {
  const enc = new TextEncoder();
  const files = [
    { path: "pnpm-lock.yaml", bytes: enc.encode("lockfileVersion: '9.0'\n") },
    { path: "package.json", bytes: enc.encode("{}\n") },
    { path: "packages/x/pnpm-lock.yaml", bytes: enc.encode("nested\n") },
    { path: "packages/x/README.md", bytes: enc.encode("café\n") },
    { path: ".npmrc", bytes: enc.encode("hoist=false\n") },
  ];

  it("[deps.manifest] is the bundle's own: every file with its sha256, in the bundle's order", async () => {
    const { manifest } = await bundleTexts(await writeBundle(files));
    // Each file's sha256 written out, in bytewise path order, whatever order the files were given in.
    expect(manifest).toBe(
      [
        "d94d573d5aa644cdd09ff46d9b9c5e9b59185533420308c9a55ad5dc3176f22b  .npmrc",
        "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356  package.json",
        "7b49b9e063bd91a4f9252b413261f5557b9c570aa61516989499f64a62dbcdd6  packages/x/README.md",
        "370a8c04b8a65bb4494275eec227f1b694db04c76da6b0b8ae88ed1ab19790a3  packages/x/pnpm-lock.yaml",
        "f0bcde463fa201480015b9caa7db2017d3c1b6ca9c7e133df955038c54333d48  pnpm-lock.yaml",
        "",
      ].join("\n"),
    );
  });

  it("[deps.texts.read] reads the text of a file the bundle holds, by its whole path, and nothing at a path it does not hold", async () => {
    const { read } = await bundleTexts(await writeBundle(files));
    expect(read("package.json")).toBe("{}\n");
    expect(read(".npmrc")).toBe("hoist=false\n");
    // A file deeper in the tree is its own, whatever it is named like.
    expect(read("pnpm-lock.yaml")).toBe("lockfileVersion: '9.0'\n");
    expect(read("packages/x/pnpm-lock.yaml")).toBe("nested\n");
    expect(read("packages/x/README.md")).toBe("café\n");
    for (const path of [
      "absent.json",
      "packages/x/package.json",
      // A directory, the bundle's own manifest, a file by its name in the archive, and no path at all.
      "packages/x",
      ".keel-bundle.sha256",
      "candidate/package.json",
      "/package.json",
      "",
    ])
      expect({ path, text: read(path) }).toEqual({ path, text: undefined });
  });

  it("[deps.manifest] is read only from a whole bundle that is what its manifest lists", async () => {
    const bundle = await writeBundle(files);
    await expect(bundleTexts(bundle.slice(0, bundle.length - 20))).rejects.toBeInstanceOf(
      BundleUnreadable,
    );
    await expect(bundleTexts(enc.encode("not a bundle"))).rejects.toBeInstanceOf(BundleUnreadable);
    // A whole archive, one letter of one file changed after its manifest was written: a
    // file's bytes are under no checksum of the archive's own, so only the manifest tells.
    const tar = gunzipSync(bundle);
    tar.write("N", tar.indexOf("nested\n"));
    await expect(bundleTexts(new Uint8Array(gzipSync(tar)))).rejects.toThrow(
      "bundle unreadable: the files are not the ones the manifest lists",
    );
  });
});
