import { KeyError } from "./agent-key.ts";
import type { KeyStore } from "./key-store.ts";
import type { ExitCode, Io } from "./run.ts";

/** The CLI's client id in the device grant (RFC 8628): the only one Keel lets start one. */
const CLIENT_ID = "keeltown";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** What a `slow_down` adds to every wait after it (RFC 8628, section 3.5). */
const SLOW_DOWN_SECONDS = 5;

/** A person signed in on this machine, on one Keel host: their session's token, and who it names. */
export interface SignIn {
  readonly token: string;
  readonly handle?: string;
  readonly userId?: string;
  /** Where the sign-in is held, in words a person reads. */
  readonly where: string;
}

/** A sign-in Keel did not give, or could not be told to end: said on stderr, exit 1. */
export class LoginFailed extends Error {}

type Fetch = NonNullable<Io["fetch"]>;

const text = (value: unknown, name: string): string | undefined => {
  const member: unknown = Reflect.get(Object(value), name);
  return typeof member === "string" && member !== "" ? member : undefined;
};

const seconds = (value: unknown, name: string): number | undefined => {
  const member: unknown = Reflect.get(Object(value), name);
  return typeof member === "number" && Number.isFinite(member) && member > 0 ? member : undefined;
};

/** A sign-in as the store keeps it: one base64url word, as an agent's key is. */
export const encodeSignIn = (signIn: Omit<SignIn, "where">): string =>
  Buffer.from(JSON.stringify(signIn), "utf8").toString("base64url");

/**
 * The sign-in this machine holds for `entry`. `KEEL_SESSION` (set by a secret
 * manager where there is no key store) comes first; otherwise the key store.
 * Undefined when neither holds one.
 */
export async function heldSignIn(
  env: Io["env"],
  store: KeyStore | undefined,
  entry: string,
): Promise<SignIn | undefined> {
  const given = env["KEEL_SESSION"];
  if (given !== undefined && given !== "") return { token: given, where: "KEEL_SESSION" };
  const secret = await store?.read(entry);
  if (store === undefined || secret === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(secret, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const token = text(parsed, "token");
  if (token === undefined)
    throw new KeyError(`${store.kind} holds something under ${entry} that is not a sign-in`);
  const handle = text(parsed, "handle");
  const userId = text(parsed, "userId");
  return {
    token,
    ...(handle === undefined ? {} : { handle }),
    ...(userId === undefined ? {} : { userId }),
    where: store.kind,
  };
}

const json = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

const post = (fetch: Fetch, url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const RAN_OUT = "The code ran out before it was approved. Run `keeltown login` again.";

/**
 * Signs a person in from a terminal by the device grant: Keel names a page and
 * a code, the person approves it there with the session they are signed in by,
 * and the CLI asks for the session's token no faster than Keel said, for as
 * long as the code lasts.
 */
export async function deviceLogin(asked: {
  readonly baseUrl: string;
  readonly fetch: Fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly say: (line: string) => void;
}): Promise<{ readonly token: string; readonly handle: string; readonly userId: string }> {
  const auth = `${asked.baseUrl}/v1/auth`;
  const started = await post(asked.fetch, `${auth}/device/code`, { client_id: CLIENT_ID });
  const code = await json(started);
  const deviceCode = text(code, "device_code");
  const userCode = text(code, "user_code");
  const page = text(code, "verification_uri_complete") ?? text(code, "verification_uri");
  if (!started.ok || deviceCode === undefined || userCode === undefined || page === undefined)
    throw new LoginFailed(`Keel did not start a sign-in (HTTP ${started.status}).`);
  asked.say(`Open ${page} and approve the code ${userCode}. Waiting for it there.`);

  let wait = seconds(code, "interval") ?? SLOW_DOWN_SECONDS;
  const until = asked.now() + (seconds(code, "expires_in") ?? 0) * 1000;
  let token: string | undefined;
  while (token === undefined) {
    if (asked.now() + wait * 1000 > until) throw new LoginFailed(RAN_OUT);
    await asked.sleep(wait * 1000);
    const polled = await post(asked.fetch, `${auth}/device/token`, {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: CLIENT_ID,
    });
    const answer = await json(polled);
    token = polled.ok ? text(answer, "access_token") : undefined;
    if (token !== undefined) break;
    const error = text(answer, "error");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") wait += SLOW_DOWN_SECONDS;
    else if (error === "access_denied")
      throw new LoginFailed("The sign-in was refused on Keel. Nothing is held on this machine.");
    else if (error === "expired_token") throw new LoginFailed(RAN_OUT);
    else
      throw new LoginFailed(
        `Keel refused the sign-in: ${text(answer, "error_description") ?? error ?? `HTTP ${polled.status}`}.`,
      );
  }

  const session = await json(
    await asked.fetch(`${auth}/get-session`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  const user: unknown = Reflect.get(Object(session), "user");
  const handle = text(user, "username");
  const userId = text(user, "id");
  if (handle === undefined || userId === undefined)
    throw new LoginFailed("Keel signed this machine in and then did not say as whom.");
  return { token, handle, userId };
}

const NO_STORE =
  "This machine has no key store the CLI can use, and a sign-in is never written to a file. Run `keeltown login --print-token` to sign in and print the session's token once, for a secret manager to set as KEEL_SESSION.";

/** `login`: nothing is asked of Keel until there is somewhere to keep the answer. */
export async function loginCommand(
  io: Io,
  asked: {
    readonly baseUrl: string;
    readonly entry: string;
    readonly printToken: boolean;
    readonly json: boolean;
  },
): Promise<ExitCode> {
  if (!asked.printToken && io.signIns === undefined) {
    io.stderr(NO_STORE);
    return 2;
  }
  const made = await deviceLogin({
    baseUrl: asked.baseUrl,
    fetch: io.fetch ?? ((input, init) => fetch(input, init)),
    sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: io.now ?? Date.now,
    say: io.stderr,
  });
  if (asked.printToken || io.signIns === undefined) {
    // A token for somewhere else to keep: printed once and written nowhere.
    io.stdout(made.token);
    io.stderr(
      `Signed in as ${made.handle}. The line above is the only copy of this sign-in's token: keep it in a secret manager as KEEL_SESSION. \`keeltown logout\` with it set ends it.`,
    );
    return 0;
  }
  await io.signIns.write(asked.entry, encodeSignIn(made));
  io.stdout(
    asked.json
      ? JSON.stringify(
          { handle: made.handle, userId: made.userId, signIn: io.signIns.kind },
          null,
          2,
        )
      : `Signed in as ${made.handle}. The sign-in is held in ${io.signIns.kind}.`,
  );
  return 0;
}

/**
 * `logout`: the session is ended at Keel before the machine forgets it, so a
 * sign-in Keel could not be told about is still here to end later.
 */
export async function logoutCommand(
  io: Io,
  asked: { readonly baseUrl: string; readonly entry: string },
): Promise<ExitCode> {
  const held = await heldSignIn(io.env, io.signIns, asked.entry);
  if (held === undefined) {
    io.stderr("This machine holds no sign-in for this Keel.");
    return 2;
  }
  const send = io.fetch ?? ((input, init) => fetch(input, init));
  let status: number | undefined;
  try {
    const ended = await post(
      send,
      `${asked.baseUrl}/v1/auth/sign-out`,
      {},
      { authorization: `Bearer ${held.token}` },
    );
    status = ended.status;
  } catch {
    status = undefined;
  }
  // A session Keel no longer knows needs no ending: 400 and 401 are how it says so.
  const ended = status === 200 || status === 400 || status === 401;
  if (!ended)
    throw new LoginFailed(
      `Keel could not be told to end the session (${status === undefined ? "no answer" : `HTTP ${status}`}). The sign-in is still held: run \`keeltown logout\` again.`,
    );
  if (held.where === "KEEL_SESSION") {
    io.stdout("Signed out. The session is ended at Keel: unset KEEL_SESSION.");
    return 0;
  }
  await io.signIns?.remove(asked.entry);
  io.stdout(
    `Signed out${held.handle === undefined ? "" : ` ${held.handle}`}. The session is ended at Keel and nothing is held in ${held.where}.`,
  );
  return 0;
}
