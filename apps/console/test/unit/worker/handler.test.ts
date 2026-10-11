import { describe, expect, it } from "vitest";
import { checkCapability, mintCapability } from "../../../src/capability.ts";
import { type FakeKeel, createFakeKeel } from "../../fixtures/mock/fakeKeel.ts";
import { type Console, type Env, createConsole } from "../../../src/worker/handler.ts";

const ORIGIN = "https://keel-console.example";
const PRESENTER = "the presenter's key";
const SIGNING = "the capability key";

interface Rig {
  keel: FakeKeel;
  mission: Console;
  env: Env;
  clock: { now: number };
  /** What reached the page's files. */
  assets: string[];
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
}

function rig(overrides: Partial<Env> = {}): Rig {
  const keel = createFakeKeel({
    clients: [
      { id: "observer", secret: "observer-secret", scopes: ["observer"] },
      { id: "operator", secret: "operator-secret", scopes: ["operator"] },
    ],
  });
  const clock = { now: 1_800_000_000_000 };
  const assets: string[] = [];
  const env: Env = {
    KEEL: keel,
    KEEL_API_HOST: "keel.example",
    ASSETS: {
      fetch: (request) => {
        assets.push(new URL(request.url).pathname);
        return Promise.resolve(
          new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
        );
      },
    },
    KEEL_OBSERVER_CLIENT_ID: "observer",
    KEEL_OBSERVER_CLIENT_SECRET: "observer-secret",
    KEEL_OPERATOR_CLIENT_ID: "operator",
    KEEL_OPERATOR_CLIENT_SECRET: "operator-secret",
    CONSOLE_CAPABILITY_KEY: SIGNING,
    CONSOLE_PRESENTER_KEY: PRESENTER,
    ...overrides,
  };
  const mission = createConsole(() => clock.now);
  return {
    keel,
    mission,
    env,
    clock,
    assets,
    get: (path, headers = {}) => mission.fetch(new Request(`${ORIGIN}${path}`, { headers }), env),
    post: (path, body, headers = {}) =>
      mission.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
        env,
      ),
  };
}

/** One field of a JSON answer. */
async function field(response: Response, name: string): Promise<unknown> {
  const answer: unknown = await response.json();
  return typeof answer === "object" && answer !== null
    ? new Map<string, unknown>(Object.entries(answer)).get(name)
    : undefined;
}
/** What the presenter's console shows on every request. */
const AS_PRESENTER = { authorization: `Bearer ${PRESENTER}` };
const reason = (response: Response): Promise<unknown> => field(response, "reason");
const calls = (keel: FakeKeel, path: string): FakeKeel["calls"] =>
  keel.calls.filter((call) => call.path === path);
const openQuestion = (keel: FakeKeel): string =>
  keel
    .events()
    .flatMap((event) =>
      event.type === "EscalationRaised" ? [event.payload.escalationId] : [],
    )[0] ?? "";

async function capabilityFor(r: Rig, escalationId: string): Promise<string> {
  const response = await r.post(
    "/present/capability",
    { escalationId },
    { authorization: `Bearer ${PRESENTER}` },
  );
  const value = await field(response, "capability");
  return typeof value === "string" ? value : "";
}

/** A Keel that refuses every ruling with one problem code, and is the stand-in for everything else. */
function refusingWith(code: string): Rig {
  const r = rig();
  const { keel } = r;
  r.env.KEEL = {
    fetch: (request) =>
      new URL(request.url).pathname.endsWith("/ruling")
        ? Promise.resolve(
            Response.json(
              {
                type: "about:blank",
                title: code,
                status: 400,
                code,
                requestId: "req_1",
                nextActions: [],
              },
              { status: 400, headers: { "content-type": "application/problem+json" } },
            ),
          )
        : keel.fetch(request),
  };
  return r;
}

/** What the console tells a person whose ruling Keel refused with that code. */
async function told(code: string): Promise<unknown[]> {
  const r = refusingWith(code);
  const answer = await r.post(`/rule/${await capabilityFor(r, "esc_1")}`, {
    option: "flip-a-coin",
  });
  return [answer.status, await reason(answer)];
}

describe("reading Keel through the console", () => {
  it("[handler.anonymous] sends a visitor's read to Keel with no token, exchanges none, and answers as Keel did", async () => {
    const r = rig();
    const response = await r.get("/api/v1/events?cursor=7&limit=5&as=observer", {
      cookie: "session=1",
    });
    const [read] = calls(r.keel, "/v1/events");
    expect(read).toMatchObject({ host: "keel.example", query: "cursor=7&limit=5" });
    expect(read?.authorization).toBe("");
    expect(calls(r.keel, "/v1/oauth/token")).toEqual([]);
    // Keel reads its log to an observer or an agent. What it says to anyone else is what the visitor is told.
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await field(response, "code")).toBe("auth.invalid_token");
    // And a visitor's read after the presenter's is still a visitor's: the token held is not lent.
    await r.get("/api/v1/events", AS_PRESENTER);
    await r.get("/api/v1/lattices");
    expect(calls(r.keel, "/v1/lattices").map((call) => call.authorization)).toEqual([""]);
  });

  it("[handler.wrong-key] refuses a key that is not the presenter's, and Keel is never asked", async () => {
    const r = rig();
    const refused = await Promise.all(
      ["Bearer not-the-key", "Bearer ", "Basic abc", PRESENTER, `bearer ${PRESENTER}x`].map(
        (authorization) => r.get("/api/v1/events", { authorization }),
      ),
    );
    expect(refused.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    expect(r.keel.calls).toEqual([]);
  });

  it("[handler.no-key] has no presenter when it was deployed with no key", async () => {
    const r = rig({ CONSOLE_PRESENTER_KEY: "" });
    expect((await r.get("/api/v1/events", { authorization: "Bearer " })).status).toBe(401);
    expect((await r.post("/present/capability", { escalationId: "esc_1" })).status).toBe(401);
    expect(
      (await r.post("/present/capability", { escalationId: "esc_1" }, { authorization: "Bearer " }))
        .status,
    ).toBe(401);
    expect(r.keel.calls).toEqual([]);
  });

  it("[handler.presenter] passes the presenter's read on as an observer, with the query and nothing else of the browser's", async () => {
    const r = rig();
    const response = await r.get("/api/v1/events?cursor=7&limit=5&wait=0&as=operator", {
      ...AS_PRESENTER,
      cookie: "session=1",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await field(response, "items")).toHaveLength(5);
    const [exchange] = calls(r.keel, "/v1/oauth/token");
    expect(new URLSearchParams(exchange?.body).get("scope")).toBe("observer");
    expect(new URLSearchParams(exchange?.body).get("client_id")).toBe("observer");
    const [read] = calls(r.keel, "/v1/events");
    expect(read?.host).toBe("keel.example");
    expect(read?.query).toBe("cursor=7&limit=5&wait=0");
    // The observer's token, and not the key that earned it.
    expect(read?.authorization).toMatch(/^Bearer tok_\d+_observer$/);
  });

  it("reads Keel's lattices and a verdict's evidence as an observer, by Keel's own routes for them", async () => {
    const r = rig();
    const lattices = await r.get("/api/v1/lattices", AS_PRESENTER);
    expect(lattices.status).toBe(200);
    expect(await field(lattices, "items")).toHaveLength(11);
    const verdictId =
      r.keel
        .events()
        .flatMap((event) => (event.type === "VerdictIssued" ? [event.payload.verdictId] : []))[0] ??
      "";
    const verdict = await r.get(`/api/v1/verdicts/${verdictId}?as=operator`, AS_PRESENTER);
    expect(verdict.status).toBe(200);
    expect(await field(verdict, "outcome")).toBe("park");
    const [read] = calls(r.keel, `/v1/verdicts/${verdictId}`);
    expect(read).toMatchObject({ method: "GET", query: "", host: "keel.example" });
    expect(read?.authorization).toMatch(/^Bearer tok_\d+_observer$/);
    // An id is one segment of an id's characters. Nothing after it, and nothing in it, can name another of Keel's routes.
    const asked = r.keel.calls.length;
    const refused = await Promise.all(
      [
        "/api/v1/verdicts/",
        `/api/v1/verdicts/${verdictId}/ruling`,
        "/api/v1/verdicts/..%2Fescalations",
        "/api/v1/verdicts/a.b",
        "/api/v1/lattices/extra",
      ].map((path) => r.get(path, AS_PRESENTER)),
    );
    expect(refused.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
    expect(r.keel.calls).toHaveLength(asked);
  });

  it("keeps its token until a minute before it expires, then asks for another", async () => {
    const r = rig();
    await r.get("/api/v1/events", AS_PRESENTER);
    await r.get("/api/v1/events", AS_PRESENTER);
    expect(calls(r.keel, "/v1/oauth/token")).toHaveLength(1);
    r.clock.now += (3600 - 61) * 1000;
    await r.get("/api/v1/events", AS_PRESENTER);
    expect(calls(r.keel, "/v1/oauth/token")).toHaveLength(1);
    r.clock.now += 2_000;
    await r.get("/api/v1/events", AS_PRESENTER);
    expect(calls(r.keel, "/v1/oauth/token")).toHaveLength(2);
  });

  it("replaces a token Keel no longer honours, and tries once more, not for ever", async () => {
    const r = rig();
    await r.get("/api/v1/events", AS_PRESENTER);
    r.keel.revokeTokens();
    expect((await r.get("/api/v1/events", AS_PRESENTER)).status).toBe(200);
    expect(calls(r.keel, "/v1/oauth/token")).toHaveLength(2);
    expect(calls(r.keel, "/v1/events")).toHaveLength(3);
    r.keel.refuseEveryone();
    expect((await r.get("/api/v1/events", AS_PRESENTER)).status).toBe(401);
    expect(calls(r.keel, "/v1/events")).toHaveLength(5);
  });

  it("reads nothing that is not on its list, and Keel is never asked", async () => {
    const r = rig();
    const refused = await Promise.all(
      [
        "/api/v1/escalations",
        "/api/v1/projects",
        "/api/v1/agents",
        "/api/v1/events/extra",
        "/api/v1/oauth/token",
        "/api/",
      ].map((path) => r.get(path, AS_PRESENTER)),
    );
    expect(refused.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404]);
    expect((await r.post("/api/v1/events", {}, AS_PRESENTER)).status).toBe(405);
    expect(r.keel.calls).toEqual([]);
  });

  it("cannot be made to reach an operator's route, whatever is sent to it", async () => {
    const r = rig();
    const question = openQuestion(r.keel);
    // An operator's token is already held, from a ruling given the proper way.
    await r.post(`/rule/${await capabilityFor(r, question)}`, { option: "invalidate" });
    const before = r.keel.calls.length;
    const tried = await Promise.all([
      r.post(`/api/v1/escalations/${question}/ruling`, { option: "no-cache" }, AS_PRESENTER),
      r.post("/api/v1/agents", { name: "x", kind: "hosted", scopes: ["operator"] }, AS_PRESENTER),
      r.post("/api/v1/projects", { name: "x" }, AS_PRESENTER),
      r.get("/api/v1/escalations?state=open", AS_PRESENTER),
      r.get(`/api/v1/events/../escalations/${question}/ruling`, AS_PRESENTER),
    ]);
    expect(tried.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
    expect(r.keel.calls).toHaveLength(before);
    // And a read after it still goes as the observer.
    await r.get("/api/v1/events", AS_PRESENTER);
    expect(r.keel.calls.at(-1)?.authorization).toMatch(/_observer$/);
    expect(
      calls(r.keel, "/v1/events").filter((call) => call.authorization.includes("operator")),
    ).toEqual([]);
  });

  it("says so when Keel will not have its credentials", async () => {
    const r = rig({ KEEL_OBSERVER_CLIENT_SECRET: "wrong" });
    const response = await r.get("/api/v1/events", AS_PRESENTER);
    expect(response.status).toBe(502);
    expect(calls(r.keel, "/v1/events")).toEqual([]);
  });
});

describe("ruling through the console", () => {
  it("gives a capability only to the presenter", async () => {
    const r = rig();
    expect((await r.post("/present/capability", { escalationId: "esc_1" })).status).toBe(401);
    expect(
      (
        await r.post(
          "/present/capability",
          { escalationId: "esc_1" },
          { authorization: "Bearer a guess" },
        )
      ).status,
    ).toBe(401);
    expect(
      (await r.post("/present/capability", {}, { authorization: `Bearer ${PRESENTER}` })).status,
    ).toBe(400);
    const capability = await capabilityFor(r, "esc_1");
    expect(await checkCapability(SIGNING, capability, r.clock.now / 1000)).toMatchObject({
      ok: true,
      claim: { escalationId: "esc_1", expires: r.clock.now / 1000 + 600 },
    });
    expect(r.keel.calls).toEqual([]);
  });

  it("rules as an operator on the one question the capability names, and the story continues", async () => {
    const r = rig();
    const question = openQuestion(r.keel);
    const capability = await capabilityFor(r, question);
    const response = await r.post(`/rule/${capability}`, {
      option: "no-cache",
      rationale: "Revocation must be immediate",
    });
    expect(response.status).toBe(200);
    const [exchange] = calls(r.keel, "/v1/oauth/token");
    expect(new URLSearchParams(exchange?.body).get("scope")).toBe("operator");
    const [ruling] = calls(r.keel, `/v1/escalations/${question}/ruling`);
    expect(ruling).toMatchObject({
      method: "POST",
      body: JSON.stringify({ option: "no-cache", rationale: "Revocation must be immediate" }),
    });
    expect(ruling?.authorization).toMatch(/^Bearer tok_\d+_operator$/);
    expect(ruling?.idempotencyKey).toMatch(/^console:[0-9a-f]{24}$/);
    expect(r.keel.events().find((event) => event.type === "RulingGiven")?.payload).toMatchObject({
      option: "no-cache",
    });
  });

  it("[handler.once] is good once: the same capability again changes nothing, and another finds the question closed", async () => {
    const r = rig();
    const question = openQuestion(r.keel);
    const first = await capabilityFor(r, question);
    const second = await capabilityFor(r, question);
    expect((await r.post(`/rule/${first}`, { option: "invalidate" })).status).toBe(200);
    // A retry of the same tap is the same command.
    expect((await r.post(`/rule/${first}`, { option: "invalidate" })).status).toBe(200);
    // The same capability for another answer is not that command, and is not told it ruled.
    const changed = await r.post(`/rule/${first}`, { option: "no-cache" });
    expect(changed.status).toBe(409);
    expect(await reason(changed)).toBe("This question has already been answered.");
    const late = await r.post(`/rule/${second}`, { option: "no-cache" });
    expect(late.status).toBe(409);
    expect(await reason(late)).toBe("This question has already been answered.");
    expect(
      r.keel
        .events()
        .filter((event) => event.type === "RulingGiven")
        .map((event) => event.payload.option),
    ).toEqual(["invalidate"]);
  });

  it("refuses a capability that has expired, was not signed here, or names a question that is not open", async () => {
    const r = rig();
    const question = openQuestion(r.keel);
    const capability = await capabilityFor(r, question);
    const forged = await mintCapability("someone else's key", {
      escalationId: question,
      expires: r.clock.now / 1000 + 600,
      nonce: "abc",
    });
    expect((await r.post(`/rule/${forged}`, { option: "invalidate" })).status).toBe(403);
    expect((await r.post("/rule/not-a-capability", { option: "invalidate" })).status).toBe(403);
    expect((await r.post(`/rule/${capability}`, {})).status).toBe(400);
    r.clock.now += 600_000;
    const expired = await r.post(`/rule/${capability}`, { option: "invalidate" });
    expect(expired.status).toBe(410);
    expect(await reason(expired)).toBe("This link has expired.");
    // None of those reached Keel.
    expect(r.keel.calls).toEqual([]);
    const elsewhere = await r.post(`/rule/${await capabilityFor(r, "esc_other")}`, {
      option: "invalidate",
    });
    expect(elsewhere.status).toBe(404);
    // Keel has no 422: its domain refuses an option the question does not have with 400 and a code.
    const unknown = await r.post(`/rule/${await capabilityFor(r, question)}`, {
      option: "flip-a-coin",
    });
    expect(unknown.status).toBe(400);
    expect(await reason(unknown)).toBe("That is not one of its options.");
    expect(r.keel.events().some((event) => event.type === "RulingGiven")).toBe(false);
  });

  it("tells Keel refusing an option apart from a request Keel could not read, whatever Keel calls the refusal", async () => {
    // The code for an option the question does not have is decided and not published yet. Neither name is leaned on.
    expect(await told("ruling-option-unknown")).toEqual([400, "That is not one of its options."]);
    expect(await told("escalation.option_unknown")).toEqual([
      400,
      "That is not one of its options.",
    ]);
    // Keel's published code for a request it could not read: that would be this Worker's fault, not the person's.
    expect(await told("request.invalid")).toEqual([502, "Keel did not take the ruling."]);
  });

  it("sends a ruling exactly as Keel's contract has the operation: the question in the path, the key in the header, the ruling as the body", async () => {
    const r = rig();
    const question = openQuestion(r.keel);
    const answer = await r.post(`/rule/${await capabilityFor(r, question)}`, {
      option: "invalidate",
      rationale: "Invalidation makes the cache safe",
      extra: "ignored",
    });
    expect(answer.status).toBe(200);
    const sent = r.keel.calls.find((call) => call.path.endsWith("/ruling"));
    expect(sent).toMatchObject({ method: "POST", path: `/v1/escalations/${question}/ruling` });
    expect(sent?.idempotencyKey).toMatch(/^console:[0-9a-f]{24}$/);
    // Nothing but the two fields of Keel's RulingRequest crosses.
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      option: "invalidate",
      rationale: "Invalidation makes the cache safe",
    });
  });
});

describe("everything else", () => {
  it("answers its health check and hands every other path to the page", async () => {
    const r = rig();
    expect(await (await r.get("/healthz")).json()).toEqual({ ok: true, service: "keel-console" });
    await r.get("/");
    await r.get("/assets/index.js");
    await r.get("/rules-of-the-road");
    expect(r.assets).toEqual(["/", "/assets/index.js", "/rules-of-the-road"]);
    expect(r.keel.calls).toEqual([]);
  });
});
