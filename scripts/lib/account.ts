// An automation account on a Keel: signed up, and signed in to again, by a
// passkey through the routes any visitor uses. No route makes a user for it,
// so whoever runs the seed or a lane's harness holds the passkey's key.
import {
  type Answer,
  Authenticator,
  caller,
  type Fetcher,
  Jar,
  type SavedPasskey,
  SESSION_COOKIE,
} from "../../packages/testing/src/passkey.ts";

/** A user's bearer session, with where it works and whose it is. */
export interface AccountSession {
  readonly keelUrl: string;
  readonly handle: string;
  /** The account's own namespace, by handle: what its own projects are created in. */
  readonly namespace: string;
  readonly userId: string;
  /** The id of the org named by its handle. */
  readonly org: string;
  /** Sent as `Authorization: Bearer <token>`. */
  readonly token: string;
  readonly expiresAt: string;
}

export interface Account {
  readonly session: AccountSession;
  /** The passkey that signs in to it again, its use count as of this session. */
  readonly passkey: SavedPasskey;
}

/** A step Keel refused, by status and code only: never an answer's body, which may hold a session. */
export class AccountRefused extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(step: string, answer: { readonly status: number; readonly code?: unknown }) {
    const code = typeof answer.code === "string" ? answer.code : undefined;
    super(`${step}: ${answer.status}${code === undefined ? "" : ` ${code}`}`);
    this.name = "AccountRefused";
    this.status = answer.status;
    this.code = code;
  }
}

const overTheNetwork: Fetcher = (request) => fetch(request);

/** A field of an answer read as JSON, when the answer is an object at all. */
const field = (from: unknown, name: string): unknown =>
  typeof from === "object" && from !== null ? Reflect.get(from, name) : undefined;

type Site = ReturnType<typeof caller>;

const expectOk = (step: string, answer: Answer): Answer => {
  if (answer.status !== 200) throw new AccountRefused(step, { ...answer, code: answer.json?.code });
  return answer;
};

/** The session's token, as the signed cookie carries it before its signature. */
function tokenOf(jar: Jar): string {
  const raw = jar.cookies.get(SESSION_COOKIE);
  if (raw === undefined) throw new Error("no session cookie was set");
  const value = decodeURIComponent(raw);
  return value.slice(0, value.lastIndexOf("."));
}

/** Who Keel's gate says a bearer is, with its role in each of its orgs by name. */
export async function whoIs(
  keelUrl: string,
  token: string,
  fetcher: Fetcher = overTheNetwork,
): Promise<{
  readonly status: number;
  readonly handle?: string;
  readonly userId?: string;
  readonly orgs: Readonly<Record<string, string>>;
}> {
  const response = await fetcher(
    new Request(`${keelUrl}/v1/users/me`, { headers: { authorization: `Bearer ${token}` } }),
  );
  const body: unknown = await response.json().catch(() => undefined);
  const handle = field(body, "handle");
  const userId = field(body, "userId");
  const orgs = field(body, "orgs");
  return {
    status: response.status,
    ...(typeof handle === "string" ? { handle } : {}),
    ...(typeof userId === "string" ? { userId } : {}),
    orgs: Object.fromEntries(
      (Array.isArray(orgs) ? orgs : []).map((org: unknown) => [
        String(field(org, "name")),
        String(field(org, "role")),
      ]),
    ),
  };
}

/** The jar's session as a bearer, once the gate reads that bearer as the same user. */
async function sessionOf(
  keelUrl: string,
  handle: string,
  site: Site,
  jar: Jar,
  fetcher: Fetcher,
): Promise<AccountSession> {
  const session = expectOk("the session", await site("/get-session", { jar }));
  const orgs = expectOk("its orgs", await site("/organization/list", { jar }));
  const listed: unknown = orgs.json;
  const own = field(
    (Array.isArray(listed) ? listed : []).find((org: unknown) => field(org, "slug") === handle),
    "id",
  );
  if (session.json?.user?.username !== handle || typeof own !== "string")
    throw new Error(`the session is not ${handle}'s`);
  const token = tokenOf(jar);
  const gate = await whoIs(keelUrl, token, fetcher);
  if (gate.status !== 200 || gate.handle !== handle || gate.userId !== session.json.user.id)
    throw new AccountRefused(`the gate, reading ${handle}'s bearer`, gate);
  return {
    keelUrl,
    handle,
    namespace: handle,
    userId: session.json.user.id,
    org: own,
    token,
    expiresAt: new Date(session.json.session.expiresAt).toISOString(),
  };
}

/**
 * Signs `handle` up with a new passkey. `keep` is given the passkey before
 * Keel is asked to accept it, so a caller that stores it there can never hold
 * an account without its key.
 */
export async function signUp(
  keelUrl: string,
  handle: string,
  options: {
    readonly fetcher?: Fetcher;
    readonly keep?: (passkey: SavedPasskey) => void | Promise<void>;
  } = {},
): Promise<Account> {
  const fetcher = options.fetcher ?? overTheNetwork;
  const site = caller(fetcher, keelUrl);
  const jar = new Jar();
  const offered = expectOk(
    "register options",
    await site(`/passkey/generate-register-options?context=${encodeURIComponent(handle)}`, { jar }),
  );
  const device = new Authenticator(keelUrl);
  const response = await device.create(offered.json.challenge);
  const passkey = await device.saved();
  await options.keep?.(passkey);
  expectOk(
    "the registration",
    await site("/passkey/verify-registration", { jar, body: { response, createSession: true } }),
  );
  return { session: await sessionOf(keelUrl, handle, site, jar, fetcher), passkey };
}

/** A browser signed in with a kept passkey: Better Auth's routes with the account's cookie. */
export interface SignedIn {
  readonly site: Site;
  readonly jar: Jar;
  /** The passkey with this sign-in counted: store it in place of the one given. */
  readonly passkey: SavedPasskey;
}

export async function signedIn(
  keelUrl: string,
  passkey: SavedPasskey,
  fetcher: Fetcher = overTheNetwork,
): Promise<SignedIn> {
  const site = caller(fetcher, keelUrl);
  const jar = new Jar();
  const device = await Authenticator.from(keelUrl, passkey);
  const offered = expectOk(
    "sign-in options",
    await site("/passkey/generate-authenticate-options", { jar }),
  );
  const response = await device.get(offered.json.challenge);
  expectOk(
    "the sign-in",
    await site("/passkey/verify-authentication", { jar, body: { response } }),
  );
  return { site, jar, passkey: await device.saved() };
}

/** A new session for `handle` from its kept passkey. */
export async function signIn(
  keelUrl: string,
  handle: string,
  passkey: SavedPasskey,
  fetcher: Fetcher = overTheNetwork,
): Promise<Account> {
  const browser = await signedIn(keelUrl, passkey, fetcher);
  return {
    session: await sessionOf(keelUrl, handle, browser.site, browser.jar, fetcher),
    passkey: browser.passkey,
  };
}
