// A stand-in for the identity Keel mounts at /v1/auth, for tests. It is the real Better Auth, with the plugins
// Keel uses (spike 27), on its in-memory adapter: so what the console is tested against answers as Keel's will,
// and nothing here imitates a route by hand. Nothing in the built console imports this.

import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import {
  admin,
  bearer,
  deviceAuthorization,
  emailOTP,
  organization,
  username,
} from "better-auth/plugins";
import { ac, roles } from "../../../src/account/roles.ts";

/** A code "sent" by email, read back by the test as its person would read their email. */
export interface Sent {
  email: string;
  otp: string;
  type: string;
}

export interface Identity {
  /** Answers a request to /v1/auth/…, as Keel does. */
  handle(request: Request): Promise<Response>;
  /** Every code sent, oldest first. */
  outbox: Sent[];
  /** Every request it was sent, as it arrived. */
  requests: Request[];
  /** Puts an invitation's last day behind it, as time would: nobody has answered it, and nobody can now. */
  lapse(invitationId: string): Promise<void>;
  /** Puts every session made so far more than ten minutes behind it, as time would: none of them is fresh now. */
  age(): Promise<void>;
}

/** The tables Better Auth keeps with these plugins: the ones spike 27 saw it create. The adapter copies the whole store, so it is a plain object. */
function tables(): Record<string, unknown[]> {
  return {
    user: [],
    session: [],
    account: [],
    verification: [],
    passkey: [],
    deviceCode: [],
    organization: [],
    member: [],
    invitation: [],
  };
}

export interface IdentityOptions {
  /**
   * Whether this Keel can send an email, and so offers a code by email. A Keel that cannot signs a new person up
   * by passkey alone, and says nothing of which ways in it offers: keel.town as it first served identity.
   */
  emailCodes?: boolean;
}

/**
 * How long after its passkey sign-in a session may change how its account signs in, and Better Auth's routes
 * that do: Keel's `fresh.ts` and `CHANGES_SIGN_IN` in its `auth.ts`. Written beside Keel's and not imported, so
 * when either changes there this is brought level with it.
 */
export const FRESH_FOR_MS = 600_000;
const CHANGES_SIGN_IN: ReadonlySet<string> = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/link-social",
  "/unlink-account",
  "/change-email",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
]);

/** How a session is signed in, by the endpoint that makes it: Keel's `signInMethod`. */
function signInMethod(path: string): string {
  switch (path) {
    case "/passkey/verify-authentication":
    case "/passkey/verify-registration":
      return "passkey";
    case "/sign-in/email-otp":
      return "email-otp";
    case "/callback/:id":
      return "github";
    case "/device/token":
      return "device";
    default:
      return "other";
  }
}

/**
 * Keel's refusal of a change to how an account signs in from a session that is not fresh: one not signed in by
 * a passkey, or signed in by one more than ten minutes ago. A request that carries no session is left alone:
 * for the passkey routes that is passkey-first sign-up.
 */
async function freshSignIn(ctx: Parameters<typeof getSessionFromCtx>[0]): Promise<void> {
  const carried = await getSessionFromCtx(ctx);
  if (carried === null) return;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the session's own added field
  const by = (carried.session as { signedInBy?: unknown }).signedInBy;
  const made = new Date(carried.session.createdAt).getTime();
  if (by === "passkey" && Date.now() - made <= FRESH_FOR_MS) return;
  throw new APIError("FORBIDDEN", {
    code: "FRESH_SIGN_IN_REQUIRED",
    message:
      "Sign in again with your passkey, then retry: changing how you sign in needs a passkey sign-in from the last ten minutes",
  });
}

/** A passkey-first user has no address, so Better Auth is given one that can never receive mail (RFC 6761). */
const PLACEHOLDER = "users.keel.invalid";

/** A refusal as Keel words one: a 400 with a code and a sentence a person can read. */
const refuse = (code: string, message: string): APIError =>
  new APIError("BAD_REQUEST", { code, message });

type Hooked = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

interface InvitationRow {
  email: string;
  status: string;
  expiresAt: Date | string | number;
  handle?: string | null;
}

/**
 * As Keel does it, in Keel's own words: an invitation names exactly one of a handle or an address, an address
 * that can receive no mail is refused, and a handle stands for its user.
 */
async function inviteTarget(ctx: Hooked) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the body as it arrived, not yet checked
  const body = ctx.body as { handle?: unknown; email?: unknown };
  const toHandle = typeof body.handle === "string" && body.handle !== "";
  const toEmail = typeof body.email === "string" && body.email !== "";
  if (toHandle === toEmail)
    throw refuse("INVITE_TARGET", "Invite by exactly one of a handle or an email address");
  if (toEmail) {
    if (/\.invalid$/i.test(String(body.email).trim()))
      throw refuse(
        "EMAIL_UNDELIVERABLE",
        "That address can't receive mail, so no one could accept",
      );
    return undefined;
  }
  const invited = await ctx.context.adapter.findOne<{ email: string; username: string }>({
    model: "user",
    where: [{ field: "username", value: String(body.handle).toLowerCase() }],
  });
  if (invited === null)
    throw refuse("NO_SUCH_HANDLE", `No one has the handle "${String(body.handle)}"`);
  return {
    context: { ...ctx, body: { ...body, handle: invited.username, email: invited.email } },
  };
}

/**
 * As Keel does it: an invitation is read and answered only by the person it was made to, who is told in words
 * that it was answered or has lapsed. To anyone else it is one that is not there, whatever has become of it.
 */
async function answerable(ctx: Hooked, id: unknown) {
  const session = await getSessionFromCtx(ctx);
  if (session === null || typeof id !== "string") return;
  const invitation = await ctx.context.adapter.findOne<InvitationRow>({
    model: "invitation",
    where: [{ field: "id", value: id }],
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the username plugin's field
  const user = session.user as typeof session.user & { username?: string | null };
  const theirs =
    invitation !== null &&
    (typeof invitation.handle === "string" && invitation.handle !== ""
      ? user.username === invitation.handle
      : user.emailVerified && invitation.email.toLowerCase() === user.email.toLowerCase());
  if (invitation === null || !theirs) throw refuse("INVITATION_NOT_FOUND", "No such invitation");
  if (invitation.status !== "pending")
    throw refuse("INVITATION_ANSWERED", `This invitation was already ${invitation.status}`);
  if (new Date(invitation.expiresAt) < new Date())
    throw refuse("INVITATION_LAPSED", "This invitation has lapsed; ask the org for a new one");
}

/** Better Auth's refusals when the last owner would leave, be removed, or step down. */
const LAST_OWNER: ReadonlySet<string> = new Set([
  "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
  "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
]);

/** As Keel does it: the last owner is refused in Keel's words, with the way forward Keel gives. */
function lastOwner(body: unknown): APIError {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the body as it arrived
  const org = (body as { organizationId?: unknown } | undefined)?.organizationId;
  return new APIError("BAD_REQUEST", {
    code: "ONLY_OWNER",
    message:
      "An org always has an owner: make another member an owner before you leave or step down",
    nextActions: [
      {
        kind: "call",
        title: "Make another member an owner first",
        operationId: "ManageOwners",
        ...(typeof org === "string" ? { args: { organizationId: org } } : {}),
      },
    ],
  });
}

export function createIdentity(origin: string, options: IdentityOptions = {}): Identity {
  const emailCodes = options.emailCodes ?? true;
  const outbox: Sent[] = [];
  const requests: Request[] = [];
  const auth = betterAuth({
    database: memoryAdapter(tables()),
    secret: "a secret for tests only, and long enough to be taken for one",
    baseURL: origin,
    basePath: "/v1/auth",
    trustedOrigins: [origin],
    // Better Auth leaves its origin check off when it finds itself under a test runner. Keel runs with it on.
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    // How each session was signed in, written as the session is made and by nothing a request sends.
    session: {
      additionalFields: { signedInBy: { type: "string", required: false, input: false } },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (CHANGES_SIGN_IN.has(ctx.path)) await freshSignIn(ctx);
        switch (ctx.path) {
          case "/organization/invite-member":
            return inviteTarget(ctx);
          case "/organization/get-invitation":
            return answerable(ctx, ctx.query?.["id"]);
          case "/organization/accept-invitation":
          case "/organization/reject-invitation":
            return answerable(ctx, ctx.body?.["invitationId"]);
          default:
            return undefined;
        }
      }),
      // Keel's member answers carry each member's handle, which is how a code host shows a person. Their
      // addresses are left in, as the library answers them: a page must be given none, whatever Keel strips.
      after: createAuthMiddleware(async (ctx) => {
        const returned: unknown = ctx.context.returned;
        if (ctx.path.startsWith("/organization/") && returned instanceof APIError) {
          const code: unknown = returned.body?.code;
          if (typeof code === "string" && LAST_OWNER.has(code)) throw lastOwner(ctx.body);
          return undefined;
        }
        if (ctx.path !== "/organization/get-full-organization") return undefined;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the plugin's own answer
        const answer = ctx.context.returned as {
          members?: { userId: string; user: { username?: string } }[];
        } | null;
        if (answer === null || answer.members === undefined) return undefined;
        for (const member of answer.members) {
          // oxlint-disable-next-line no-await-in-loop -- a handful, in a test
          const user = await ctx.context.adapter.findOne<{ username?: string }>({
            model: "user",
            where: [{ field: "id", value: member.userId }],
          });
          if (typeof user?.username === "string") member.user.username = user.username;
        }
        return ctx.json(answer);
      }),
    },
    databaseHooks: {
      user: {
        // Keel makes a user's own org when their handle is first set, and names it by the handle: when the user
        // is made, for one who signs up with a passkey, and when they choose it, for one who signed up by a code.
        create: { after: (user) => personalOrg(user) },
        update: { after: (user) => personalOrg(user) },
      },
      // The endpoint making a session says how it was signed in.
      session: {
        create: {
          // oxlint-disable-next-line typescript/require-await -- the library's own signature
          before: async (session, context) => ({
            data: { ...session, signedInBy: signInMethod(context?.path ?? "") },
          }),
        },
      },
    },
    plugins: [
      ...(emailCodes
        ? [
            emailOTP({
              // oxlint-disable-next-line typescript/require-await -- the plugin's own signature
              async sendVerificationOTP(sent) {
                outbox.push(sent);
              },
            }),
            // Which ways in this Keel offers besides a passkey, for a page to show those and no others.
            {
              id: "methods",
              endpoints: {
                methods: createAuthEndpoint("/methods", { method: "GET" }, (ctx) =>
                  ctx.json({ emailCode: true, github: false }),
                ),
              },
            },
          ]
        : []),
      passkey({
        rpID: new URL(origin).hostname,
        rpName: "Keel",
        origin,
        // Passkey-first sign-up, as Keel has it: the handle chosen names a user made only once the passkey verifies.
        registration: {
          requireSession: false,
          // oxlint-disable-next-line typescript/require-await -- the plugin's own signature
          resolveUser: async ({ context }) => {
            if (typeof context !== "string" || context === "")
              throw new APIError("BAD_REQUEST", {
                code: "HANDLE_REQUIRED",
                message: "Choose a handle to sign up with a passkey",
              });
            return { id: crypto.randomUUID(), name: context };
          },
          afterVerification: async ({ ctx, user, context }) => {
            if ((await ctx.context.internalAdapter.findUserById(user.id)) !== null) return {};
            if (typeof context !== "string")
              throw new APIError("BAD_REQUEST", {
                code: "HANDLE_REQUIRED",
                message: "Choose a handle",
              });
            const created = await ctx.context.internalAdapter.createUser(
              {
                email: `${context}@${PLACEHOLDER}`,
                emailVerified: false,
                name: context,
                username: context,
                displayUsername: context,
              },
              { method: "passkey" },
            );
            return { userId: created.id };
          },
        },
      }),
      deviceAuthorization({ verificationUri: `${origin}/device` }),
      bearer(),
      organization({
        ac,
        roles,
        // An invitation made by a handle says so, and Keel resolves it: nobody types another user's address.
        schema: {
          invitation: { additionalFields: { handle: { type: "string", required: false } } },
        },
      }),
      admin(),
      username(),
    ],
  });
  const personalOrg = async (user: { id: string }): Promise<void> => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the username plugin's field
    const handle = (user as { username?: string | null }).username;
    if (typeof handle !== "string" || handle === "") return;
    const context = await auth.$context;
    const held = await context.adapter.findOne({
      model: "organization",
      where: [{ field: "slug", value: handle }],
    });
    if (held !== null) return;
    await auth.api.createOrganization({ body: { name: handle, slug: handle, userId: user.id } });
  };
  return {
    outbox,
    requests,
    handle(request) {
      requests.push(request.clone());
      return auth.handler(request);
    },
    async lapse(invitationId) {
      const context = await auth.$context;
      await context.adapter.update({
        model: "invitation",
        where: [{ field: "id", value: invitationId }],
        update: { expiresAt: new Date("2000-01-01T00:00:00.000Z") },
      });
    },
    async age() {
      const context = await auth.$context;
      const made = new Date(Date.now() - FRESH_FOR_MS - 1_000);
      const sessions = await context.adapter.findMany<{ id: string }>({ model: "session" });
      for (const session of sessions) {
        // oxlint-disable-next-line no-await-in-loop -- a handful, in a test
        await context.adapter.update({
          model: "session",
          where: [{ field: "id", value: session.id }],
          update: { createdAt: made },
        });
      }
    },
  };
}
