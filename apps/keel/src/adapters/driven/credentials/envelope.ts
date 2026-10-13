/**
 * Envelope encryption of an org's credentials, on WebCrypto alone.
 * Each secret is sealed with a data key of its own (AES-GCM-256), made for it
 * and never reused; the data key is kept only wrapped (AES-KW) by the
 * key-encryption key (KEK) that Secrets Store holds. The additional data binds
 * a seal to its namespace and its credential's id, so a seal copied to
 * another row does not open there.
 */

/** A sealed secret, as it is kept: every field base64 but the version and the KEK's id. */
export interface Sealed {
  readonly v: 1;
  /** The id of the KEK that wrapped the data key, so a seal says which key opens it. */
  readonly kek: string;
  /** The data key, wrapped by the KEK with AES-KW. */
  readonly wrapped: string;
  /** AES-GCM's 12-byte nonce. */
  readonly iv: string;
  /** The ciphertext with its 16-byte tag. */
  readonly ct: string;
}

const KEK_BYTES = 32;
const IV_BYTES = 12;
const DATA_KEY = { name: "AES-GCM", length: 256 } as const;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** What a seal's additional data is: the namespace and the credential, so it opens in that one row alone. */
export const credentialAad = (namespaceId: string, credentialId: string): string =>
  `${namespaceId}/${credentialId}`;

/** The KEK from its base64 text: exactly 32 bytes, for wrapping and unwrapping keys and nothing else. */
export const importKek = async (raw: string): Promise<CryptoKey> => {
  const bytes = fromBase64(raw);
  if (bytes.length !== KEK_BYTES)
    throw new Error(`a credential KEK is ${KEK_BYTES} bytes, and this one is ${bytes.length}`);
  return crypto.subtle.importKey("raw", bytes, "AES-KW", false, ["wrapKey", "unwrapKey"]);
};

/**
 * Seals `plaintext` under a data key made for it alone, with `aad` as the
 * additional data, and wraps that data key with the KEK. Two seals of the
 * same secret share no key, nonce or byte of ciphertext.
 */
export const seal = async (
  kek: CryptoKey,
  kekId: string,
  aad: string,
  plaintext: string,
): Promise<Sealed> => {
  const dataKey = await crypto.subtle.generateKey(DATA_KEY, true, ["encrypt", "decrypt"]);
  if ("privateKey" in dataKey) throw new Error("AES-GCM made a key pair");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8.encode(aad) },
    dataKey,
    utf8.encode(plaintext),
  );
  const wrapped = await crypto.subtle.wrapKey("raw", dataKey, kek, "AES-KW");
  return {
    v: 1,
    kek: kekId,
    wrapped: toBase64(new Uint8Array(wrapped)),
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
  };
};

/**
 * Opens a seal: unwraps its data key with the KEK and decrypts with the same
 * additional data. Rejects on any mismatch: another KEK, another namespace or
 * credential, or a byte changed anywhere.
 */
export const open = async (kek: CryptoKey, aad: string, sealed: Sealed): Promise<string> => {
  if (sealed.v !== 1)
    throw new Error(`a seal of version ${String(sealed.v)} is not one this opens`);
  const dataKey = await crypto.subtle.unwrapKey(
    "raw",
    fromBase64(sealed.wrapped),
    kek,
    "AES-KW",
    DATA_KEY,
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: utf8.encode(aad) },
    dataKey,
    fromBase64(sealed.ct),
  );
  return fromUtf8.decode(plaintext);
};
