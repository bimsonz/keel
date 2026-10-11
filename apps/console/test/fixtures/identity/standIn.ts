// A stand-in for the identity Keel mounts at /v1/auth, for tests. It is the real Better Auth, with the plugins
// Keel uses (spike 27), on its in-memory adapter: so what the console is tested against answers as Keel's will,
// and nothing here imitates a route by hand. Nothing in the built console imports this.

import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
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

/** A passkey-first user has no address, so Better Auth is given one that can never receive mail (RFC 6761). */
const PLACEHOLDER = "users.keel.invalid";

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
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/organization/invite-member") return undefined;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the body as it arrived, not yet checked
        const body = ctx.body as { handle?: unknown; email?: unknown };
        if (typeof body.handle !== "string" || body.email !== undefined) return undefined;
        const invited = await ctx.context.adapter.findOne<{ email: string }>({
          model: "user",
          where: [{ field: "username", value: body.handle }],
        });
        if (invited === null)
          throw new APIError("BAD_REQUEST", {
            code: "HANDLE_NOT_FOUND",
            message: "Nobody on this Keel has that handle",
          });
        return { context: { ...ctx, body: { ...body, email: invited.email } } };
      }),
      // Keel's member answers carry each member's handle, which is how a code host shows a person. Their
      // addresses are left in, as the library answers them: a page must be given none, whatever Keel strips.
      after: createAuthMiddleware(async (ctx) => {
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
  };
}
