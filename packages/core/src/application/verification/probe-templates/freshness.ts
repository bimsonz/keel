import { Result } from "effect";
import type { NoopRecipe } from "../world-matrix.ts";
import type { ProbeTemplate } from "./template.ts";

/**
 * The freshness probe template (spike S26): a subject calls on its session,
 * the owner revokes, the subject calls again on the same session. A model
 * only fills the slots; the probe file is rendered from them, so its code is
 * Keel's. The template decides n/a: a revoke answered by Hono's default
 * not-found means the revoke route is absent in that world.
 *
 * It is shaped for a forge-lite-like Worker app (`createApp`, a manual clock,
 * a memory store, `/users` and `/sessions`), which is what S-1 runs.
 */

export interface FreshnessStep {
  readonly actor: "owner" | "subject";
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  /** JSON body, as JSON text, or "" for none. */
  readonly body: string;
  readonly expectedStatus: number;
}

export interface FreshnessSlots {
  readonly owner: string;
  readonly subject: string;
  /** Requests that build the scene after both actors have signed in. */
  readonly setup: readonly FreshnessStep[];
  readonly call: FreshnessStep;
  readonly revoke: FreshnessStep;
  readonly callAgain: FreshnessStep;
  readonly rationale: string;
}

const stepSchema = {
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
} as const;

/** The JSON schema a model's reply is constrained to. */
export const FRESHNESS_SCHEMA = {
  type: "object",
  properties: {
    owner: { type: "string", description: "Username of the actor who grants and revokes." },
    subject: { type: "string", description: "Username of the actor whose access is revoked." },
    setup: { type: "array", items: stepSchema },
    call: stepSchema,
    revoke: stepSchema,
    callAgain: stepSchema,
    rationale: { type: "string" },
  },
  required: ["owner", "subject", "setup", "call", "revoke", "callAgain", "rationale"],
  additionalProperties: false,
} as const;

const isMethod = (value: unknown): value is FreshnessStep["method"] =>
  value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE";
const USERNAME = /^[a-z][a-z0-9-]{0,38}$/;

const get = (value: unknown, key: string): unknown => Reflect.get(Object(value), key);

const checkStep = (s: unknown, where: string): Result.Result<FreshnessStep, string> => {
  if (s === null || typeof s !== "object" || Array.isArray(s))
    return Result.fail(`${where} must be an object`);
  const actor = get(s, "actor");
  const method = get(s, "method");
  const path = get(s, "path");
  const body = get(s, "body");
  const status = get(s, "expectedStatus");
  if (actor !== "owner" && actor !== "subject")
    return Result.fail(`${where}.actor must be "owner" or "subject"`);
  if (!isMethod(method)) return Result.fail(`${where}.method is not an HTTP method`);
  if (typeof path !== "string" || !path.startsWith("/"))
    return Result.fail(`${where}.path must start with /`);
  if (typeof body !== "string") return Result.fail(`${where}.body must be a string`);
  if (body !== "") {
    try {
      JSON.parse(body);
    } catch {
      return Result.fail(`${where}.body is not JSON text`);
    }
  }
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599)
    return Result.fail(`${where}.expectedStatus must be an HTTP status`);
  return Result.succeed({
    actor,
    method,
    path,
    body,
    expectedStatus: status,
  });
};

/**
 * Checks a model's reply against the template, with deterministic text for
 * what is wrong (the repair loop's only input). The template signs both
 * actors in itself, so setup may not call `/users` or `/sessions`; the
 * subject makes both calls and the owner revokes.
 */
export const validateSlots = (value: unknown): Result.Result<FreshnessSlots, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return Result.fail("the reply is not a JSON object");
  const owner = get(value, "owner");
  const subject = get(value, "subject");
  if (typeof owner !== "string" || !USERNAME.test(owner))
    return Result.fail("owner must be a lowercase username");
  if (typeof subject !== "string" || !USERNAME.test(subject))
    return Result.fail("subject must be a lowercase username");
  if (owner === subject) return Result.fail("owner and subject must differ");
  const setup = get(value, "setup");
  if (!Array.isArray(setup)) return Result.fail("setup must be an array");
  const steps: FreshnessStep[] = [];
  for (const [i, s] of setup.entries()) {
    const checked = checkStep(s, `setup[${i}]`);
    if (Result.isFailure(checked)) return Result.fail(checked.failure);
    if (checked.success.path === "/users" || checked.success.path === "/sessions")
      return Result.fail(
        `setup[${i}] calls ${checked.success.path}: the template already creates both users and signs each in; setup must not`,
      );
    steps.push(checked.success);
  }
  const call = checkStep(get(value, "call"), "call");
  if (Result.isFailure(call)) return Result.fail(call.failure);
  const revoke = checkStep(get(value, "revoke"), "revoke");
  if (Result.isFailure(revoke)) return Result.fail(revoke.failure);
  const callAgain = checkStep(get(value, "callAgain"), "callAgain");
  if (Result.isFailure(callAgain)) return Result.fail(callAgain.failure);
  if (call.success.actor !== "subject" || callAgain.success.actor !== "subject")
    return Result.fail("call and callAgain must be made by the subject");
  if (revoke.success.actor !== "owner") return Result.fail("revoke must be made by the owner");
  const rationale = get(value, "rationale");
  if (typeof rationale !== "string") return Result.fail("rationale must be a string");
  return Result.succeed({
    owner,
    subject,
    setup: steps,
    call: call.success,
    revoke: revoke.success,
    callAgain: callAgain.success,
    rationale,
  });
};

const lit = (x: unknown) => JSON.stringify(x);

/** Renders the freshness probe from its slots: call, revoke, call again, on one session per actor. */
export const renderFreshness = (
  s: FreshnessSlots,
): string => `import { describe, expect, it } from "vitest";
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

/** What a model is told when it fills the template. */
export const FRESHNESS_PROMPT = `## Fallback: fill the freshness template

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

/**
 * Freshness's A-noop recipe: the revoke call A's premise anchors on, at
 * `path`, made a statement that does nothing. The route still answers as it
 * did; nothing is revoked. A probe that still passes there proves nothing
 * about the revoke, so it is never admitted.
 */
export const freshnessNoop = (anchor: {
  readonly path: string;
  readonly call: string;
}): NoopRecipe => ({
  path: anchor.path,
  anchor: anchor.call,
  replacement: "void 0; /* A-noop: the anchored call does nothing */",
});

/** The freshness template, as draftProbe fills it: one probe file, `.keel/freshness.test.ts`. */
export const FRESHNESS_TEMPLATE: ProbeTemplate<FreshnessSlots> = {
  id: "freshness/1",
  fn: "keel.probe.freshness",
  schema: FRESHNESS_SCHEMA,
  instructions: FRESHNESS_PROMPT,
  validate: validateSlots,
  render: (slots) => [{ path: ".keel/freshness.test.ts", text: renderFreshness(slots) }],
};
