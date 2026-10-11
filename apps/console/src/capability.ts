// A capability to rule on one question: what a QR code carries to a phone.
//
// It is `payload.signature`, both base64url. The payload names one escalation,
// when the capability stops being good, and a nonce. The signature is
// HMAC-SHA-256 over the payload with a key only the console's Worker holds, so
// the page and the phone can read a capability and cannot make one.
//
// Nothing is stored. What makes it good once is Keel: an escalation is ruled
// from open and from nowhere else, and the nonce is the ruling's idempotency key.

export interface Claim {
  escalationId: string;
  /** Seconds since the epoch after which it is refused. */
  expires: number;
  nonce: string;
}

export type Checked =
  | { ok: true; claim: Claim }
  | { ok: false; reason: "malformed" | "forged" | "expired" };

/** How long a capability is good for, in seconds. */
export const CAPABILITY_TTL = 600;

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[\w-]+$/.test(text)) return null;
  try {
    return Uint8Array.from(
      atob(text.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.codePointAt(0) ?? 0,
    );
  } catch {
    return null;
  }
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** What a capability says, without checking who said it. The page uses this to know which question a link is for. */
export function readClaim(capability: string): Claim | null {
  const payload = fromBase64Url(capability.split(".")[0] ?? "");
  if (payload === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  const fields = new Map<string, unknown>(
    typeof parsed === "object" && parsed !== null ? Object.entries(parsed) : [],
  );
  const [escalationId, expires, nonce] = [fields.get("e"), fields.get("x"), fields.get("n")];
  if (
    typeof escalationId !== "string" ||
    escalationId === "" ||
    typeof expires !== "number" ||
    typeof nonce !== "string" ||
    nonce === ""
  )
    return null;
  return { escalationId, expires, nonce };
}

export async function mintCapability(secret: string, claim: Claim): Promise<string> {
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ e: claim.escalationId, x: claim.expires, n: claim.nonce }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** `now` is in seconds since the epoch. The signature is checked before anything the payload says is believed. */
export async function checkCapability(
  secret: string,
  capability: string,
  now: number,
): Promise<Checked> {
  const [payload, signature, ...rest] = capability.split(".");
  const signed = fromBase64Url(signature ?? "");
  if (payload === undefined || signed === null || rest.length > 0)
    return { ok: false, reason: "malformed" };
  const genuine = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signed,
    new TextEncoder().encode(payload),
  );
  if (!genuine) return { ok: false, reason: "forged" };
  const claim = readClaim(capability);
  if (claim === null) return { ok: false, reason: "malformed" };
  return claim.expires <= now ? { ok: false, reason: "expired" } : { ok: true, claim };
}
