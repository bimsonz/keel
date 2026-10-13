import type { KeyStore } from "../src/key-store.ts";
import type { Io } from "../src/run.ts";

export const ORIGIN = "https://keel.test";
export const CODE = `${ORIGIN}/v1/auth/device/code`;
export const POLL = `${ORIGIN}/v1/auth/device/token`;
export const SESSION = `${ORIGIN}/v1/auth/get-session`;
export const SIGN_OUT = `${ORIGIN}/v1/auth/sign-out`;
const DISCOVERY = `${ORIGIN}/.well-known/oauth-authorization-server`;
const AGENT_TOKENS = `${ORIGIN}/v1/auth/oauth2/token`;

/** The session's token the device grant hands over, and the two codes on the way to it. */
export const TOKEN = "sessiontokenQ7x2mN4pL9vB3kR8";
export const DEVICE = "device-code-only-the-cli-holds";
export const USER_CODE = "WDJBMJHT";
export const PAGE = `${ORIGIN}/device?user_code=${USER_CODE}`;
export const AGENT_TOKEN = "agent-token-1";

/** What Keel answers one poll of the device grant's token endpoint. */
export type Poll = "pending" | "slow_down" | "denied" | "expired" | "token";

export interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
  /** The test clock's reading when it was sent, in milliseconds. */
  readonly at: number;
}

export function memoryStore(): KeyStore & { readonly held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    kind: "a test key store",
    held,
    read: async (name) => held.get(name),
    write: async (name, secret) => void held.set(name, secret),
    remove: async (name) => void held.delete(name),
  };
}

export const decoded = (secret: string | undefined): unknown =>
  JSON.parse(Buffer.from(secret ?? "", "base64url").toString("utf8"));

const refusal = (error: string) =>
  Response.json({ error, error_description: `Keel says ${error}` }, { status: 400 });

/**
 * A fake Keel for a person at a terminal: the device grant (each poll answered
 * as `polls` scripts it, the last one for every poll after), the session it
 * hands over, sign-out, and an agent's token endpoint beside them. The clock
 * moves only when the CLI sleeps, so a test reads how long it waited.
 */
export function keel(
  options: {
    readonly polls?: readonly Poll[];
    readonly store?: "none";
    readonly origin?: string;
    readonly env?: Record<string, string>;
    readonly expiresIn?: number;
    readonly signOut?: () => Response;
  } = {},
) {
  const origin = options.origin ?? ORIGIN;
  const polls = options.polls ?? ["token"];
  const sent: Sent[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const slept: number[] = [];
  let clock = 1_000_000;
  let ended = false;
  const signIns = memoryStore();
  const keyStore = memoryStore();
  const io: Io = {
    env: { KEEL_URL: origin, ...options.env },
    stdout: (line) => void out.push(line),
    stderr: (line) => void err.push(line),
    keyStore,
    signIns: options.store === "none" ? undefined : signIns,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    fetch: async (input, init) => {
      const url = input.replace(origin, ORIGIN);
      const request: Sent = {
        url,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? init.body : "",
        at: clock,
      };
      sent.push(request);
      if (url === CODE)
        return Response.json({
          device_code: DEVICE,
          user_code: USER_CODE,
          verification_uri: `${ORIGIN}/device`,
          verification_uri_complete: PAGE,
          expires_in: options.expiresIn ?? 1800,
          interval: 5,
        });
      if (url === POLL) {
        const asked = sent.filter((s) => s.url === POLL).length;
        if (asked > 500) throw new Error("the CLI polled past any deadline");
        const answer = polls[Math.min(asked, polls.length) - 1];
        if (answer === "token")
          return Response.json({
            access_token: TOKEN,
            token_type: "Bearer",
            expires_in: 604_800,
            scope: "",
          });
        if (answer === "denied") return refusal("access_denied");
        if (answer === "expired") return refusal("expired_token");
        return refusal(answer === "slow_down" ? "slow_down" : "authorization_pending");
      }
      if (url === SESSION)
        return Response.json(
          request.headers.get("authorization") === `Bearer ${TOKEN}` && !ended
            ? { session: { id: "ses_1" }, user: { id: "usr_ada", username: "ada" } }
            : null,
        );
      if (url === SIGN_OUT) {
        const answer = options.signOut?.() ?? Response.json({ success: true });
        if (answer.ok) ended = true;
        return answer;
      }
      if (url === DISCOVERY)
        return Response.json({
          issuer: `${ORIGIN}/v1/auth`,
          token_endpoint: AGENT_TOKENS,
          registration_endpoint: `${ORIGIN}/v1/oauth/register`,
        });
      if (url === AGENT_TOKENS)
        return Response.json({
          access_token: AGENT_TOKEN,
          token_type: request.headers.has("dpop") ? "DPoP" : "Bearer",
          expires_in: 300,
          scope: "agent:work agent:read",
        });
      return Response.json({ ok: true, summary: "You are somebody.", result: {} });
    },
  };
  const to = (url: string) => sent.filter((s) => s.url === url);
  const said = () => [...out, ...err].join("\n");
  return { io, sent, out, err, slept, signIns, keyStore, to, said };
}
