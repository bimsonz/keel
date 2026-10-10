import { NotImplemented } from "@keeltown/core/not-implemented";
import { Cause, Effect, Exit } from "effect";
import { decodeExit, type ExitCodec } from "../../../rpc/index.ts";

/**
 * A Durable Object's answer, back in the hexagon: its Exit envelope decoded
 * into the same success value or tagged error. A rejected call (the object
 * threw, or the transport failed) is a defect.
 *
 * A defect crosses RPC as a plain Error that keeps its name. A DO method a
 * lane has not built yet dies with NotImplemented; it is rebuilt here, so the
 * doorway still answers the declared 503 rather than a 500.
 */
export function callObject<A, E>(
  codec: ExitCodec<A, E>,
  call: () => Promise<unknown>,
): Effect.Effect<A, E> {
  return Effect.flatMap(Effect.promise(call), (json): Effect.Effect<A, E> => {
    const exit = decodeExit(codec, json);
    if (Exit.isSuccess(exit) || !Cause.hasDies(exit.cause)) return exit;
    const defect = Cause.squash(exit.cause);
    return defect instanceof Error && defect.name === "NotImplemented"
      ? Effect.die(new NotImplemented(defect.message.replace(/ is not implemented yet$/, "")))
      : exit;
  });
}

/** Object keys sorted at every depth, so equal bodies hash equal however their keys were ordered. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => [key, canonical(field)]),
  );
}

/** `sha256:` and the hex digest of the body's canonical JSON: what tells a retry from a reused key. */
export async function fingerprintOf(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(body)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID body derived from `parts`: SHA-256 of the parts joined by NUL, read
 * as 128 bits in Crockford base32 (so the first character is 0–7, as a ULID's
 * must be). An idempotent create derives its DO's id this way from the caller
 * and the Idempotency-Key, so a retry reaches the same DO with no reservation.
 */
export async function derivedUlid(...parts: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join("\u0000"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let bits = 0n;
  for (const byte of digest.subarray(0, 16)) bits = (bits << 8n) | BigInt(byte);
  let body = "";
  for (let i = 0; i < 26; i += 1) {
    body = CROCKFORD.charAt(Number(bits & 31n)) + body;
    bits >>= 5n;
  }
  return body;
}

/** `sha256:` and the hex digest of a string, as credentials store a secret. */
export async function sha256Of(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `sha256:${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
