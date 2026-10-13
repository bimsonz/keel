import { describe, expect, it } from "vitest";
import { bundleUrlSigned, signedBundleUrl } from "../src/index.ts";
import { fc } from "./support/fast-check.ts";

const pem = (label: string, der: ArrayBuffer): string =>
  `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END ${label}-----\n`;

/** A fresh Ed25519 pair, each half in the PEM Terraform's `tls_private_key` outputs. */
const keys = async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Ed25519 did not generate a key pair");
  return {
    signingKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
};

const X = "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0";
const Y = "usr_01JZ8PT2C4E6G8J0M2N4Q6S8V1";
const HEX = "ab".repeat(32);
const OTHER_HEX = "cd".repeat(32);
const EXPIRES = 1_800_000_000;

/** A PEM key as the bare base64 of its DER. */
const bare = (key: string) => key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");

/** What the bundle host is asked: the path's namespace and hash, and the query as it arrived. */
const asked = (url: string) => {
  const { pathname, searchParams } = new URL(url);
  const [, namespace = "", sha256 = ""] = pathname.split("/");
  return { namespace, sha256, query: searchParams };
};

describe("a signed bundle URL", () => {
  it("[t5.bundle-url.signed] names the namespace's bundle, when it expires and a signature the public key verifies until then", async () => {
    const { signingKey, publicKey } = await keys();
    const url = await signedBundleUrl(signingKey, X, `sha256:${HEX}`, EXPIRES);
    expect(url).toMatch(
      /^https:\/\/bundles\.keel\.internal\/org_01JZ8PT2C4E6G8J0M2N4Q6S8V0\/(ab){32}\?exp=1800000000&sig=[A-Za-z0-9_-]{86}$/,
    );
    const { namespace, sha256, query } = asked(url);
    expect([namespace, sha256]).toEqual([X, HEX]);
    expect(await bundleUrlSigned(publicKey, X, HEX, query, EXPIRES - 1_800)).toBe(true);
    expect(await bundleUrlSigned(publicKey, X, HEX, query, EXPIRES)).toBe(true);
  });

  it("[t5.bundle-url.expired] is refused once its expiry has passed", async () => {
    const { signingKey, publicKey } = await keys();
    const { query } = asked(await signedBundleUrl(signingKey, X, `sha256:${HEX}`, EXPIRES));
    expect(await bundleUrlSigned(publicKey, X, HEX, query, EXPIRES + 1)).toBe(false);
  });

  it("[t5.bundle-url.other-namespace] fetches nothing for another namespace, another bundle or a later expiry", async () => {
    const { signingKey, publicKey } = await keys();
    const { query } = asked(await signedBundleUrl(signingKey, X, `sha256:${HEX}`, EXPIRES));
    const now = EXPIRES - 60;
    // X's signature, asked of Y's id with the same hash: the hash alone opens nothing.
    expect(await bundleUrlSigned(publicKey, Y, HEX, query, now)).toBe(false);
    expect(await bundleUrlSigned(publicKey, X, OTHER_HEX, query, now)).toBe(false);
    const later = new URLSearchParams(query);
    later.set("exp", String(EXPIRES + 3_600));
    expect(await bundleUrlSigned(publicKey, X, HEX, later, now)).toBe(false);
  });

  it("[t5.bundle-url.unsigned] is refused with no signature, no expiry, or either malformed", async () => {
    const { signingKey, publicKey } = await keys();
    const { query } = asked(await signedBundleUrl(signingKey, X, `sha256:${HEX}`, EXPIRES));
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
    expect(await bundleUrlSigned(publicKey, X, HEX, new URLSearchParams(), now)).toBe(false);
    expect(await bundleUrlSigned(publicKey, X, HEX, without("sig"), now)).toBe(false);
    expect(await bundleUrlSigned(publicKey, X, HEX, without("exp"), now)).toBe(false);
    expect(await bundleUrlSigned(publicKey, X, HEX, having("sig", "A".repeat(86)), now)).toBe(
      false,
    );
    expect(await bundleUrlSigned(publicKey, X, HEX, having("sig", "not a signature"), now)).toBe(
      false,
    );
    expect(await bundleUrlSigned(publicKey, X, HEX, having("exp", "never"), now)).toBe(false);
  });

  it("[t5.bundle-url.other-key] is refused when another key signed it", async () => {
    const [ours, theirs] = [await keys(), await keys()];
    const { query } = asked(await signedBundleUrl(theirs.signingKey, X, `sha256:${HEX}`, EXPIRES));
    expect(await bundleUrlSigned(ours.publicKey, X, HEX, query, EXPIRES - 60)).toBe(false);
    expect(await bundleUrlSigned(theirs.publicKey, X, HEX, query, EXPIRES - 60)).toBe(true);
  });

  it("[t5.bundle-url.keys] takes each key as PEM or as the bare base64 of its DER", async () => {
    const { signingKey, publicKey } = await keys();
    const { query } = asked(await signedBundleUrl(bare(signingKey), X, `sha256:${HEX}`, EXPIRES));
    expect(await bundleUrlSigned(bare(publicKey), X, HEX, query, EXPIRES - 60)).toBe(true);
    expect(await bundleUrlSigned(publicKey, X, HEX, query, EXPIRES - 60)).toBe(true);
  });

  it("[t5.bundle-url.tampered] verifies only for exactly what was signed", async () => {
    const { signingKey, publicKey } = await keys();
    const hex = fc.stringMatching(/^[0-9a-f]{64}$/);
    const id = fc.stringMatching(/^(org|usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$/);
    await fc.assert(
      fc.asyncProperty(
        id,
        hex,
        // Nothing: asked for the namespace, or the bundle, that was signed.
        fc.option(id, { nil: undefined }),
        fc.option(hex, { nil: undefined }),
        fc.integer({ min: -3_600, max: 3_600 }),
        async (namespace, sha256, anotherNamespace, anotherSha256, skew) => {
          const { query } = asked(
            await signedBundleUrl(signingKey, namespace, `sha256:${sha256}`, EXPIRES),
          );
          const [askedNamespace, askedSha256] = [
            anotherNamespace ?? namespace,
            anotherSha256 ?? sha256,
          ];
          const same = askedNamespace === namespace && askedSha256 === sha256;
          expect(
            await bundleUrlSigned(publicKey, askedNamespace, askedSha256, query, EXPIRES + skew),
          ).toBe(same && skew <= 0);
        },
      ),
    );
  });

  it("refuses to sign for anything that is not a namespace id and a bundle hash", async () => {
    const { signingKey } = await keys();
    await expect(signedBundleUrl(signingKey, "../x", `sha256:${HEX}`, EXPIRES)).rejects.toThrow(
      "not a namespace id",
    );
    await expect(signedBundleUrl(signingKey, X, HEX, EXPIRES)).rejects.toThrow("not a bundle hash");
  });
});
