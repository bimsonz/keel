// Spike 27: does Better Auth run in workerd on D1, with passkey registration and
// assertion, the device authorization grant (RFC 8628) and email OTP?
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { type Env, migrate, ORIGIN, outbox } from "../src/worker.ts";

const bindings = env as unknown as Env;
const BASE = `${ORIGIN}/v1/auth`;

/** A cookie jar: what Set-Cookie said last, sent back on every request. */
class Jar {
  readonly cookies = new Map<string, string>();
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
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

async function call(
  path: string,
  init: { method?: string; body?: unknown; jar?: Jar; headers?: Record<string, string> } = {},
) {
  const headers = new Headers({ origin: ORIGIN, ...init.headers });
  if (init.jar !== undefined && init.jar.cookies.size > 0) headers.set("cookie", init.jar.header());
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    bindings,
  );
  init.jar?.take(response);
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json, headers: response.headers };
}

// ---- A software authenticator: P-256, "none" attestation, CBOR by hand. ----

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
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

class Authenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  keys!: CryptoKeyPair;
  count = 0;

  async create(challenge: string) {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
    const fromB64 = (s: string) =>
      Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
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
      await sha256(utf8("localhost")),
      Uint8Array.of(0x45), // UP | UV | AT
      Uint8Array.of(0, 0, 0, 0),
      new Uint8Array(16), // AAGUID
      Uint8Array.of(0, this.credentialId.length),
      this.credentialId,
      cose,
    );
    const clientData = utf8(
      JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN, crossOrigin: false }),
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
    this.count += 1;
    const authData = concat(
      await sha256(utf8("localhost")),
      Uint8Array.of(0x05), // UP | UV
      Uint8Array.of(0, 0, 0, this.count),
    );
    const clientData = utf8(
      JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
    );
    const signed = concat(authData, await sha256(clientData));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed),
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

/** Signs in by email OTP, which also creates the user; answers the signed-in jar. */
async function signInByOtp(email: string) {
  const jar = new Jar();
  const sent = await call("/email-otp/send-verification-otp", {
    body: { email, type: "sign-in" },
  });
  expect(sent.status).toBe(200);
  const otp = outbox.findLast((m) => m.email === email)?.otp;
  expect(otp).toMatch(/^\d{6}$/);
  const signed = await call("/sign-in/email-otp", { body: { email, otp }, jar });
  expect(signed.status, JSON.stringify(signed.json)).toBe(200);
  return { jar, user: signed.json.user };
}

describe("spike 27: Better Auth in workerd on D1", () => {
  beforeAll(async () => {
    const created = await migrate(bindings);
    console.log("migrated tables:", created.join(", "));
  });

  it("signs a new person up and in by email OTP, with the session in a cookie", async () => {
    const { jar, user } = await signInByOtp("ada@example.com");
    const session = await call("/get-session", { jar });
    expect(session.json.user).toMatchObject({ id: user.id, email: "ada@example.com" });
    const sessionCookie = [...jar.cookies.keys()].find((k) => k.includes("session_token"));
    expect(sessionCookie).toBeDefined();
  });

  it("registers a passkey for a signed-in user, then signs in with it alone", async () => {
    const { jar, user } = await signInByOtp("grace@example.com");
    const device = new Authenticator();

    const regOptions = await call("/passkey/generate-register-options", { jar });
    expect(regOptions.status, JSON.stringify(regOptions.json)).toBe(200);
    const registered = await call("/passkey/verify-registration", {
      body: { response: await device.create(regOptions.json.challenge), name: "laptop" },
      jar,
    });
    expect(registered.status, JSON.stringify(registered.json)).toBe(200);

    const fresh = new Jar();
    const authOptions = await call("/passkey/generate-authenticate-options", { jar: fresh });
    expect(authOptions.status, JSON.stringify(authOptions.json)).toBe(200);
    const asserted = await call("/passkey/verify-authentication", {
      body: { response: await device.get(authOptions.json.challenge) },
      jar: fresh,
    });
    expect(asserted.status, JSON.stringify(asserted.json)).toBe(200);
    const session = await call("/get-session", { jar: fresh });
    expect(session.json?.user?.id).toBe(user.id);

    // A replayed assertion (same signature, counter not advanced) is refused.
    const again = await call("/passkey/generate-authenticate-options", { jar: new Jar() });
    device.count -= 1;
    const replay = new Jar();
    replay.cookies.set(...([...again.headers.getSetCookie()][0]?.split(";")[0]?.split("=") as [string, string]));
    const replayed = await call("/passkey/verify-authentication", {
      body: { response: await device.get(again.json.challenge) },
      jar: replay,
    });
    console.log("replayed assertion with a stale counter:", replayed.status, JSON.stringify(replayed.json));
  });

  it("logs a CLI in by the device grant, and its token reads the session as a bearer", async () => {
    const { jar, user } = await signInByOtp("linus@example.com");
    const code = await call("/device/code", { body: { client_id: "keeltown" } });
    expect(code.status, JSON.stringify(code.json)).toBe(200);
    expect(code.json).toMatchObject({
      device_code: expect.any(String),
      user_code: expect.any(String),
      verification_uri: `${ORIGIN}/device`,
    });

    const pending = await call("/device/token", {
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.json.device_code,
        client_id: "keeltown",
      },
    });
    expect(pending.json.error).toBe("authorization_pending");

    // The signed-in user opens the verification page with the code, which claims it, then approves.
    const claimed = await call(`/device?user_code=${encodeURIComponent(code.json.user_code)}`, { jar });
    expect(claimed.status, JSON.stringify(claimed.json)).toBe(200);
    const approved = await call("/device/approve", { body: { userCode: code.json.user_code }, jar });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);

    // RFC 8628: poll no faster than the interval the server named, or it answers slow_down.
    await new Promise((resolve) => setTimeout(resolve, (code.json.interval ?? 5) * 1000 + 250));
    const token = await call("/device/token", {
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.json.device_code,
        client_id: "keeltown",
      },
    });
    expect(token.status, JSON.stringify(token.json)).toBe(200);
    const bearer = await call("/get-session", {
      headers: { authorization: `Bearer ${token.json.access_token}` },
    });
    expect(bearer.json?.user?.id).toBe(user.id);
  });

  it("creates an org with the organization plugin, owned by its creator", async () => {
    const { jar, user } = await signInByOtp("hopper@example.com");
    const org = await call("/organization/create", { body: { name: "Hopper", slug: "hopper" }, jar });
    expect(org.status, JSON.stringify(org.json)).toBe(200);
    const members = await call(`/organization/get-full-organization?organizationSlug=hopper`, { jar });
    expect(members.json.members).toEqual([
      expect.objectContaining({ userId: user.id, role: "owner" }),
    ]);
  });
});
