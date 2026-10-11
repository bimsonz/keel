// Who is signed in, and signing in and out. This is the one module that speaks to Keel's identity routes
// (/v1/auth, served by Better Auth), on the page's own origin: the browser holds the session as an HttpOnly
// cookie and this code never sees it. Better Auth's answers also carry the session's token in their body, so
// nothing here hands an answer on as it came: each call gives back the few plain facts a page needs.

import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import {
  deviceAuthorizationClient,
  emailOTPClient,
  usernameClient,
} from "better-auth/client/plugins";

/** The user who is signed in. */
export interface Who {
  id: string;
  email: string;
  name: string;
  /** The name of the user's own org, once chosen. */
  handle?: string;
}

/** A passkey the user has, by the name they gave it. */
export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
}

/** Keel serves no identity here: it answers 404 where its sign-in routes would be. */
export class NotOpen extends Error {
  constructor() {
    super("Signing in is not open on this Keel yet");
    this.name = "NotOpen";
  }
}

/** Keel refused, and said why. `code` is Better Auth's own. */
export class Refused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "Refused";
    this.code = code;
  }
}

export interface AccountOptions {
  /** The page's own origin: Keel is served on it, under /v1. */
  origin: string;
  /** In tests, what stands in for the browser's fetch. */
  fetch?: typeof fetch;
}

interface Failure {
  status?: number;
  code?: string | undefined;
  message?: string | undefined;
}

function refusal(error: Failure): Error {
  if (error.status === 404) return new NotOpen();
  return new Refused(error.code ?? "", error.message ?? "Keel refused, and did not say why");
}

/** A result of Better Auth's client, opened: its data, or the refusal thrown. */
function taken<Data>(result: { data: Data | null; error: Failure | null }): Data {
  if (result.error !== null) throw refusal(result.error);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- with no error there is data, null where the answer is null
  return result.data as Data;
}

function whoOf(user: {
  id: string;
  email: string;
  name: string;
  username?: string | null | undefined;
}): Who {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    ...(typeof user.username === "string" && user.username !== "" ? { handle: user.username } : {}),
  };
}

export type Account = ReturnType<typeof createAccount>;

export function createAccount(options: AccountOptions) {
  const client = createAuthClient({
    baseURL: options.origin,
    basePath: "/v1/auth",
    plugins: [emailOTPClient(), usernameClient(), passkeyClient(), deviceAuthorizationClient()],
    ...(options.fetch === undefined ? {} : { fetchOptions: { customFetchImpl: options.fetch } }),
  });

  return {
    /** Who is signed in, or null for a visitor. */
    async who(): Promise<Who | null> {
      const answer = taken(await client.getSession());
      return answer === null ? null : whoOf(answer.user);
    },

    /** Sends a code to an address. A new address is signed up by the same code. */
    async sendCode(email: string): Promise<void> {
      taken(await client.emailOtp.sendVerificationOtp({ email, type: "sign-in" }));
    },

    async signInWithCode(email: string, code: string): Promise<Who> {
      return whoOf(taken(await client.signIn.emailOtp({ email, otp: code })).user);
    },

    /** Leaves for GitHub, which sends the browser back to `returnTo` signed in. */
    async signInWithGitHub(returnTo: string): Promise<void> {
      taken(await client.signIn.social({ provider: "github", callbackURL: returnTo }));
    },

    /** Asks the browser for one of the user's passkeys. */
    async signInWithPasskey(): Promise<Who> {
      const answer = await client.signIn.passkey();
      if (answer.error !== null) throw refusal(answer.error);
      const who = await this.who();
      if (who === null) throw new Refused("", "The passkey was accepted and no session came back");
      return who;
    },

    async signOut(): Promise<void> {
      taken(await client.signOut());
    },

    /** Whether a handle is free. It names the user's own org, so it is unique on this Keel. */
    async handleIsFree(handle: string): Promise<boolean> {
      return taken(await client.isUsernameAvailable({ username: handle })).available;
    },

    async chooseHandle(handle: string): Promise<void> {
      taken(await client.updateUser({ username: handle }));
    },

    async passkeys(): Promise<Passkey[]> {
      return taken(await client.passkey.listUserPasskeys()).map((passkey) => ({
        id: passkey.id,
        name: passkey.name ?? "",
        createdAt: new Date(passkey.createdAt).toISOString(),
      }));
    },

    /** Makes a passkey on this device and gives it to Keel. */
    async addPasskey(name: string): Promise<void> {
      const answer = await client.passkey.addPasskey({ name });
      if (answer.error !== null) throw refusal(answer.error);
    },

    async removePasskey(id: string): Promise<void> {
      taken(await client.passkey.deletePasskey({ id }));
    },

    /** Ends every session of this user but the one asking. */
    async signOutElsewhere(): Promise<void> {
      taken(await client.revokeOtherSessions());
    },

    /** Claims a code that `keeltown login` is showing, for whoever is signed in here. Nothing is approved yet. */
    async claimDevice(userCode: string): Promise<void> {
      taken(await client.device({ query: { user_code: userCode } }));
    },

    async approveDevice(userCode: string): Promise<void> {
      taken(await client.device.approve({ userCode }));
    },

    async denyDevice(userCode: string): Promise<void> {
      taken(await client.device.deny({ userCode }));
    },
  };
}
