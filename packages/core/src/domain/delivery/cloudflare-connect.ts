import { Option, Result, Schema } from "effect";
import { ProjectId } from "../kernel/index.ts";
import { DeployTargetName } from "./deployment.ts";

/**
 * Connecting a Cloudflare account by its consent screen. An owner begins it on
 * a project's settings; Cloudflare sends them back with a code and the state
 * Keel gave; Keel exchanges the code once, on the one account they ticked,
 * for an API token of its own that may only edit that account's Workers.
 */

/** How long an owner has, from beginning a Connect, to come back from Cloudflare's consent screen. */
export const CONNECT_WINDOW_MS = 10 * 60_000;

/**
 * A Connect an owner has begun and not finished, as the project's own object
 * holds it under that owner: the target it sets, the nonce its state carries,
 * the PKCE verifier its code is exchanged with, and when it lapses. One at a
 * time per owner and project: beginning again replaces it.
 */
export const PendingConnect = Schema.Struct({
  target: DeployTargetName,
  nonce: Schema.String,
  verifier: Schema.String,
  expiresAt: Schema.Number,
});
export type PendingConnect = typeof PendingConnect.Type;

/**
 * A callback that finishes no Connect: this owner began none on this project
 * (or it was already finished), its state names another, or its window closed.
 */
export class ConnectStateRefused extends Schema.TaggedError<ConnectStateRefused>()(
  "ConnectStateRefused",
  { reason: Schema.Literals(["none", "mismatch", "expired"]) },
) {}

/** Whether two strings are equal, in a time that depends on their lengths alone and never on where they differ. */
export function sameSecret(a: string, b: string): boolean {
  let differs = a.length ^ b.length;
  const longest = Math.max(a.length, b.length);
  for (let index = 0; index < longest; index++)
    differs |= (a.charCodeAt(index) | 0) ^ (b.charCodeAt(index) | 0);
  return differs === 0;
}

/**
 * Whether a callback's nonce finishes the Connect held for its owner at `now`.
 * The nonce is compared in constant time; a window that has closed refuses as
 * surely as another nonce. The caller removes the pending Connect whatever
 * this answers, so a state is tried once.
 */
export function finishConnect(
  held: PendingConnect | undefined,
  nonce: string,
  now: number,
): Result.Result<PendingConnect, ConnectStateRefused> {
  if (held === undefined) return Result.fail(new ConnectStateRefused({ reason: "none" }));
  if (!sameSecret(held.nonce, nonce))
    return Result.fail(new ConnectStateRefused({ reason: "mismatch" }));
  if (now >= held.expiresAt) return Result.fail(new ConnectStateRefused({ reason: "expired" }));
  return Result.succeed(held);
}

/** The state Cloudflare carries back: the project, so the callback finds its object, and the nonce. */
export const connectState = (projectId: ProjectId, nonce: string): string =>
  `${projectId}.${nonce}`;

const decodeProjectId = Schema.decodeUnknownOption(ProjectId);
const NONCE = /^[A-Za-z0-9_-]{43}$/;

/** A state's project and nonce, or none for anything `connectState` did not write, a query's absent value among them. */
export function readConnectState(
  state: unknown,
): Option.Option<{ readonly projectId: ProjectId; readonly nonce: string }> {
  if (typeof state !== "string") return Option.none();
  const dot = state.indexOf(".");
  if (dot < 0) return Option.none();
  const nonce = state.slice(dot + 1);
  if (!NONCE.test(nonce)) return Option.none();
  return Option.map(decodeProjectId(state.slice(0, dot)), (projectId) => ({ projectId, nonce }));
}

/** An account a consent granted, as Cloudflare names it. */
export interface GrantedAccount {
  readonly id: string;
  readonly name: string;
}

/** A consent that granted no account, or more than one: the owner ticks exactly one. */
export class ConnectAccountsRefused extends Schema.TaggedError<ConnectAccountsRefused>()(
  "ConnectAccountsRefused",
  { granted: Schema.Number },
) {}

/** The one account a consent granted; none, or several, is refused, since a target deploys to one. */
export function oneAccount(
  granted: readonly GrantedAccount[],
): Result.Result<GrantedAccount, ConnectAccountsRefused> {
  const [only, ...more] = granted;
  return only !== undefined && more.length === 0
    ? Result.succeed(only)
    : Result.fail(new ConnectAccountsRefused({ granted: granted.length }));
}

/** The most characters of a credential's label, which is the minted token's name. */
const LABEL_MOST = 64;

/**
 * What the token Keel mints is called, in the owner's Cloudflare dashboard and
 * in the namespace's credentials: the project it deploys, cut to the length a
 * label holds, with no space at its end.
 */
export const deployTokenName = (handle: string, project: string): string =>
  `Keel deploys: ${handle}/${project}`.slice(0, LABEL_MOST).trimEnd();

/**
 * Cloudflare's side of a Connect, failed: this Keel has no OAuth client
 * registered, or Cloudflare refused a step (the code's exchange, the read of
 * the granted accounts, or the token's minting), with its status and its own
 * error code where it gave them. Never a token, a code or a verifier.
 */
export class CloudflareConnectFailed extends Schema.TaggedError<CloudflareConnectFailed>()(
  "CloudflareConnectFailed",
  {
    step: Schema.Literals(["unconfigured", "exchange", "accounts", "mint"]),
    status: Schema.optional(Schema.Number),
    code: Schema.optional(Schema.Number),
  },
) {}
