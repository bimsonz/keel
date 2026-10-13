// SSH signatures by an Ed25519 key (OpenSSH's PROTOCOL.sshsig), as git writes
// one into a commit's `gpgsig` header under `gpg.format=ssh`, and the
// allowed-signers file a verifier checks them against. Ed25519 signs
// deterministically, so one key and one payload give one signature.

import { concat, enc } from "./bytes.ts";

const MAGIC = enc.encode("SSHSIG");
const SIG_VERSION = 1;
const KEY_TYPE = "ssh-ed25519";
/** The hash taken of the payload, and the name the signature gives it. */
const HASH = { label: "sha512", algorithm: "SHA-512" } as const;
/** The namespace git signs and verifies its objects under. */
export const GIT_NAMESPACE = "git";
/** ssh-keygen breaks the armor's base64 at this width. */
const ARMOR_WIDTH = 70;

/** An Ed25519 key that signs as SSH does. */
export interface SshSigningKey {
  readonly privateKey: CryptoKey;
  /** The raw 32-byte public key, which every signature carries. */
  readonly publicKey: Uint8Array;
}

function uint32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

/** SSH's `string`: a four-byte length, then the bytes. */
const string = (bytes: Uint8Array) => concat([uint32(bytes.length), bytes]);
const text = (s: string) => string(enc.encode(s));

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < out.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The key as SSH puts it on the wire: its type, then the raw key. */
const keyBlob = (publicKey: Uint8Array) => concat([text(KEY_TYPE), string(publicKey)]);

/** `ssh-ed25519 <base64>`: the key as an allowed-signers or authorized_keys line names it. */
export function sshPublicKey(publicKey: Uint8Array): string {
  return `${KEY_TYPE} ${toBase64(keyBlob(publicKey))}`;
}

const PKCS8_PEM = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/;

/**
 * Imports an Ed25519 private key from PKCS#8 PEM and derives its public half.
 * The key kept for signing cannot be exported again. An error never repeats
 * the text it was given.
 */
export async function importSshSigningKey(pkcs8Pem: string): Promise<SshSigningKey> {
  const body = PKCS8_PEM.exec(pkcs8Pem.trim())?.[1];
  if (body === undefined) throw new Error("the signing key is not a PKCS#8 PEM private key");
  const der = fromBase64(body.replace(/\s+/g, ""));
  const algorithm = { name: "Ed25519" };
  const exportable = await crypto.subtle.importKey("pkcs8", der, algorithm, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", exportable);
  const x = "x" in jwk ? jwk.x : undefined;
  if (x === undefined) throw new Error("the signing key has no public half");
  return {
    privateKey: await crypto.subtle.importKey("pkcs8", der, algorithm, false, ["sign"]),
    publicKey: fromBase64(x.replaceAll("-", "+").replaceAll("_", "/")),
  };
}

/**
 * The armored signature `ssh-keygen -Y sign -n <namespace>` writes for
 * `payload` with the same key: the key signs the payload's hash under the
 * namespace, and the armor carries the public key beside the signature.
 */
export async function sshSignature(
  key: SshSigningKey,
  payload: Uint8Array,
  namespace: string = GIT_NAMESPACE,
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(HASH.algorithm, concat([payload])));
  const signed = concat([MAGIC, text(namespace), text(""), text(HASH.label), string(digest)]);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, signed),
  );
  const blob = concat([
    MAGIC,
    uint32(SIG_VERSION),
    string(keyBlob(key.publicKey)),
    text(namespace),
    text(""),
    text(HASH.label),
    string(concat([text(KEY_TYPE), string(signature)])),
  ]);
  const base64 = toBase64(blob);
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += ARMOR_WIDTH) lines.push(base64.slice(i, i + ARMOR_WIDTH));
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

/** A key a principal signs with, and when. */
export interface SignerKey {
  /** The key as `sshPublicKey` writes it: `ssh-ed25519 <base64>`. */
  readonly publicKey: string;
  /** Unix seconds: the key signs what is dated from here on, this second included. */
  readonly validAfter?: number | undefined;
  /** Unix seconds: the key signs what is dated up to here, this second included. */
  readonly validBefore?: number | undefined;
}

/** Whether `key` signs what is dated `time` (Unix seconds): inside its window, as ssh-keygen reads one. */
export function signsAt(key: SignerKey, time: number): boolean {
  return (
    (key.validAfter === undefined || time >= key.validAfter) &&
    (key.validBefore === undefined || time <= key.validBefore)
  );
}

/** `YYYYMMDDHHMMSSZ`. Without the `Z` ssh-keygen reads a time in the verifier's own zone. */
function utc(seconds: number): string {
  if (!Number.isInteger(seconds)) throw new Error("bad signer window");
  return `${new Date(seconds * 1000).toISOString().replaceAll(/[-:T]/g, "").slice(0, 14)}Z`;
}

/**
 * An allowed-signers file: one line per key, each naming `principal`, the git
 * namespace alone and the key's window. git verifies a commit against it with
 * `gpg.ssh.allowedSignersFile`, by the commit's committer time.
 */
export function allowedSigners(principal: string, keys: readonly SignerKey[]): string {
  // A principal is a pattern list to ssh-keygen: nothing that separates, quotes, negates or globs.
  if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(principal))
    throw new Error(`bad principal ${JSON.stringify(principal)}`);
  return keys
    .map((key) => {
      if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(key.publicKey))
        throw new Error("bad signer key");
      const options = [`namespaces="${GIT_NAMESPACE}"`];
      if (key.validAfter !== undefined) options.push(`valid-after="${utc(key.validAfter)}"`);
      if (key.validBefore !== undefined) options.push(`valid-before="${utc(key.validBefore)}"`);
      return `${principal} ${options.join(",")} ${key.publicKey}\n`;
    })
    .join("");
}
