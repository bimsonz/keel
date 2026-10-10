// Fallback: the predicate-specific probe template for freshness. The shape is
// fixed: a subject makes a call on a session, the owner revokes, the subject
// calls again on the same session. The model only fills the slots (actors,
// setup requests, routes, bodies, expected statuses); the probe file is
// rendered deterministically from them. n/a is decided by the template: the
// revoke request answered by Hono's default not-found.

export interface Step {
  actor: "owner" | "subject";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** JSON body, as a JSON text, or "" for none. */
  body: string;
  expectedStatus: number;
}

export interface FreshnessSlots {
  owner: string;
  subject: string;
  /** Requests that build the scene after both actors have signed in. */
  setup: Step[];
  call: Step;
  revoke: Step;
  callAgain: Step;
  rationale: string;
}

const step = {
  type: "object",
  properties: {
    actor: { type: "string", enum: ["owner", "subject"] },
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    path: { type: "string" },
    body: { type: "string", description: 'JSON text of the request body, or "" for none.' },
    expectedStatus: { type: "integer" },
  },
  required: ["actor", "method", "path", "body", "expectedStatus"],
  additionalProperties: false,
};

export const TEMPLATE_SCHEMA = {
  type: "object",
  properties: {
    owner: { type: "string", description: "Username of the actor who grants and revokes." },
    subject: { type: "string", description: "Username of the actor whose access is revoked." },
    setup: { type: "array", items: step },
    call: step,
    revoke: step,
    callAgain: step,
    rationale: { type: "string" },
  },
  required: ["owner", "subject", "setup", "call", "revoke", "callAgain", "rationale"],
  additionalProperties: false,
} as const;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const USERNAME = /^[a-z][a-z0-9-]{0,38}$/;

function checkStep(s: unknown, where: string): string | undefined {
  if (s === null || typeof s !== "object") return `${where} must be an object`;
  const v = s as Record<string, unknown>;
  if (v.actor !== "owner" && v.actor !== "subject") return `${where}.actor must be "owner" or "subject"`;
  if (!METHODS.has(String(v.method))) return `${where}.method is not an HTTP method`;
  if (typeof v.path !== "string" || !v.path.startsWith("/")) return `${where}.path must start with /`;
  if (typeof v.body !== "string") return `${where}.body must be a string`;
  if (v.body !== "") {
    try {
      JSON.parse(v.body);
    } catch {
      return `${where}.body is not JSON text`;
    }
  }
  if (!Number.isInteger(v.expectedStatus) || (v.expectedStatus as number) < 100 || (v.expectedStatus as number) > 599) {
    return `${where}.expectedStatus must be an HTTP status`;
  }
  return undefined;
}

export function validateSlots(value: unknown): FreshnessSlots | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "the reply is not a JSON object";
  const v = value as Record<string, unknown>;
  for (const k of ["owner", "subject"]) {
    if (typeof v[k] !== "string" || !USERNAME.test(v[k] as string)) return `${k} must be a lowercase username`;
  }
  if (v.owner === v.subject) return "owner and subject must differ";
  if (!Array.isArray(v.setup)) return "setup must be an array";
  for (const [i, s] of v.setup.entries()) {
    const e = checkStep(s, `setup[${i}]`);
    if (e) return e;
    // The template creates and signs in both actors itself (template v2).
    const path = (s as Step).path;
    if (path === "/users" || path === "/sessions") {
      return `setup[${i}] calls ${path}: the template already creates both users and signs each in; setup must not`;
    }
  }
  for (const k of ["call", "revoke", "callAgain"]) {
    const e = checkStep(v[k], k);
    if (e) return e;
  }
  if ((v.call as Step).actor !== "subject" || (v.callAgain as Step).actor !== "subject") return "call and callAgain must be made by the subject";
  if ((v.revoke as Step).actor !== "owner") return "revoke must be made by the owner";
  if (typeof v.rationale !== "string") return "rationale must be a string";
  return v as unknown as FreshnessSlots;
}

/** Renders the freshness probe: call -> revoke -> call again, on one session per actor. */
const lit = (x: unknown) => JSON.stringify(x);

export function renderFreshness(s: FreshnessSlots): string {
  return `import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { ManualClock } from "../src/clock.ts";
import { sequentialIds } from "../src/ids.ts";
import { MemoryStore } from "../src/store/memory.ts";

// Rendered from the freshness template. Slots filled by the model:
// owner, subject, setup, call, revoke, callAgain.
type Step = { actor: "owner" | "subject"; method: string; path: string; body: string; expectedStatus: number };
const OWNER = ${lit(s.owner)};
const SUBJECT = ${lit(s.subject)};
const SETUP: Step[] = ${lit(s.setup)};
const CALL: Step = ${lit(s.call)};
const REVOKE: Step = ${lit(s.revoke)};
const CALL_AGAIN: Step = ${lit(s.callAgain)};
const PASSWORD = "template password 0001";

describe("freshness", () => {
  it("call, revoke, call again on the same session", async () => {
    const app = createApp({ store: new MemoryStore(), clock: new ManualClock(Date.UTC(2026, 0, 1)), ids: sequentialIds() });
    const send = (method: string, path: string, token: string | undefined, body: string) =>
      app.request(path, {
        method,
        headers: {
          ...(token === undefined ? {} : { authorization: \`Bearer \${token}\` }),
          ...(body === "" ? {} : { "content-type": "application/json" }),
        },
        body: body === "" ? null : body,
      });
    const signIn = async (username: string): Promise<string> => {
      expect((await send("POST", "/users", undefined, JSON.stringify({ username, password: PASSWORD }))).status).toBe(201);
      const res = await send("POST", "/sessions", undefined, JSON.stringify({ username, password: PASSWORD }));
      expect(res.status).toBe(201);
      return ((await res.json()) as { token: string }).token;
    };
    const tokens = { owner: await signIn(OWNER), subject: await signIn(SUBJECT) };
    const name = (s: Step) => (s.actor === "owner" ? OWNER : SUBJECT);
    const run = async (s: Step, observe: boolean) => {
      const res = await send(s.method, s.path, tokens[s.actor], s.body);
      if (observe) console.log(\`[probe] \${name(s)} \${s.method} \${s.path} -> \${res.status} (expected \${s.expectedStatus})\`);
      return res;
    };

    for (const s of SETUP) expect((await run(s, false)).status).toBe(s.expectedStatus);
    expect((await run(CALL, true)).status).toBe(CALL.expectedStatus);

    const revoke = await run(REVOKE, true);
    const absent =
      revoke.status === 404 &&
      (revoke.headers.get("content-type") ?? "").startsWith("text/plain") &&
      (await revoke.clone().text()) === "404 Not Found";
    if (absent) throw new Error("probe not applicable: revoke route absent");
    expect(revoke.status).toBe(REVOKE.expectedStatus);

    expect((await run(CALL_AGAIN, true)).status).toBe(CALL_AGAIN.expectedStatus);
  });
});
`;
}

export function templatePrompt(): string {
  return `## Fallback: fill the freshness template

Do not write a probe file. A fixed template renders it from slots you fill. The template:

1. creates the users \`owner\` and \`subject\` (POST /users) and signs each in once (POST /sessions); every later request
   by an actor uses that one session;
2. runs each \`setup\` step and asserts its \`expectedStatus\`;
3. runs \`call\` (by the subject) and asserts its status;
4. runs \`revoke\` (by the owner). If it is answered by Hono's default not-found (404, text/plain, \`404 Not Found\`) the
   probe reports n/a; otherwise it asserts its status;
5. runs \`callAgain\` (by the subject, on the same session as \`call\`) and asserts its status.

Each step is \`{"actor","method","path","body","expectedStatus"}\`; \`body\` is JSON text, or "" for none. Choose the
steps so the probe passes in A and fails in A+B, and so it would fail if the revoke did nothing.

Reply with one JSON object: \`{"owner","subject","setup":[...],"call":{...},"revoke":{...},"callAgain":{...},"rationale"}\`.`;
}
