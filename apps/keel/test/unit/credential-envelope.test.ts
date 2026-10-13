import { describe, expect, it } from "vitest";
import {
  credentialAad,
  importKek,
  open,
  seal,
} from "../../src/adapters/driven/credentials/envelope.ts";

const base64Of = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const randomKek = (length = 32): string => base64Of(crypto.getRandomValues(new Uint8Array(length)));

const ORG = "org_01M4P00000000000000000000A";
const OTHER_ORG = "org_01M4P00000000000000000000B";
const CREDENTIAL = "crd_01M4P00000000000000000000C";
const OTHER_CREDENTIAL = "crd_01M4P00000000000000000000D";
const TOKEN = "cf-api-token-Zx9_0123456789abcdef";
/** WebCrypto's one answer to a seal that does not open: AES-KW's integrity check or GCM's tag failed. */
const REFUSED = "The operation failed for an operation-specific reason";
/** What else a secret may be: empty, beyond ASCII, or as long as a request takes. */
const SECRETS = ["", "jeton-ünïcödé-密钥-🔑", "x".repeat(4096)];

describe("a credential's envelope", () => {
  it("[cred.round-trip] opens to the secret it sealed, under the same KEK and the same namespace and id", async () => {
    const kek = await importKek(randomKek());
    const aad = credentialAad(ORG, CREDENTIAL);
    for (const secret of [TOKEN, ...SECRETS]) {
      const sealed = await seal(kek, "k1", aad, secret);
      expect(sealed).toMatchObject({ v: 1, kek: "k1" });
      await expect(open(kek, aad, sealed)).resolves.toBe(secret);
    }
  });

  it("[cred.aad-bound] does not open as another namespace's credential, or as another id in the same namespace", async () => {
    const kek = await importKek(randomKek());
    const sealed = await seal(kek, "k1", credentialAad(ORG, CREDENTIAL), TOKEN);
    await expect(open(kek, credentialAad(OTHER_ORG, CREDENTIAL), sealed)).rejects.toThrow(REFUSED);
    await expect(open(kek, credentialAad(ORG, OTHER_CREDENTIAL), sealed)).rejects.toThrow(REFUSED);
    // The seal itself is sound: it opens where it was made.
    await expect(open(kek, credentialAad(ORG, CREDENTIAL), sealed)).resolves.toBe(TOKEN);
  });

  it("[cred.dek-per-secret] seals the same secret twice under two data keys: no wrapped key, nonce or ciphertext in common", async () => {
    const kek = await importKek(randomKek());
    const aad = credentialAad(ORG, CREDENTIAL);
    const first = await seal(kek, "k1", aad, TOKEN);
    const second = await seal(kek, "k1", aad, TOKEN);
    expect(second.wrapped).not.toBe(first.wrapped);
    expect(second.ct).not.toBe(first.ct);
    expect(second.iv).not.toBe(first.iv);
    await expect(open(kek, aad, first)).resolves.toBe(TOKEN);
    await expect(open(kek, aad, second)).resolves.toBe(TOKEN);
  });

  it("[cred.wrong-kek] does not open under another KEK", async () => {
    const kek = await importKek(randomKek());
    const other = await importKek(randomKek());
    const aad = credentialAad(ORG, CREDENTIAL);
    const sealed = await seal(kek, "k1", aad, TOKEN);
    await expect(open(other, aad, sealed)).rejects.toThrow(REFUSED);
    await expect(open(kek, aad, sealed)).resolves.toBe(TOKEN);
  });

  it("[cred.kek-length] takes a KEK of exactly 32 bytes and refuses 16 or 33", async () => {
    await expect(importKek(randomKek(16))).rejects.toThrow(/32 bytes, and this one is 16/);
    await expect(importKek(randomKek(33))).rejects.toThrow(/32 bytes, and this one is 33/);
    const kek = await importKek(randomKek(32));
    expect(kek.algorithm).toMatchObject({ name: "AES-KW" });
    expect(kek.usages.toSorted()).toEqual(["unwrapKey", "wrapKey"]);
  });
});
