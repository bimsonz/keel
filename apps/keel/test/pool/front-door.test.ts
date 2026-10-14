import { env } from "cloudflare:workers";
import { openApiDocument } from "@keeltown/contracts";
import { agentIdOf } from "@keeltown/core/domain/identity";
import { createKeelClient, generateAgentKey, signUp } from "@keeltown/sdk";
import { sampleProjectId } from "@keeltown/testing";
import { describe, expect, it } from "vitest";
import type { DoorField, DoorStep, FrontDoor } from "../../src/adapters/driving/http/front-door.ts";
import { assertionBy, freshAddress, newKey, proofBy } from "./agent-keys.ts";
import { BASE, drainOutbox, mcp, mcpResult, worker } from "./helpers.ts";

/** The one address an arriving agent is given. The walk reads every other from an answer. */
const START = `${BASE}/start`;

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** A request from an address of its own, so the per-address limits decide nothing here. */
const fromItsOwn = (init: RequestInit = {}): RequestInit => {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", freshAddress());
  return { ...init, headers };
};

/** Keel's real Worker as a client's `fetch`. */
const keel = (url: string, init: RequestInit = {}) => worker(url, fromItsOwn(init));

/** The agent's own object flushes what sign-up committed before the file ends. */
const settled = (agentId: string) =>
  drainOutbox(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

async function doorAsJson(): Promise<FrontDoor> {
  const response = await worker(START, { headers: { accept: "application/json" } });
  expect(response.status).toBe(200);
  return response.json<FrontDoor>();
}

function stepOf(door: FrontDoor, id: string): DoorStep & { method: string; url: string } {
  const step = door.steps.find((candidate) => candidate.id === id);
  if (step?.method === undefined || step.url === undefined)
    throw new Error(`/start has no request for the step ${id}`);
  return { ...step, method: step.method, url: step.url };
}

/**
 * What a step sends, made from its fields: the page's fixed values, and the
 * walker's own under the names the page uses for them. A required field the
 * walker has nothing for stops the walk, so a page that asks for more than an
 * arriving agent holds fails here.
 */
function filled(fields: readonly DoorField[], own: Readonly<Json>): Json {
  return Object.fromEntries(
    fields.flatMap((field): [string, unknown][] => {
      const sent = (value: unknown) => (field.many === true ? [value] : value);
      if (field.name in own) return [[field.name, own[field.name]]];
      if (field.value !== undefined) return [[field.name, sent(field.value)]];
      if (field.required && field.fields !== undefined)
        return [[field.name, sent(filled(field.fields, own))]];
      if (field.required) throw new Error(`the walk has nothing to send as \`${field.name}\``);
      return [];
    }),
  );
}

interface Own {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Json>;
  /** The token, presented as its answer said to. */
  readonly presented?: Readonly<Record<string, string>>;
}

/** A step's request, as the page spells it: its method, its address, its headers and its body in the type it names. */
function send(step: ReturnType<typeof stepOf>, own: Own = {}): Promise<Response> {
  const headers = new Headers(own.presented);
  for (const [name, value] of Object.entries(filled(step.headers ?? [], own.headers ?? {})))
    headers.set(name, String(value));
  const body = step.body === undefined ? undefined : filled(step.body, own.body ?? {});
  const encoded =
    body === undefined
      ? undefined
      : step.contentType === "application/json"
        ? JSON.stringify(body)
        : new URLSearchParams(Object.entries(body).map(([name, value]) => [name, String(value)]));
  return keel(step.url, {
    method: step.method,
    headers,
    ...(encoded === undefined ? {} : { body: encoded }),
  });
}

/** A value the step says to keep, by the dotted name it gives: a name the step does not keep is not the walk's to read. */
function keptOf(step: DoorStep, answer: unknown, name: string): unknown {
  expect(step.answer?.keep.map((field) => field.name)).toContain(name);
  return name.split(".").reduce<unknown>((inner, key) => record(inner)[key], answer);
}

/** A schema of the published document with its references followed. */
function named(schema: unknown): Json {
  const own = record(schema);
  const ref = own["$ref"];
  if (typeof ref === "string")
    return named(
      ref
        .split("/")
        .slice(1)
        .reduce<unknown>((inner, key) => record(inner)[key], openApiDocument),
    );
  const [only, ...more] = list(own["allOf"]);
  return only !== undefined && more.length === 0 ? named(only) : own;
}

/** Where `value` is not what `schema` says: the rules the token models use, read off the document. */
function faults(schema: unknown, value: unknown, where = "$"): string[] {
  const rules = named(schema);
  const found: string[] = [];
  const allowed = list(rules["enum"]);
  if (allowed.length > 0 && !allowed.includes(value)) found.push(`${where}: not one of its values`);
  if (rules["type"] === "string") {
    if (typeof value !== "string") return [...found, `${where}: not a string`];
    if (typeof rules["minLength"] === "number" && value.length < rules["minLength"])
      found.push(`${where}: too short`);
    if (typeof rules["pattern"] === "string" && !new RegExp(rules["pattern"]).test(value))
      found.push(`${where}: not of its pattern`);
  }
  if (rules["type"] === "integer" && !Number.isInteger(value))
    found.push(`${where}: not an integer`);
  if (rules["type"] === "object") {
    if (typeof value !== "object" || value === null) return [...found, `${where}: not an object`];
    const held = record(value);
    const properties = record(rules["properties"]);
    for (const name of list(rules["required"]))
      if (typeof name === "string" && !(name in held)) found.push(`${where}.${name}: missing`);
    for (const [name, inner] of Object.entries(held)) {
      const property = properties[name];
      if (property === undefined) found.push(`${where}.${name}: not in the model`);
      else found.push(...faults(property, inner, `${where}.${name}`));
    }
  }
  return found;
}

/** The addresses a page of markdown links to. */
const linked = (markdown: string): string[] =>
  [...markdown.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)].flatMap(([, url]) =>
    url === undefined ? [] : [url],
  );

/** What a challenge names as the refused resource's document (RFC 9728). */
const challenged = (response: Response): string => {
  const [, url] =
    /resource_metadata="([^"]+)"/.exec(response.headers.get("www-authenticate") ?? "") ?? [];
  if (url === undefined) throw new Error("the refusal's challenge names no resource document");
  return url;
};

/** An answer's status and what its Link header names: the target and its relation. */
const linkOf = async (url: string, accept?: string) => {
  const response = await worker(url, accept === undefined ? {} : { headers: { accept } });
  const [, target, rel] =
    /^<([^>]+)>; rel="([^"]+)"$/.exec(response.headers.get("link") ?? "") ?? [];
  return [response.status, target, rel];
};

const documentAt = async (url: string): Promise<Json> => {
  const response = await worker(url);
  expect([url, response.status]).toEqual([url, 200]);
  return response.json<Json>();
};

/**
 * The published Server Card schema's rules for the fields Keel's card uses
 * (`schemas/v1/server-card.schema.json`): what is required, each field's
 * pattern and length, a remote's transport and address, and a header's shape.
 */
function cardFaults(card: Json): string[] {
  const text = (name: string, least: number, most: number, pattern?: RegExp): string[] => {
    const value = card[name];
    if (typeof value !== "string") return [`${name}: not a string`];
    if (value.length < least || value.length > most) return [`${name}: ${value.length} long`];
    return pattern === undefined || pattern.test(value) ? [] : [`${name}: not of its pattern`];
  };
  const known = new Set([
    "$schema",
    "_meta",
    "description",
    "icons",
    "name",
    "remotes",
    "repository",
    "title",
    "version",
    "websiteUrl",
  ]);
  return [
    ...Object.keys(card).flatMap((name) => (known.has(name) ? [] : [`${name}: not a card's`])),
    ...text(
      "$schema",
      1,
      200,
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/v1\/server-card\.schema\.json$/,
    ),
    ...text("name", 3, 200, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/),
    ...text("version", 0, 255),
    ...text("description", 1, 100),
    ...text("title", 1, 100),
    ...text("websiteUrl", 1, 2048, /^https:\/\/\S+$/),
    ...list(card["remotes"]).flatMap((remote, index) => {
      const { type, url, headers } = record(remote);
      return [
        ...(type === "sse" || type === "streamable-http"
          ? []
          : [`remotes.${index}.type: no transport`]),
        ...(typeof url === "string" &&
        /^(https?:\/\/[^\s]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}[^\s]*)$/.test(url)
          ? []
          : [`remotes.${index}.url: no address`]),
        ...list(headers).flatMap((header) => {
          const { name, description, isRequired, isSecret } = record(header);
          return typeof name === "string" &&
            typeof description === "string" &&
            typeof isRequired === "boolean" &&
            typeof isSecret === "boolean"
            ? []
            : [`remotes.${index}.headers: not a header's shape`];
        }),
      ];
    }),
  ];
}

/** How the MCP endpoint answers a plain bearer that asks for its tools. */
const atMcp = async (token: string) => (await mcp(token, "tools/list")).status;

describe("the front door: what an agent that knows only Keel's address is told", () => {
  it("[door.walk] an agent given only the address of /start and a key it has just made reads its way in: it signs up, is granted a token bound to its run's key and is answered as itself, taking every address, method, header and field name from the page", async () => {
    const door = await doorAsJson();
    expect(door.steps.slice(0, 4).map((step) => step.id)).toEqual([
      "key",
      "sign-up",
      "token",
      "whoami",
    ]);

    // A key the page's first step allows.
    const account = await newKey();
    const allowed = Object.fromEntries(
      (door.steps[0]?.fields ?? []).map((field) => [field.name, field.oneOf ?? []]),
    );
    expect(allowed["kty"]).toContain(account.publicJwk.kty);
    expect(allowed["crv"]).toContain(account.publicJwk.crv);

    // It signs up: the page's address and method, a proof by its key, its key in the body the page spells out.
    const signingUp = stepOf(door, "sign-up");
    const registered = await send(signingUp, {
      headers: { dpop: await proofBy(account, signingUp.method, signingUp.url) },
      body: { ...account.publicJwk, client_name: "walker" },
    });
    expect([registered.status, signingUp.answer?.status]).toEqual([201, [200, 201]]);
    const made: unknown = await registered.json();
    const agentId = String(keptOf(signingUp, made, "client_id"));
    const handle = String(keptOf(signingUp, made, "handle"));
    expect(agentId).toBe(agentIdOf(account.key.jkt));

    // It asks for a token: a request its key signs for the issuer the page names, bound to a key made for the run.
    const asking = stepOf(door, "token");
    const issuer = asking.here?.["issuer"];
    if (issuer === undefined) throw new Error("the token step names no issuer");
    const run = await newKey();
    const asked = await send(asking, {
      headers: { dpop: await proofBy(run, asking.method, asking.url) },
      body: { client_assertion: await assertionBy(account, agentId, { audience: issuer }) },
    });
    expect(asked.status).toBe(200);
    const grant: unknown = await asked.json();
    const token = String(keptOf(asking, grant, "access_token"));
    const scheme = String(keptOf(asking, grant, "token_type"));
    expect([scheme, keptOf(asking, grant, "expires_in")]).toEqual(["DPoP", 300]);

    // It presents the token as the answer's `token_type` says, and is answered as itself.
    const reading = stepOf(door, "whoami");
    expect(reading.token).toBe("required");
    const answered = await send(reading, {
      presented: {
        authorization: `${scheme} ${token}`,
        dpop: await proofBy(run, reading.method, reading.url, { accessToken: token }),
      },
    });
    expect(answered.status).toBe(200);
    const me: unknown = await answered.json();
    expect([
      keptOf(reading, me, "result.agent.id"),
      keptOf(reading, me, "result.agent.handle"),
    ]).toEqual([agentId, handle]);
    // The same request with no token is refused: the answer above was the token's doing.
    expect((await send(reading)).status).toBe(401);
    await settled(agentId);
  });

  it("[door.token-spec] the token request the SDK really sends is the spec's AgentTokenRequest, Keel's real answers to it are the spec's AgentTokenResponse, and the security scheme's address is the one the metadata names", async () => {
    const { schemas, securitySchemes } = openApiDocument.components;
    const tokenUrl = `${BASE}${securitySchemes.OAuth2Auth.flows.clientCredentials.tokenUrl}`;
    const metadata = await documentAt(`${BASE}/.well-known/oauth-authorization-server`);
    expect(metadata["token_endpoint"]).toBe(tokenUrl);

    const exchanges: { sent: Record<string, string>; proved: boolean; answer: Json }[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      const response = await keel(url, init);
      if (url === tokenUrl)
        exchanges.push({
          sent: Object.fromEntries(
            new URLSearchParams(typeof init.body === "string" ? init.body : ""),
          ),
          proved: new Headers(init.headers).has("dpop"),
          answer: await response.clone().json<Json>(),
        });
      return response;
    };
    const { signer } = await generateAgentKey();
    const { agentId } = await signUp({ baseUrl: BASE, signer, fetch });
    const held = { baseUrl: BASE, agentId, key: signer, fetch };
    // Every field the SDK can send, for a token bound to a run's key; then the least it sends, for a plain bearer.
    await createKeelClient({
      ...held,
      project: sampleProjectId,
      run: "door",
      scopes: ["agent:read"],
      resource: BASE,
    }).token();
    await createKeelClient({ ...held, bound: false }).token();
    const [whole, least] = exchanges;
    if (whole === undefined || least === undefined) throw new Error("the SDK asked for no token");
    expect(exchanges).toHaveLength(2);
    expect(Object.keys(whole.sent).toSorted()).toEqual(
      Object.keys(schemas.AgentTokenRequest.properties).toSorted(),
    );
    for (const exchange of exchanges) {
      expect(faults(schemas.AgentTokenRequest, exchange.sent)).toEqual([]);
      expect(faults(schemas.AgentTokenResponse, exchange.answer)).toEqual([]);
    }
    expect(exchanges.map((exchange) => [exchange.proved, exchange.answer["token_type"]])).toEqual([
      [true, "DPoP"],
      [false, "Bearer"],
    ]);
    // The model refuses what is no such request or answer: a secret, a request nothing signed, a token of another kind.
    const { client_assertion: signedRequest, ...unsigned } = least.sent;
    expect(signedRequest).toBeDefined();
    expect(faults(schemas.AgentTokenRequest, unsigned)).toEqual(["$.client_assertion: missing"]);
    expect(faults(schemas.AgentTokenRequest, { ...least.sent, client_secret: "s" })).toEqual([
      "$.client_secret: not in the model",
    ]);
    expect(faults(schemas.AgentTokenRequest, { ...whole.sent, run: "Not A Label" })).toEqual([
      "$.run: not of its pattern",
    ]);
    expect(faults(schemas.AgentTokenResponse, { ...least.answer, token_type: "MAC" })).toEqual([
      "$.token_type: not one of its values",
    ]);
    await settled(agentId);
  });

  it("[door.found] a refusal leads to the walk in two reads, by either door; the authorization server's document names it too; /start answers as markdown, as plain text and as JSON; and the catalogue, the index and the card name only what answers", async () => {
    // A bare request is refused with a challenge naming the resource's document, and that names the walk.
    const refused = await worker(`${BASE}/v1/agents/me`);
    const refusedAtMcp = await mcp(null, "tools/list");
    expect([refused.status, refusedAtMcp.status]).toEqual([401, 401]);
    const resource = await documentAt(challenged(refused));
    const mcpResource = await documentAt(challenged(refusedAtMcp));
    expect([resource["resource"], mcpResource["resource"]]).toEqual([BASE, `${BASE}/mcp`]);
    expect([resource["resource_documentation"], mcpResource["resource_documentation"]]).toEqual([
      START,
      START,
    ]);
    // The server that issues the resource's tokens says the same, at the well-known place its issuer gives.
    const [issuer] = list(resource["authorization_servers"]);
    const { origin, pathname } = new URL(String(issuer));
    const server = await documentAt(`${origin}/.well-known/oauth-authorization-server${pathname}`);
    expect(server["service_documentation"]).toBe(START);

    // The walk itself, in the three ways it is asked for.
    const asked = async (accept?: string) => {
      const response = await worker(START, accept === undefined ? {} : { headers: { accept } });
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        cache: response.headers.get("cache-control"),
        body: await response.text(),
      };
    };
    const [plain, markdown, json] = [
      await asked(),
      await asked("text/markdown"),
      await asked("application/json"),
    ];
    expect([plain, markdown, json].map((answer) => [answer.status, answer.cache])).toEqual(
      Array.from({ length: 3 }, () => [200, "public, max-age=300"]),
    );
    expect([plain.type, markdown.type, json.type]).toEqual([
      "text/plain; charset=utf-8",
      "text/markdown; charset=utf-8",
      "application/json",
    ]);
    expect(plain.body).toBe(markdown.body);
    expect(plain.body.startsWith(`# ${openApiDocument.info.title}\n`)).toBe(true);
    const door: FrontDoor = JSON.parse(json.body);
    expect(door.start).toBe(START);
    // Every address the page links to, and every document it lists, answers.
    const everyNamed = [...new Set([...linked(plain.body), ...door.documents.map((d) => d.url)])];
    expect(everyNamed.length).toBeGreaterThanOrEqual(door.documents.length);
    expect(door.documents.length).toBeGreaterThan(5);
    for (const url of everyNamed) expect([url, (await worker(url)).status]).toEqual([url, 200]);

    // The index: a title, a paragraph and the same list, each link answering.
    const index = await worker(`${BASE}/llms.txt`);
    expect([index.status, index.headers.get("content-type")]).toEqual([
      200,
      "text/plain; charset=utf-8",
    ]);
    const indexed = linked(await index.text());
    expect(indexed).toEqual(door.documents.map((d) => d.url));
    expect(indexed).toContain(START);

    // The catalogue (RFC 9727): a linkset of the API and the MCP endpoint, each described by what answers.
    const catalogue = await worker(`${BASE}/.well-known/api-catalog`);
    expect([catalogue.status, catalogue.headers.get("content-type")]).toEqual([
      200,
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    ]);
    const linkset = list(record(await catalogue.json<unknown>())["linkset"]).map(record);
    expect(linkset.map((entry) => entry["anchor"])).toEqual([`${BASE}/v1`, `${BASE}/mcp`]);
    const described = linkset.flatMap((entry) =>
      ["service-desc", "service-doc"].flatMap((rel) =>
        list(entry[rel]).map((target) => String(record(target)["href"])),
      ),
    );
    expect(described).toEqual([`${BASE}/v1/openapi.json`, START, `${BASE}/mcp/server-card`, START]);
    for (const url of described) expect([url, (await worker(url)).status]).toEqual([url, 200]);

    // The card: the same bytes at both places, valid by its published schema, naming the endpoint that answers.
    const cards = await Promise.all(
      ["/mcp/server-card", "/.well-known/mcp/server-card.json"].map(async (path) => {
        const response = await worker(`${BASE}${path}`);
        return [response.status, await response.text()] as const;
      }),
    );
    expect(cards.map(([status]) => status)).toEqual([200, 200]);
    expect(cards[0]?.[1]).toBe(cards[1]?.[1]);
    const card = record(JSON.parse(cards[0]?.[1] ?? "null"));
    expect(cardFaults(card)).toEqual([]);
    expect(cardFaults({ ...card, name: "keel" })).toEqual(["name: not of its pattern"]);
    expect(cardFaults({ ...card, tools: [] })).toEqual(["tools: not a card's"]);
    expect([card["version"], card["websiteUrl"]]).toEqual([openApiDocument.info.version, START]);
    const [remote] = list(card["remotes"]).map(record);
    expect([remote?.["type"], remote?.["url"]]).toEqual(["streamable-http", door.mcp.endpoint]);
    expect(door.mcp.endpoint).toBe(mcpResource["resource"]);
  });

  it("[door.version] the published document carries a release's version, and the walk, the MCP server as it answers server/discover and its card at both places say that same one", async () => {
    const published = await documentAt(`${BASE}/v1/openapi.json`);
    const version = record(published["info"])["version"];
    // A release's number: three parts, and not the one a document is given when it declares none.
    expect(String(version)).toMatch(/^(?!0\.0\.0$)\d+\.\d+\.\d+$/);

    const door = await doorAsJson();
    const { signer } = await generateAgentKey();
    const { agentId } = await signUp({ baseUrl: BASE, signer, fetch: keel });
    const token = await createKeelClient({
      baseUrl: BASE,
      agentId,
      key: signer,
      bound: false,
      fetch: keel,
      resource: door.mcp.resource,
    }).token();
    // The current revision has no handshake: a server names itself in the `_meta` of its answers.
    const discovered = await mcpResult(await mcp(token, "server/discover"));
    const server = record(record(discovered["_meta"])["io.modelcontextprotocol/serverInfo"]);
    const cards = await Promise.all(
      ["/mcp/server-card", "/.well-known/mcp/server-card.json"].map(
        async (path) => (await documentAt(`${BASE}${path}`))["version"],
      ),
    );
    expect({
      walk: door.version,
      server: [server["name"], server["version"]],
      cards,
    }).toEqual({ walk: version, server: ["keel", version], cards: [version, version] });
    await settled(agentId);
  });

  it("[door.instructions] the MCP server tells every agent that connects, whatever its harness, to ask `why` before it changes a file", async () => {
    const door = await doorAsJson();
    const { signer } = await generateAgentKey();
    const { agentId } = await signUp({ baseUrl: BASE, signer, fetch: keel });
    const token = await createKeelClient({
      baseUrl: BASE,
      agentId,
      key: signer,
      bound: false,
      fetch: keel,
      resource: door.mcp.resource,
    }).token();
    const discovered = await mcpResult(await mcp(token, "server/discover"));
    expect(String(discovered["instructions"])).toContain(
      "Before you change a file, ask `why` about it",
    );
    await settled(agentId);
  });

  it("[door.link] the walk, in each of the three ways it is asked for, and the index name the catalogue in a Link header of their answer (RFC 9727), and the address the header gives is the catalogue's", async () => {
    const catalogue = `${BASE}/.well-known/api-catalog`;
    expect([
      await linkOf(START),
      await linkOf(START, "text/markdown"),
      await linkOf(START, "application/json"),
      await linkOf(`${BASE}/llms.txt`),
    ]).toEqual(Array.from({ length: 4 }, () => [200, catalogue, "api-catalog"]));
    const linkset = await worker(catalogue);
    expect([linkset.status, linkset.headers.get("content-type")]).toEqual([
      200,
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    ]);
  });

  it("[door.mcp-token] the token the SDK asks for by the MCP door's name, as the page gives it, is taken at /mcp and refused at the API; one asked for by no name is the API's, and /mcp refuses it", async () => {
    const door = await doorAsJson();
    const { signer } = await generateAgentKey();
    const { agentId } = await signUp({ baseUrl: BASE, signer, fetch: keel });
    const held = { baseUrl: BASE, agentId, key: signer, bound: false, fetch: keel };
    const forMcp = await createKeelClient({ ...held, resource: door.mcp.resource }).token();
    const forApi = await createKeelClient(held).token();
    const atApi = async (token: string) =>
      (await keel(`${BASE}/v1/agents/me`, { headers: { authorization: `Bearer ${token}` } }))
        .status;
    expect([await atMcp(forMcp), await atMcp(forApi)]).toEqual([200, 401]);
    expect([await atApi(forApi), await atApi(forMcp)]).toEqual([200, 401]);
    await settled(agentId);
  });
});
