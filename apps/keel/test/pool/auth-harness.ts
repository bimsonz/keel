/**
 * Drives Better Auth's routes the way a browser would: a cookie jar, the
 * site's own Origin, and a software authenticator for passkeys (P-256, "none"
 * attestation, CBOR and DER encoded by hand, signed with WebCrypto).
 */
import { BASE } from "./helpers.ts";

export const HOST = new URL(BASE).host;
export const AUTH = `${BASE}/v1/auth`;
export const SESSION_COOKIE = "__Secure-keel.session_token";

/** What Set-Cookie said last, sent back on every request. */
export class Jar {
  readonly cookies = new Map<string, string>();
  /** Every Set-Cookie line seen, attributes included. */
  readonly lines: string[] = [];
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      this.lines.push(line);
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      const value = pair.slice(at + 1);
      if (value === "" || /max-age=0/i.test(line)) this.cookies.delete(pair.slice(0, at));
      else this.cookies.set(pair.slice(0, at), value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export interface Answer {
  readonly status: number;
  // oxlint-disable-next-line no-explicit-any -- Better Auth's answers are read loosely, field by field.
  readonly json: any;
  readonly text: string;
  readonly headers: Headers;
}

export type Fetcher = (request: Request) => Promise<Response>;

/** Calls one of Better Auth's routes, as the site's own page unless `origin` says otherwise. */
export function caller(fetcher: Fetcher) {
  return async (
    path: string,
    init: {
      method?: string;
      body?: unknown;
      jar?: Jar;
      headers?: Record<string, string>;
      origin?: string | null;
    } = {},
  ): Promise<Answer> => {
    const headers = new Headers(init.headers);
    // Each call comes from its own address, so the per-IP limit binds only where a test means it to.
    if (!headers.has("cf-connecting-ip"))
      headers.set("cf-connecting-ip", `2001:db8::${crypto.randomUUID().slice(0, 4)}`);
    if (init.origin !== null) headers.set("origin", init.origin ?? BASE);
    if (init.jar !== undefined && init.jar.cookies.size > 0)
      headers.set("cookie", init.jar.header());
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetcher(
      new Request(`${AUTH}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
    init.jar?.take(response);
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text, headers: response.headers };
  };
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | { [k: string]: Cbor };
function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
}
function cbor(value: Cbor): Uint8Array {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const b = utf8(value);
    return concat(head(3, b.length), b);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return concat(head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)]));
}

/** IEEE P1363 r||s, as WebCrypto signs, to the DER WebAuthn carries. */
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if ((v[0] ?? 0) & 0x80) v = concat(Uint8Array.of(0), v);
    return concat(Uint8Array.of(2, v.length), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

const fromB64 = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** A platform authenticator for keel.localhost, one credential per instance. */
export class Authenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  #keys: CryptoKeyPair | undefined;
  count = 0;

  async create(challenge: string) {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    if (!("privateKey" in keys)) throw new Error("P-256 did not generate a key pair");
    this.#keys = keys;
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    if (!("x" in jwk)) throw new Error("no JWK");
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64(jwk.x ?? "")],
        [-3, fromB64(jwk.y ?? "")],
      ]),
    );
    const authData = concat(
      await sha256(utf8(HOST)),
      Uint8Array.of(0x45), // UP | UV | AT
      Uint8Array.of(0, 0, 0, 0),
      new Uint8Array(16), // AAGUID
      Uint8Array.of(0, this.credentialId.length),
      this.credentialId,
      cose,
    );
    const clientData = utf8(
      JSON.stringify({ type: "webauthn.create", challenge, origin: BASE, crossOrigin: false }),
    );
    const id = b64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(cbor({ fmt: "none", attStmt: {}, authData })),
        transports: ["internal"],
      },
    };
  }

  async get(challenge: string) {
    if (this.#keys === undefined) throw new Error("create a credential first");
    this.count += 1;
    const authData = concat(
      await sha256(utf8(HOST)),
      Uint8Array.of(0x05), // UP | UV
      Uint8Array.of(0, 0, 0, this.count),
    );
    const clientData = utf8(
      JSON.stringify({ type: "webauthn.get", challenge, origin: BASE, crossOrigin: false }),
    );
    const signed = concat(authData, await sha256(clientData));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.#keys.privateKey, signed),
    );
    const id = b64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(der(raw)),
      },
    };
  }
}
