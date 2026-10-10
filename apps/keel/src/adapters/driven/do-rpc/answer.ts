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
