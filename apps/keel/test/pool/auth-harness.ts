/**
 * The pool's browser: Better Auth's routes on keel.localhost, each call from
 * its own address so the per-IP limit binds only where a test means it to.
 */
import {
  Authenticator as Passkey,
  caller as callerAt,
  type Fetcher,
} from "@keeltown/testing/passkey";
import { BASE } from "./helpers.ts";

export { type Answer, type Fetcher, Jar, SESSION_COOKIE } from "@keeltown/testing/passkey";

export const caller = (fetcher: Fetcher) =>
  callerAt(fetcher, BASE, () => `2001:db8::${crypto.randomUUID().slice(0, 4)}`);

/** A platform authenticator for keel.localhost, one credential per instance. */
export class Authenticator extends Passkey {
  constructor() {
    super(BASE);
  }
}
