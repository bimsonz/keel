// Who is signed in, and signing in and out. This is the one module that speaks to Keel's identity routes
// (/v1/auth, served by Better Auth), on the page's own origin: the browser holds the session as an HttpOnly
// cookie and this code never sees it. Better Auth's answers also carry the session's token in their body, so
// nothing here hands an answer on as it came: each call gives back the few plain facts a page needs.

import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import {
  deviceAuthorizationClient,
  emailOTPClient,
  organizationClient,
  usernameClient,
} from "better-auth/client/plugins";
import { type Role, ac, roleOf, roles } from "./roles.ts";

/** The user who is signed in. */
export interface Who {
  id: string;
  /** The user's address, where they have one. Someone who signed up with a passkey alone has none. */
  email?: string;
  name: string;
  /** The user's name on this Keel, once chosen: where their own projects live. */
  handle?: string;
}

/** A passkey the user has, by the name they gave it. */
export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  /** When it last signed them in. Absent where it has not since Keel began recording it: that is not "never". */
  lastUsedAt?: string;
}

/** How Keel says a session was signed in. `other` is a session whose row names no way. */
export type SignedInBy = "passkey" | "email-otp" | "github" | "device" | "other";

const SIGNED_IN_BY: ReadonlySet<string> = new Set<SignedInBy>([
  "passkey",
  "email-otp",
  "github",
  "device",
]);

/** One of the user's own sessions, as Keel lists it: named by the id of its row, which signs nothing in. */
export interface OwnSession {
  id: string;
  /** The session this page is asking with. */
  current: boolean;
  signedInBy: SignedInBy;
  /** What the browser called itself when it signed in. Null where it sent nothing. */
  userAgent: string | null;
  createdAt: string;
  /** Its last use, to within the hour: Keel writes a session's row once an hour while it is used. */
  lastUsedAt: string;
}

interface SessionAnswer {
  id: string;
  current?: boolean;
  signedInBy?: string;
  userAgent?: string | null;
  createdAt: string;
  lastUsedAt: string;
}

/** A session as Keel answered it, and no field more: a way of signing in this page does not know is `other`. */
function sessionOf(answer: SessionAnswer): OwnSession {
  const by = answer.signedInBy ?? "";
  return {
    id: answer.id,
    current: answer.current === true,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- it is one of the four, by the set
    signedInBy: SIGNED_IN_BY.has(by) ? (by as SignedInBy) : "other",
    userAgent:
      typeof answer.userAgent === "string" && answer.userAgent !== "" ? answer.userAgent : null,
    createdAt: new Date(answer.createdAt).toISOString(),
    lastUsedAt: new Date(answer.lastUsedAt).toISOString(),
  };
}

/** An org, by its name and by its handle: the first segment of its projects' addresses. */
export interface Org {
  id: string;
  name: string;
  handle: string;
}

/** A member of an org, as a code host shows one: by handle and name, and never by an address. */
export interface Member {
  id: string;
  role: Role;
  name: string;
  handle?: string;
  /** True for the reader's own membership. */
  you: boolean;
}

/** An invitation that nobody has answered yet. `to` is the handle it was made to, or the address a member typed. */
export interface Invitation {
  id: string;
  role: Role;
  to: string;
  expiresAt: string;
}

/** An org as one of its members reads it. */
export interface OrgPage {
  org: Org;
  /** The reader's own role in it. */
  role: Role;
  members: Member[];
  invitations: Invitation[];
}

/** An invitation as the person it was made to reads it. */
export interface Invited {
  id: string;
  org: { name: string; handle: string };
  role: Role;
  /** The handle of whoever made it, where Keel names them by one. */
  by?: string;
}

/** The ways in that this Keel offers besides a passkey, which it always does. */
export interface Methods {
  emailCode: boolean;
  github: boolean;
}

/** Who to invite: a user of this Keel by their handle, or someone by an address the reader types. */
/** An invitation its reader can no longer answer, and what Keel said of it, in Keel's own words. */
export interface Closed {
  closed: "answered" | "lapsed";
  said: string;
}

export type Invitee = { handle: string } | { email: string };

/** Keel serves no identity here: it answers 404 where its sign-in routes would be. */
export class NotOpen extends Error {
  constructor() {
    super("Signing in is not open on this Keel yet");
    this.name = "NotOpen";
  }
}

/**
 * Keel refused, and said why. `code` is Keel's, or Better Auth's own. `next` is the ways forward Keel gave with
 * the refusal, each by its title; most refusals come with none.
 */
export class Refused extends Error {
  readonly code: string;
  readonly next: readonly string[];
  constructor(code: string, message: string, next: readonly string[] = []) {
    super(message);
    this.name = "Refused";
    this.code = code;
    this.next = next;
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
  /** Keel's NextActions, where it gave any with the refusal. */
  nextActions?: unknown;
}

const UNSAID = "Keel refused, and did not say why";

/** The titles of the ways forward Keel gave, in Keel's order. */
function nextOf(given: unknown): string[] {
  if (!Array.isArray(given)) return [];
  return given.flatMap((action: unknown) =>
    typeof action === "object" &&
    action !== null &&
    "title" in action &&
    typeof action.title === "string"
      ? [action.title]
      : [],
  );
}

function refusal(error: Failure): Error {
  // A route that is not served answers 404 and names no code. A 404 with a code is Keel saying what is not
  // there, a session that is not the asker's among them, and is a refusal like any other.
  if (error.status === 404 && (error.code ?? "") === "") return new NotOpen();
  return new Refused(error.code ?? "", error.message ?? UNSAID, nextOf(error.nextActions));
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
  // Keel gives a user with no address one that can never receive mail (RFC 6761). It is not an address to show.
  const placeholder = user.email.toLowerCase().endsWith(".invalid");
  return {
    id: user.id,
    ...(placeholder ? {} : { email: user.email }),
    name: user.name,
    ...(typeof user.username === "string" && user.username !== "" ? { handle: user.username } : {}),
  };
}

interface OrgAnswer {
  id: string;
  name: string;
  slug: string;
}

function orgOf(answer: OrgAnswer): Org {
  return { id: answer.id, name: answer.name, handle: answer.slug };
}

interface MemberAnswer {
  id: string;
  userId: string;
  role: string;
  user: { name: string; username?: string | null | undefined };
}

/** A member, without their address: Keel's answer carries every member's, and a page is given none of them. */
function memberOf(answer: MemberAnswer, reader: Who): Member {
  const handle = answer.user.username;
  return {
    id: answer.id,
    role: roleOf(answer.role),
    name: answer.user.name,
    ...(typeof handle === "string" && handle !== "" ? { handle } : {}),
    you: answer.userId === reader.id,
  };
}

interface InvitationAnswer {
  id: string;
  role: string;
  /** Absent where the invitation was made by handle and Keel keeps the address to itself. */
  email?: string | undefined;
  status: string;
  expiresAt: string | Date;
  handle?: string | null | undefined;
}

/** An invitation made by handle is told by the handle. The address Keel resolved it to is not the reader's to see. */
function invitationOf(answer: InvitationAnswer): Invitation {
  const byHandle = typeof answer.handle === "string" && answer.handle !== "";
  return {
    id: answer.id,
    role: roleOf(answer.role),
    to: byHandle ? (answer.handle ?? "") : (answer.email ?? ""),
    expiresAt: new Date(answer.expiresAt).toISOString(),
  };
}

/** Better Auth's answers where there is no such org, or it is not the reader's to see. */
const NOT_THEIRS = new Set(["ORGANIZATION_NOT_FOUND", "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION"]);

/** Keel's two refusals that tell an invitation's own reader what became of it. */
const CLOSED: ReadonlyMap<string, Closed["closed"]> = new Map([
  ["INVITATION_ANSWERED", "answered"],
  ["INVITATION_LAPSED", "lapsed"],
]);

/** As `taken`, but null where the thing asked for is not there for this reader: a private one and none look the same. */
function takenIfTheirs<Data>(result: { data: Data | null; error: Failure | null }): Data | null {
  if (result.error !== null && NOT_THEIRS.has(result.error.code ?? "")) return null;
  return taken(result);
}

/** What a signed-in user is called on a page: their handle, or before they have one their address or name. */
export function nameOf(who: Who): string {
  return who.handle ?? who.email ?? who.name;
}

export type Account = ReturnType<typeof createAccount>;

export function createAccount(options: AccountOptions) {
  const send: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const client = createAuthClient({
    baseURL: options.origin,
    basePath: "/v1/auth",
    plugins: [
      emailOTPClient(),
      usernameClient(),
      passkeyClient(),
      deviceAuthorizationClient(),
      organizationClient({ ac, roles }),
    ],
    fetchOptions: { customFetchImpl: send },
  });

  return {
    /** Who is signed in, or null for a visitor. */
    async who(): Promise<Who | null> {
      const answer = taken(await client.getSession());
      return answer === null ? null : whoOf(answer.user);
    },

    /**
     * Which ways in Keel offers besides a passkey. A Keel that does not say offers a passkey alone: a page shows
     * no way in that Keel would refuse.
     */
    async methods(): Promise<Methods> {
      const answer = await client.$fetch<Partial<Methods>>("/methods", { method: "GET" });
      if (answer.error?.status === 404) return { emailCode: false, github: false };
      const offered = taken(answer);
      return { emailCode: offered.emailCode === true, github: offered.github === true };
    },

    /**
     * Signs a new person up with a passkey made on this device, and in. The handle is theirs from the start: Keel
     * makes the user only once the passkey verifies. Everyone signs up this way, whoever set the Keel up included.
     */
    async signUpWithPasskey(handle: string): Promise<Who> {
      const answer = await client.passkey.addPasskey({
        name: handle,
        context: handle,
        createSession: true,
      });
      if (answer.error !== null) throw refusal(answer.error);
      const who = await this.who();
      if (who === null) throw new Refused("", "The passkey was made and no session came back");
      return who;
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

    /** Whether a handle is free. It names the user's own namespace, so it is unique on this Keel. */
    async handleIsFree(handle: string): Promise<boolean> {
      return taken(await client.isUsernameAvailable({ username: handle })).available;
    },

    async chooseHandle(handle: string): Promise<void> {
      taken(await client.updateUser({ username: handle }));
    },

    async passkeys(): Promise<Passkey[]> {
      return taken(await client.passkey.listUserPasskeys()).map((passkey) => {
        // Keel adds when each last signed its person in. The library's own answer has no such field.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Keel's added field
        const used = (passkey as { lastUsedAt?: string | Date | null }).lastUsedAt;
        return {
          id: passkey.id,
          name: passkey.name ?? "",
          createdAt: new Date(passkey.createdAt).toISOString(),
          ...(used === undefined || used === null
            ? {}
            : { lastUsedAt: new Date(used).toISOString() }),
        };
      });
    },

    /**
     * Gives one of the user's own passkeys another name, without the spaces typed round it. Keel asks for no
     * fresh sign-in: it changes no way in.
     */
    async renamePasskey(id: string, name: string): Promise<void> {
      taken(await client.passkey.updatePasskey({ id, name: name.trim() }));
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

    /** The user's own sessions, as Keel orders them: the one used last first. No answer of it carries a token. */
    async sessions(): Promise<OwnSession[]> {
      const answer = await client.$fetch<{ sessions?: SessionAnswer[] }>("/sessions", {
        method: "GET",
      });
      return (taken(answer).sessions ?? []).map(sessionOf);
    },

    /** Ends one of the user's own sessions, by the id Keel listed it under. Whoever was using it signs in again. */
    async endSession(id: string): Promise<void> {
      taken(await client.$fetch("/sessions/revoke", { method: "POST", body: { id } }));
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

    // Orgs. Every call names the org it is about, as the address does: Better Auth also keeps an "active
    // organisation" for a session, and nothing here reads it or sets it.

    /** The orgs the reader is a member of. */
    async orgs(): Promise<Org[]> {
      return taken(await client.organization.list()).map(orgOf);
    },

    /** An org as its member reads it, or null where there is none of that handle for this reader. */
    async org(handle: string, reader: Who): Promise<OrgPage | null> {
      const answer = takenIfTheirs(
        await client.organization.getFullOrganization({ query: { organizationSlug: handle } }),
      );
      if (answer === null) return null;
      const members = answer.members.map((member) => memberOf(member, reader));
      return {
        org: orgOf(answer),
        role: members.find((member) => member.you)?.role ?? "member",
        members,
        invitations: answer.invitations
          .filter((invitation) => invitation.status === "pending")
          .map(invitationOf),
      };
    },

    /**
     * Whether no org has a handle. A handle a person or an agent has, and a first segment Keel serves itself,
     * read as free here: Keel refuses those when the org is made, in its own sentence.
     */
    async orgHandleIsFree(handle: string): Promise<boolean> {
      const answer = await client.organization.checkSlug({ slug: handle });
      if (answer.error?.code === "ORGANIZATION_SLUG_ALREADY_TAKEN") return false;
      return taken(answer).status;
    },

    /** Makes an org, with the reader as its owner. */
    async createOrg(name: string, handle: string): Promise<Org> {
      return orgOf(
        taken(
          await client.organization.create({
            name,
            slug: handle,
            keepCurrentActiveOrganization: true,
          }),
        ),
      );
    },

    async renameOrg(org: Org, name: string): Promise<void> {
      taken(await client.organization.update({ organizationId: org.id, data: { name } }));
    },

    async deleteOrg(org: Org): Promise<void> {
      taken(await client.organization.delete({ organizationId: org.id }));
    },

    /** Invites someone to an org with a role, and gives back the invitation: its address is `/invite/<id>`. */
    async invite(org: Org, invitee: Invitee, role: Role): Promise<Invitation> {
      return invitationOf(
        taken(
          await client.$fetch<InvitationAnswer>("/organization/invite-member", {
            method: "POST",
            body: { ...invitee, role, organizationId: org.id },
          }),
        ),
      );
    },

    async cancelInvitation(id: string): Promise<void> {
      taken(await client.organization.cancelInvitation({ invitationId: id }));
    },

    async setRole(org: Org, member: Member, role: Role): Promise<void> {
      taken(
        await client.organization.updateMemberRole({
          organizationId: org.id,
          memberId: member.id,
          role,
        }),
      );
    },

    async removeMember(org: Org, member: Member): Promise<void> {
      taken(
        await client.organization.removeMember({
          organizationId: org.id,
          memberIdOrEmail: member.id,
        }),
      );
    },

    /** The reader's own way out of an org. */
    async leave(org: Org): Promise<void> {
      taken(await client.organization.leave({ organizationId: org.id }));
    },

    /**
     * An invitation made to the reader: one still open, or one that is closed with what Keel said of it. Null
     * where there is none for this reader: one made to someone else looks like none.
     */
    async invitation(id: string): Promise<Invited | Closed | null> {
      const asked = await client.organization.getInvitation({ query: { id } });
      // Keel tells the person an invitation was made to that it was answered or has lapsed, and nobody else.
      const closed = CLOSED.get(asked.error?.code ?? "");
      if (closed !== undefined) return { closed, said: asked.error?.message ?? UNSAID };
      // One that is someone else's and one that is not there Keel refuses alike, and a page tells neither apart.
      if (asked.error?.status === 400 || asked.error?.status === 403) return null;
      const answer: typeof asked.data & { inviterHandle?: string } = taken(asked);
      if (answer.status !== "pending") return null;
      return {
        id: answer.id,
        org: { name: answer.organizationName, handle: answer.organizationSlug },
        role: roleOf(answer.role),
        // Keel's own answer names the inviter by an address as well. That is not handed on.
        ...(typeof answer.inviterHandle === "string" ? { by: answer.inviterHandle } : {}),
      };
    },

    async acceptInvitation(id: string): Promise<void> {
      taken(await client.organization.acceptInvitation({ invitationId: id }));
    },

    async declineInvitation(id: string): Promise<void> {
      taken(await client.organization.rejectInvitation({ invitationId: id }));
    },
  };
}
