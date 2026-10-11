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

/** Who to invite: a user of this Keel by their handle, or someone by an address the reader types. */
export type Invitee = { handle: string } | { email: string };

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

/** As `taken`, but null where the thing asked for is not there for this reader: a private one and none look the same. */
function takenIfTheirs<Data>(result: { data: Data | null; error: Failure | null }): Data | null {
  if (result.error !== null && NOT_THEIRS.has(result.error.code ?? "")) return null;
  return taken(result);
}

export type Account = ReturnType<typeof createAccount>;

export function createAccount(options: AccountOptions) {
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

    /** Whether a handle is free for a new org. Keel refuses the reserved words and every handle in use. */
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

    /** An invitation made to the reader that is still open, or null: one made to someone else looks like none. */
    async invitation(id: string): Promise<Invited | null> {
      const asked = await client.organization.getInvitation({ query: { id } });
      // Keel refuses one that is answered, lapsed, someone else's or not there, and a page tells none of them apart.
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
