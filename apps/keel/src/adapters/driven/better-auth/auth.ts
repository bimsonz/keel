import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { createAccessControl } from "better-auth/plugins/access";
import { admin } from "better-auth/plugins/admin";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { emailOTP } from "better-auth/plugins/email-otp";
import { organization } from "better-auth/plugins/organization";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { username } from "better-auth/plugins/username";
import { monotonicFactory } from "ulid";
import { nameRefusal } from "./names.ts";

/** Where Better Auth answers, under Keel's API and outside its TypeSpec document. */
export const AUTH_BASE_PATH = "/v1/auth";

/** The cookies' prefix: the session is `__Secure-keel.session_token`. */
export const COOKIE_PREFIX = "keel";

/** The CLI's client id in the device grant (RFC 8628); no other client may start one. */
export const DEVICE_CLIENT_ID = "keeltown";

/**
 * A passkey-first user has no email yet, so Better Auth gets one under a domain
 * that can never receive mail (RFC 6761). The sender refuses it, and no surface
 * shows it as an email.
 */
export const PLACEHOLDER_EMAIL_DOMAIN = "users.keel.invalid";

/**
 * Better Auth's routes Keel does not serve. A session list answers every
 * session's token and revoking one takes it, so the console offers only "sign
 * out everywhere else". The instance admin never acts as another user.
 */
export const DISABLED_PATHS = [
  "/list-sessions",
  "/revoke-session",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/set-user-password",
  "/admin/list-user-sessions",
  "/admin/revoke-user-session",
] as const;

/**
 * What a user without a handle may do: set it, sign out, or sign in again. The
 * handle names the personal org, so nothing else waits on it.
 */
const BEFORE_HANDLE = new Set([
  "/get-session",
  "/sign-out",
  "/update-user",
  "/is-username-available",
  "/ok",
  "/error",
]);
const SIGN_IN =
  /^\/(sign-in|email-otp|passkey\/(generate-authenticate-options|verify-authentication))(\/|$)/;

/** Delivers a one-time code. Keel offers email codes only once it can send them. */
export type OtpSender = (message: {
  readonly to: string;
  readonly otp: string;
  readonly type: string;
}) => Promise<void>;

export interface AuthConfig {
  readonly db: D1Database;
  readonly secret: string;
  /** keel.town's host: the one origin, the passkeys' relying party and the cookies' site. */
  readonly host: string;
  /** Email codes, only when Keel can send mail. */
  readonly sendOtp?: OtpSender;
  /** GitHub sign-in, only once its OAuth app exists. */
  readonly github?: { readonly clientId: string; readonly clientSecret: string };
  /**
   * Keeps the Worker alive for work Better Auth does after answering, such as
   * sending a code (it answers alike whether or not the address exists).
   */
  readonly background?: (task: Promise<unknown>) => void;
}

/**
 * The org roles. Owners hold the org itself (its members, invitations and
 * deletion); maintainers and members hold nothing of Better Auth's, since
 * what they may do in Keel is decided by Keel's policy.
 */
export const orgAccess = createAccessControl(defaultStatements);
export const ORG_ROLES = {
  owner: orgAccess.newRole({
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
  }),
  maintainer: orgAccess.newRole({}),
  member: orgAccess.newRole({}),
};

const ulid = monotonicFactory();

/** Users and orgs carry Keel's prefixed ULIDs; Better Auth's other rows plain ones. */
function generateId({ model }: { model: string }): string {
  if (model === "user") return `usr_${ulid()}`;
  if (model === "organization") return `org_${ulid()}`;
  return ulid();
}

const refuse = (code: string, message: string) => APIError.from("BAD_REQUEST", { code, message });

/** Refuses a name already used as a handle or an org slug: the two share one namespace. */
async function claimable(db: D1Database, name: string, creator?: string): Promise<void> {
  const refusal = nameRefusal(name);
  if (refusal !== undefined) throw refuse("NAME_REFUSED", refusal);
  const lowered = name.toLowerCase();
  const holder = await db
    .prepare(
      `SELECT id AS holder FROM user WHERE username = ?1 UNION ALL SELECT 'org' FROM organization WHERE slug = ?1 LIMIT 1`,
    )
    .bind(lowered)
    .first<{ holder: string }>();
  if (holder !== null && holder.holder !== creator)
    throw refuse("NAME_TAKEN", `"${lowered}" is already a handle or an org's name`);
}

export function authOptions(config: AuthConfig) {
  const origin = `https://${config.host}`;
  const { db } = config;

  /** Every user's personal org, made when its handle is first set, owned by it. */
  const personalOrg = async (user: { id: string; username?: string | null }) => {
    if (user.username === undefined || user.username === null) return;
    const exists = await db
      .prepare(`SELECT 1 AS one FROM organization WHERE slug = ?1`)
      .bind(user.username)
      .first();
    if (exists !== null) return;
    await auth.api.createOrganization({
      body: { name: user.username, slug: user.username, userId: user.id },
    });
  };

  const options = {
    appName: "Keel",
    database: db,
    secret: config.secret,
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [origin],
    disabledPaths: [...DISABLED_PATHS],
    telemetry: { enabled: false },
    // Keel limits each IP at its mount with the Workers Rate Limiting binding.
    rateLimit: { enabled: false },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: true,
      // Better Auth turns both off under a test runner; set them so tests and production agree.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // [ba.schema] holds the migrations equal to these options in CI. Checked at
      // runtime too, it would cost a D1 query on every request, each making its own instance.
      database: { generateId, validateSchema: false },
      ...(config.background === undefined
        ? {}
        : { backgroundTasks: { handler: config.background } }),
    },
    ...(config.github === undefined
      ? {}
      : {
          socialProviders: {
            github: {
              clientId: config.github.clientId,
              clientSecret: config.github.clientSecret,
            },
          },
        }),
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (BEFORE_HANDLE.has(ctx.path) || SIGN_IN.test(ctx.path)) {
          const name: unknown = ctx.body?.username;
          if (ctx.path === "/update-user" && typeof name === "string") {
            const session = await getSessionFromCtx(ctx);
            await claimable(db, name, session?.user.id);
          } else if (ctx.path === "/update-user") {
            const session = await getSessionFromCtx(ctx);
            if (session !== null && !session.user["username"])
              throw refuse("HANDLE_REQUIRED", "Choose a handle first");
          }
          return;
        }
        const session = await getSessionFromCtx(ctx);
        if (session !== null && !session.user["username"])
          throw APIError.from("FORBIDDEN", {
            code: "HANDLE_REQUIRED",
            message: "Choose a handle first: it names your personal org",
          });
      }),
    },
    databaseHooks: {
      user: {
        create: { after: personalOrg },
        update: { after: personalOrg },
      },
    },
    plugins: [
      username({
        minUsernameLength: 1,
        maxUsernameLength: 39,
        usernameValidator: (name) => nameRefusal(name) === undefined,
        // The handle is the personal org's slug, so it never changes.
        immutableUsername: true,
      }),
      organization({
        ac: orgAccess,
        roles: ORG_ROLES,
        creatorRole: "owner",
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org, user }) => {
            if (typeof org.slug !== "string") throw refuse("NAME_REFUSED", "An org needs a name");
            await claimable(db, org.slug, user.id);
            return { data: { ...org, slug: org.slug.toLowerCase() } };
          },
          beforeUpdateOrganization: async ({ organization: org }) => {
            if (org.slug !== undefined)
              throw refuse("NAME_IMMUTABLE", "An org's name is its address and never changes");
          },
          beforeDeleteOrganization: async ({ organization: org, user }) => {
            if (org.slug === user["username"])
              throw refuse("PERSONAL_ORG", "Your personal org goes only with your account");
          },
        },
      }),
      admin(),
      deviceAuthorization({
        verificationUri: `${origin}/device`,
        validateClient: (clientId) => clientId === DEVICE_CLIENT_ID,
      }),
      bearer(),
      passkey({
        rpID: config.host,
        rpName: "Keel",
        origin,
        registration: {
          // Passkey-first sign-up: the chosen handle names a user made only once the passkey verifies.
          requireSession: false,
          resolveUser: async ({ context }) => {
            if (typeof context !== "string" || context === "")
              throw refuse("HANDLE_REQUIRED", "Choose a handle to sign up with a passkey");
            await claimable(db, context);
            return { id: `usr_${ulid()}`, name: context.toLowerCase() };
          },
          afterVerification: async ({ ctx, user, context }) => {
            if ((await ctx.context.internalAdapter.findUserById(user.id)) !== null) return {};
            if (typeof context !== "string") throw refuse("HANDLE_REQUIRED", "Choose a handle");
            await claimable(db, context);
            const handle = context.toLowerCase();
            const created = await ctx.context.internalAdapter.createUser(
              {
                email: `${handle}@${PLACEHOLDER_EMAIL_DOMAIN}`,
                emailVerified: false,
                name: handle,
                username: handle,
                displayUsername: handle,
              },
              { method: "passkey" },
            );
            return { userId: created.id };
          },
        },
      }),
      ...(config.sendOtp === undefined
        ? []
        : [emailOTP({ sendVerificationOTP: refusingInvalid(config.sendOtp) })]),
    ],
  } satisfies Parameters<typeof betterAuth>[0];

  const auth = betterAuth(options);
  return { options, auth };
}

/** Never sends to an address that can't receive mail, the passkey-first placeholder among them. */
export function refusingInvalid(send: OtpSender) {
  return async ({ email, otp, type }: { email: string; otp: string; type: string }) => {
    if (/\.invalid$/i.test(email.trim()))
      throw refuse("EMAIL_UNDELIVERABLE", "That address can't receive mail");
    await send({ to: email, otp, type });
  };
}

export type KeelAuth = ReturnType<typeof authOptions>["auth"];

export function makeAuth(config: AuthConfig): KeelAuth {
  return authOptions(config).auth;
}
