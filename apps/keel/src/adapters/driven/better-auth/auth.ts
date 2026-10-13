import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { username } from "better-auth/plugins/username";
import { monotonicFactory } from "ulid";
import {
  type AgentAccess,
  agentTokens,
  CLOSED_PATHS,
  forgetSpentIds,
  TOKEN_PATH,
} from "./agents.ts";
import { isFresh, mayAddFirstPasskey, signInMethod } from "./fresh.ts";
import { nameRefusal } from "./names.ts";
import { orgAfter, orgBefore, type SessionOf } from "./org.ts";
import { ORG_ROLES, orgAccess } from "./roles.ts";

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
 * out everywhere else". Keel has no passwords: every route that takes, sets,
 * checks or resets one is off, the email code's among them (it would set a
 * password with no session, and a handle would then sign in with it), and so
 * is Better Auth's account deletion, which asks for one.
 */
export const DISABLED_PATHS = [
  "/list-sessions",
  "/revoke-session",
  "/sign-in/email",
  "/sign-up/email",
  "/sign-in/username",
  "/change-password",
  "/verify-password",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/:token",
  "/email-otp/request-password-reset",
  "/email-otp/reset-password",
  "/forget-password/email-otp",
  "/delete-user",
  "/delete-user/callback",
] as const;

/**
 * Better Auth matches `disabledPaths` against the path a request asks for, so
 * a route declared with a parameter (`/reset-password/:token`) is still served
 * by it. The before-hook refuses every disabled route by the path it is
 * declared with.
 */
const DISABLED: ReadonlySet<string> = new Set(DISABLED_PATHS);

/** How long a token-signing key signs before the next takes over, and how long its public half stays published after. */
const TOKEN_KEY_SECONDS = 60 * 60 * 24 * 30;

/**
 * What a user without a handle may do: set it, sign out, or sign in again. The
 * handle is the user's namespace, where its projects live, so everything else
 * waits on it.
 */
const BEFORE_HANDLE = new Set([
  "/get-session",
  "/sign-out",
  "/update-user",
  "/is-username-available",
  "/ok",
  "/error",
]);
const BEARER = /^bearer /i;
const SIGN_IN =
  /^\/(sign-in|email-otp|passkey\/(generate-authenticate-options|verify-authentication))(\/|$)/;

/**
 * Better Auth's routes that change how an account signs in, as it names them:
 * both steps of adding a passkey, removing one, linking or unlinking a
 * provider, and changing the address, by link or by code. Each needs a fresh
 * sign-in (fresh.ts).
 */
const CHANGES_SIGN_IN = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/link-social",
  "/unlink-account",
  "/change-email",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
]);

/** Both steps of adding a passkey: all of them an account with no passkey may take (fresh.ts). */
const ADDS_PASSKEY = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
]);

/** Whether the account holds a passkey. */
async function holdsPasskey(db: D1Database, userId: string): Promise<boolean> {
  const held = await db
    .prepare(`SELECT 1 AS one FROM passkey WHERE userId = ?1 LIMIT 1`)
    .bind(userId)
    .first();
  return held !== null;
}

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
  /** Keel's agents, as the token endpoint reads them. */
  readonly agents: AgentAccess;
  /**
   * Keeps the Worker alive for work Better Auth does after answering, such as
   * sending a code (it answers alike whether or not the address exists).
   */
  readonly background?: (task: Promise<unknown>) => void;
}

const ulid = monotonicFactory();

/** Users and orgs carry Keel's prefixed ULIDs; Better Auth's other rows plain ones. */
function generateId({ model }: { model: string }): string {
  if (model === "user") return `usr_${ulid()}`;
  if (model === "organization") return `org_${ulid()}`;
  return ulid();
}

const refuse = (code: string, message: string) => APIError.from("BAD_REQUEST", { code, message });

/** A sign-in provider's tokens, as every account row stores them: not at all. */
const NO_PROVIDER_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};

/** Why a name can't be had: refused outright (reserved or malformed), or already taken. */
export interface NameRefusal {
  readonly refused: "NAME_REFUSED" | "NAME_TAKEN";
  readonly message: string;
}

/** Who holds a handle: the one read `nameUnavailable` makes, of the table that holds every handle. */
export const HANDLE_HOLDER = `SELECT id AS holder FROM namespaces WHERE handle = ?1`;

const ONE_HOLDER = "a handle is one person's, one agent's or one org's";

/**
 * Why `name` can't be a person's handle or an org's, or undefined when it
 * can: the two, and an agent's, are one space, held unique by the
 * `namespaces` table. A held handle is taken whoever asks: a person's own is
 * no org's name, and is not chosen twice. This read is only the friendly
 * answer: the table's unique handle decides, in the statement that writes the
 * user or the org (`lostHandle`).
 */
async function nameUnavailable(db: D1Database, name: string): Promise<NameRefusal | undefined> {
  const lowered = name.toLowerCase();
  const held = await db.prepare(HANDLE_HOLDER).bind(lowered).first<{ holder: string }>();
  const refusal = nameRefusal(name);
  if (refusal !== undefined) return { refused: "NAME_REFUSED", message: refusal };
  if (held !== null)
    return { refused: "NAME_TAKEN", message: `"${lowered}" is taken: ${ONE_HOLDER}` };
  return undefined;
}

/** Refuses a name `nameUnavailable` refuses, with its code. */
async function claimable(db: D1Database, name: string): Promise<void> {
  const unavailable = await nameUnavailable(db, name);
  if (unavailable !== undefined) throw refuse(unavailable.refused, unavailable.message);
}

/**
 * Whether a handle went to another account between `nameUnavailable`'s read
 * and the write: a sign-up or a chosen handle that Better Auth's own later
 * read of usernames refused, or a user or an org that the database refused on
 * a unique handle (the `namespaces` table's, or the user's or the org's own
 * column, whichever the statement met first). Nothing was made, and the answer
 * is the one the read would have given.
 */
export const lostHandle = (error: unknown): boolean => {
  if (error instanceof APIError) return error.body?.code === "USERNAME_IS_ALREADY_TAKEN";
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: (namespaces\.handle|user\.username|organization\.slug)/.test(
      `${error.message} ${String(error.cause)}`,
    )
  );
};

/** The refusal a lost handle answers: the code the read before it would have given. */
const lostRace = () => refuse("NAME_TAKEN", `That handle was taken a moment ago: ${ONE_HOLDER}`);

export function authOptions(config: AuthConfig) {
  const origin = `https://${config.host}`;
  const { db } = config;

  /**
   * The session a request carries, by cookie or by bearer. Better Auth hands
   * every before-hook the request as it arrived: the bearer plugin's hook
   * answers the session cookie for the endpoint, and no other hook sees it.
   * So a bearer is read through the API, which applies that plugin. Reading
   * only the cookie would take a bearer for nobody, and every check below
   * would decide nothing for `keeltown login`'s sessions ([ba.bearer-hooks]).
   */
  const sessionOf: SessionOf = async (ctx) => {
    const byCookie = await getSessionFromCtx(ctx);
    if (byCookie !== null || !BEARER.test(ctx.headers?.get("authorization") ?? "")) return byCookie;
    return auth.api.getSession({ headers: ctx.headers ?? new Headers() });
  };

  const beforeOrg = orgBefore(db, sessionOf);
  const afterOrg = orgAfter(db, sessionOf);

  /**
   * Refuses a request to change how an account signs in unless its session is
   * fresh. One that carries none is left as it is: for the passkey routes that
   * is passkey-first sign-up. A request reaches Better Auth with one
   * credential (the mount takes the session cookie out from beside a bearer),
   * so the session read here is the one every handler acts for
   * ([ba.one-credential-fresh]). An account that holds no passkey adds its
   * first with its own sign-in from the last ten minutes, and is told which
   * way forward it has.
   */
  const freshSignIn = async (ctx: Parameters<SessionOf>[0]): Promise<void> => {
    const carried = await sessionOf(ctx);
    if (carried === null) return;
    const by: unknown = carried.session["signedInBy"];
    const signedIn = {
      signedInBy: typeof by === "string" ? by : null,
      createdAt: new Date(carried.session.createdAt),
    };
    const now = new Date();
    if (isFresh(signedIn, now)) return;
    const none = !(await holdsPasskey(db, carried.user.id));
    const first = none && ADDS_PASSKEY.has(ctx.path);
    if (first && mayAddFirstPasskey(signedIn, now)) return;
    throw APIError.from("FORBIDDEN", {
      code: "FRESH_SIGN_IN_REQUIRED",
      message: first
        ? "Sign in again, then retry: adding your first passkey needs a sign-in of your own from the last ten minutes"
        : none
          ? "Add a passkey first, then retry: changing how you sign in needs a passkey sign-in from the last ten minutes"
          : "Sign in again with your passkey, then retry: changing how you sign in needs a passkey sign-in from the last ten minutes",
    });
  };

  const options = {
    appName: "Keel",
    database: db,
    secret: config.secret,
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [origin],
    disabledPaths: [...DISABLED_PATHS, ...CLOSED_PATHS],
    telemetry: { enabled: false },
    // A handle lost to another account in the same moment is NAME_TAKEN, as the read before it answers.
    onAPIError: {
      onError: (error: unknown) => {
        if (lostHandle(error)) throw lostRace();
      },
    },
    // Keel limits each IP at its mount with the Workers Rate Limiting binding.
    rateLimit: { enabled: false },
    // How each session was signed in (fresh.ts), written as the session is made and by nothing else.
    session: {
      additionalFields: {
        signedInBy: { type: "string", required: false, input: false },
      },
    },
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
        // A token request that names no resource is for Keel's own API. Left unnamed, the
        // provider issues an opaque token it stores against a client row, and an agent has none.
        if (ctx.path === TOKEN_PATH)
          return ctx.body?.resource === undefined
            ? { context: { ...ctx, body: { ...ctx.body, resource: origin } } }
            : undefined;
        if (DISABLED.has(ctx.path))
          throw APIError.from("NOT_FOUND", { code: "NOT_FOUND", message: "Not found" });
        if (CHANGES_SIGN_IN.has(ctx.path)) await freshSignIn(ctx);
        if (BEFORE_HANDLE.has(ctx.path) || SIGN_IN.test(ctx.path)) {
          const name: unknown = ctx.body?.username;
          if (ctx.path === "/update-user" && typeof name === "string") {
            await claimable(db, name);
          } else if (ctx.path === "/update-user") {
            const session = await sessionOf(ctx);
            if (session !== null && !session.user["username"])
              throw refuse("HANDLE_REQUIRED", "Choose a handle first");
          }
          return;
        }
        const session = await sessionOf(ctx);
        if (session !== null && !session.user["username"])
          throw APIError.from("FORBIDDEN", {
            code: "HANDLE_REQUIRED",
            message: "Choose a handle first: it is your namespace, where your projects live",
          });
        // Before Better Auth's own read of org slugs, which answers a held one with a code of its own.
        const slug: unknown = ctx.body?.slug;
        if (ctx.path === "/organization/create" && typeof slug === "string")
          await claimable(db, slug);
        return beforeOrg(ctx);
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === TOKEN_PATH) return forgetSpentIds(db);
        return afterOrg(ctx);
      }),
    },
    databaseHooks: {
      // The endpoint making a session says how it was signed in; nothing a request sends does.
      session: {
        create: {
          before: async (session, context) => ({
            data: { ...session, signedInBy: signInMethod(context?.path ?? "") },
          }),
        },
      },
      // keel.town's privacy notice promises GitHub's token is never kept: Keel reads
      // the profile with it at sign-in and never again, so no account row holds it.
      account: {
        create: { before: async (account) => ({ data: { ...account, ...NO_PROVIDER_TOKENS } }) },
        update: { before: async (account) => ({ data: { ...account, ...NO_PROVIDER_TOKENS } }) },
      },
    },
    plugins: [
      username({
        minUsernameLength: 1,
        maxUsernameLength: 39,
        usernameValidator: (name) => nameRefusal(name) === undefined,
        // The handle is the first segment of every address in its namespace, so it never changes.
        immutableUsername: true,
      }),
      organization({
        ac: orgAccess,
        roles: ORG_ROLES,
        creatorRole: "owner",
        // Keel decides an invitation's recipient itself (org.ts): a handle for a
        // passkey-first user, whose placeholder is never verified, and a verified
        // address for an invitation typed by email.
        requireEmailVerificationOnInvitation: false,
        schema: {
          invitation: {
            additionalFields: {
              handle: { type: "string", required: false, input: true, index: true },
            },
          },
          // Whoever runs the instance suspends an org, never through Better Auth's own routes.
          organization: {
            additionalFields: {
              suspended: { type: "boolean", required: false, input: false, defaultValue: false },
            },
          },
        },
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org }) => {
            if (typeof org.slug !== "string") throw refuse("NAME_REFUSED", "An org needs a name");
            return { data: { ...org, slug: org.slug.toLowerCase() } };
          },
          beforeUpdateOrganization: async ({ organization: org }) => {
            if (org.slug !== undefined)
              throw refuse("NAME_IMMUTABLE", "An org's name is its address and never changes");
          },
        },
      }),
      deviceAuthorization({
        verificationUri: `${origin}/device`,
        validateClient: (clientId) => clientId === DEVICE_CLIENT_ID,
      }),
      bearer(),
      // Signs the tokens `agentTokens` issues, and publishes the key at `/jwks`. A session
      // is never turned into a token: no answer carries one in a header.
      jwt({
        disableSettingJwtHeader: true,
        jwks: { rotationInterval: TOKEN_KEY_SECONDS, gracePeriod: TOKEN_KEY_SECONDS },
      }),
      agentTokens({ origin, agents: config.agents }),
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
            // The passkey plugin answers any error but a refusal as its own 500, so a lost handle is refused here.
            const created = await ctx.context.internalAdapter
              .createUser(
                {
                  email: `${handle}@${PLACEHOLDER_EMAIL_DOMAIN}`,
                  emailVerified: false,
                  name: handle,
                  username: handle,
                  displayUsername: handle,
                },
                { method: "passkey" },
              )
              .catch((error: unknown) => {
                throw lostHandle(error) ? lostRace() : error;
              });
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

/**
 * The sign-in methods mounted besides a passkey, by the same tests that decide
 * whether `authOptions` mounts them. It reads the config, never an instance:
 * an instance is made per request ([ba.per-request]).
 */
export function signInMethods(config: AuthConfig): { emailCode: boolean; github: boolean } {
  return { emailCode: config.sendOtp !== undefined, github: config.github !== undefined };
}

export function makeAuth(config: AuthConfig): KeelAuth {
  return authOptions(config).auth;
}
