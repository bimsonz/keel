import { openApiDocument } from "@keeltown/contracts";
import type { Hono } from "hono";
import type { AppEnv } from "../../../generated/http/runtime.gen.ts";

/**
 * The front door: what Keel tells an agent that arrives knowing only its
 * address. Every method, path, field name, fixed value and sentence of
 * description is read from the published document, so the page cannot say
 * what the API does not do. What is kept by hand is `WALK`: the order of the
 * steps, the values each answer hands to the next, and the titles of the
 * steps that are no operation (a key, the token request, a push).
 */

/** Where the walk is served, and what the discovery documents name as their documentation. */
export const START_PATH = "/start";
export const LLMS_PATH = "/llms.txt";
/** RFC 9727. */
export const CATALOG_PATH = "/.well-known/api-catalog";
/** The card's recommended place, beside the endpoint, and the older well-known one a scanner asks at. */
export const CARD_PATHS = ["/mcp/server-card", "/.well-known/mcp/server-card.json"] as const;

const DOCUMENT_PATH = "/v1/openapi.json";
const AUTHORIZATION_SERVER = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";
const SIGNERS_PATH = "/.well-known/keel/allowed-signers";
const MCP_PATH = "/mcp";
const CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";

type Json = Readonly<Record<string, unknown>>;

const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const texts = (value: unknown): readonly string[] =>
  list(value).flatMap((item) => (typeof item === "string" ? [item] : []));
const at = (value: unknown, ...path: readonly string[]): unknown =>
  path.reduce<unknown>((inner, key) => record(inner)[key], value);
/** The spec's comments are wrapped; a sentence here is one line. */
const flat = (words: string): string => words.replace(/\s+/g, " ").trim();

/** A schema as it reads with its references followed. Words written beside a reference win over the referenced schema's own. */
function resolve(document: unknown, schema: unknown): Json {
  const own = record(schema);
  const ref = text(own["$ref"]);
  const parts = [
    ...(ref === undefined ? [] : [at(document, ...ref.split("/").slice(1))]),
    ...list(own["allOf"]),
  ].map((part) => resolve(document, part));
  if (parts.length === 0) return own;
  const rest = Object.fromEntries(
    Object.entries(own).filter(([key]) => key !== "$ref" && key !== "allOf"),
  );
  return [...parts, rest].reduce<Json>(
    (whole, part) => ({
      ...whole,
      ...part,
      properties: { ...record(whole["properties"]), ...record(part["properties"]) },
      required: [...list(whole["required"]), ...list(part["required"])],
    }),
    {},
  );
}

/** One thing a request sends or an answer holds, as the document describes it. */
export interface DoorField {
  readonly name: string;
  readonly required: boolean;
  /** The one value the document allows. */
  readonly value?: string;
  /** The values the document allows, when it lists more than one. */
  readonly oneOf?: readonly string[];
  readonly pattern?: string;
  readonly say?: string;
  /** A list of these. */
  readonly many?: true;
  /** Its own fields, when it is an object or a list of objects. */
  readonly fields?: readonly DoorField[];
  /** The shapes it may take, when the document gives a choice of objects. */
  readonly shapes?: readonly (readonly DoorField[])[];
}

function fieldOf(
  document: unknown,
  name: string,
  schema: unknown,
  required: boolean,
  depth: number,
): DoorField {
  const outer = resolve(document, schema);
  const many = outer["type"] === "array";
  const inner = many ? resolve(document, outer["items"]) : outer;
  const say = text(outer["description"]) ?? text(inner["description"]);
  const values = texts(inner["enum"]);
  const pattern = text(inner["pattern"]);
  const fields = depth > 0 ? fieldsOf(document, inner, depth - 1) : [];
  const shapes = depth > 0 ? [...list(inner["anyOf"]), ...list(inner["oneOf"])] : [];
  const [only] = values;
  return {
    name,
    required,
    ...(values.length === 1 && only !== undefined ? { value: only } : {}),
    ...(values.length > 1 ? { oneOf: values } : {}),
    ...(pattern === undefined ? {} : { pattern }),
    ...(say === undefined ? {} : { say: flat(say) }),
    ...(many ? { many: true as const } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(shapes.length > 0
      ? { shapes: shapes.map((shape) => fieldsOf(document, shape, depth - 1)) }
      : {}),
  };
}

function fieldsOf(document: unknown, schema: unknown, depth: number): readonly DoorField[] {
  const whole = resolve(document, schema);
  const required = new Set(texts(whole["required"]));
  return Object.entries(record(whole["properties"])).map(([name, property]) =>
    fieldOf(document, name, property, required.has(name), depth),
  );
}

/** One field of an answer, by its dotted path: a path the document does not hold is a fault in `WALK`. */
function kept(document: unknown, schema: unknown, path: string, from: string): DoorField {
  const leaf = path.split(".").reduce<{ readonly schema: unknown; readonly required: boolean }>(
    (inner, key) => {
      const whole = resolve(document, inner.schema);
      const property = record(whole["properties"])[key];
      if (property === undefined) throw new Error(`${from} answers no \`${path}\``);
      return { schema: property, required: texts(whole["required"]).includes(key) };
    },
    { schema, required: true },
  );
  return fieldOf(document, path, leaf.schema, leaf.required, 0);
}

function model(document: unknown, name: string): Json {
  const schema = at(document, "components", "schemas", name);
  if (schema === undefined) throw new Error(`the published document has no model ${name}`);
  return record(schema);
}

interface Operation {
  readonly method: string;
  readonly path: string;
  readonly operation: Json;
}

function operationOf(document: unknown, operationId: string): Operation {
  for (const [path, item] of Object.entries(record(at(document, "paths"))))
    for (const [method, operation] of Object.entries(record(item)))
      if (at(operation, "operationId") === operationId)
        return { method: method.toUpperCase(), path, operation: record(operation) };
  throw new Error(`the published document has no operation ${operationId}`);
}

/** One step of the walk. */
export interface DoorStep {
  readonly id: string;
  readonly title: string;
  readonly say?: string;
  /** The operation this step is, in `/v1/openapi.json`; absent for a step that is none. */
  readonly operationId?: string;
  readonly method?: string;
  readonly url?: string;
  /** Whether the request carries a token, and the scopes that token needs. */
  readonly token?: "required" | "optional";
  readonly scopes?: readonly string[];
  readonly contentType?: string;
  readonly headers?: readonly DoorField[];
  readonly query?: readonly DoorField[];
  readonly body?: readonly DoorField[];
  /** What a step that sends nothing is about: a key's members, a workspace's. */
  readonly fields?: readonly DoorField[];
  /** The statuses that mean it worked, and what to keep from the answer for the steps after. */
  readonly answer?: { readonly status: readonly number[]; readonly keep: readonly DoorField[] };
  /** Values this instance fixes, by the name the step's words use for them. */
  readonly here?: Readonly<Record<string, string>>;
}

interface Asked {
  readonly id: string;
  /** How deep the request body's fields are spelled out; the document has the rest. */
  readonly depth: number;
  readonly keep: readonly string[];
}

function operationStep(
  document: unknown,
  api: string,
  operationId: string,
  asked: Asked,
): DoorStep {
  const { method, path, operation } = operationOf(document, operationId);
  const parameters = list(operation["parameters"]).map((parameter) => resolve(document, parameter));
  const sent = (where: string): readonly DoorField[] =>
    parameters
      .filter((parameter) => parameter["in"] === where)
      .map((parameter) =>
        fieldOf(
          document,
          String(parameter["name"]),
          { ...record(parameter["schema"]), description: parameter["description"] },
          parameter["required"] === true,
          0,
        ),
      );
  const [media] = Object.entries(record(at(operation, "requestBody", "content")));
  const requirements = list(operation["security"]).map((requirement) => record(requirement));
  const open = requirements.filter((requirement) => Object.keys(requirement).length === 0);
  const scopes = [
    ...new Set(requirements.flatMap((requirement) => Object.values(requirement).flatMap(texts))),
  ];
  const worked = Object.entries(record(operation["responses"])).filter(([status]) =>
    status.startsWith("2"),
  );
  const [first] = worked;
  const answered = at(first?.[1], "content", "application/json", "schema");
  const say = text(operation["description"]);
  const headers = [
    ...(media === undefined ? [] : [{ name: "content-type", required: true, value: media[0] }]),
    ...sent("header"),
  ];
  const query = sent("query");
  return {
    id: asked.id,
    title: text(operation["summary"]) ?? operationId,
    ...(say === undefined ? {} : { say: flat(say) }),
    operationId,
    method,
    url: `${api}${path}`,
    ...(requirements.length === open.length
      ? {}
      : { token: open.length === 0 ? ("required" as const) : ("optional" as const) }),
    ...(scopes.length === 0 ? {} : { scopes }),
    ...(media === undefined ? {} : { contentType: media[0] }),
    ...(headers.length === 0 ? {} : { headers }),
    ...(query.length === 0 ? {} : { query }),
    ...(media === undefined
      ? {}
      : { body: fieldsOf(document, at(media[1], "schema"), asked.depth) }),
    answer: {
      status: worked.map(([status]) => Number(status)),
      keep: asked.keep.map((name) => kept(document, answered, name, operationId)),
    },
  };
}

/**
 * The walk, in order. An operation is named by its id; `keep` is what its
 * answer hands to a later step. The three models are the steps no operation
 * covers: the key an agent makes before it has sent anything, the token
 * request (the provider's endpoint, whose fields the spec states as a model),
 * and the push, which is git's.
 */
export const WALK = [
  { id: "key", title: "Make a key", model: "RegistrationJwk" },
  { id: "sign-up", operationId: "Auth_registerClient", depth: 3, keep: ["client_id", "handle"] },
  { id: "token", title: "Ask for a token", model: "AgentTokenRequest" },
  {
    id: "whoami",
    operationId: "whoami",
    depth: 0,
    keep: ["result.agent.id", "result.agent.handle"],
  },
  { id: "project", operationId: "Operator_createProject", depth: 2, keep: ["id"] },
  {
    id: "work-token",
    title: "Ask for a token that names the project and a run",
    model: "AgentTokenRequest",
    only: ["project", "run"],
  },
  {
    id: "declare",
    operationId: "declare",
    depth: 1,
    keep: [
      "result.change.id",
      "result.lease.id",
      "result.workspace.remote",
      "result.workspace.token",
    ],
  },
  { id: "push", title: "Commit in the workspace and push", model: "Workspace" },
  { id: "submit", operationId: "submit", depth: 1, keep: ["result.state"] },
  { id: "status", operationId: "status", depth: 0, keep: ["result.state", "result.verdict"] },
] as const;

/** What the token request's answer hands on: the token, how it is presented, and how long it lasts. */
const TOKEN_KEEPS = ["access_token", "token_type", "expires_in"] as const;
const TOKEN_ANSWER = "AgentTokenResponse";

export interface DoorDocument {
  readonly rel: string;
  readonly title: string;
  readonly url: string;
  readonly type: string;
}

export interface DoorTool {
  /** The tool's name over MCP, and the operation's id over HTTP. */
  readonly name: string;
  readonly title: string;
  readonly method: string;
  readonly url: string;
}

/** The whole door: `/start` as JSON, and what the catalogue, the card and the index are made from. */
export interface FrontDoor {
  readonly name: string;
  readonly version: string;
  readonly about: string;
  readonly origin: string;
  readonly start: string;
  readonly steps: readonly DoorStep[];
  readonly mcp: {
    readonly endpoint: string;
    /** What a token request names as `resource` to get a token this endpoint takes. */
    readonly resource: string;
    readonly metadata: string;
    readonly card: string;
    readonly tools: readonly DoorTool[];
  };
  readonly documents: readonly DoorDocument[];
}

export interface DoorPlace {
  /** `https://<KEEL_HOST>`. */
  readonly origin: string;
  /** The path of Keel's authorization server under the origin. */
  readonly issuerPath: string;
}

/** The door, from the published document and where this instance is. Pure: the same document and place give the same door. */
export function frontDoor(document: unknown, where: DoorPlace): FrontDoor {
  const { origin } = where;
  const api = `${origin}${text(at(list(at(document, "servers"))[0], "url")) ?? ""}`;
  const tokenUrl = text(
    at(
      document,
      "components",
      "securitySchemes",
      "OAuth2Auth",
      "flows",
      "clientCredentials",
      "tokenUrl",
    ),
  );
  if (tokenUrl === undefined) throw new Error("the published document names no token endpoint");
  const tokenStep = (
    id: string,
    title: string,
    name: string,
    only?: readonly string[],
  ): DoorStep => {
    const request = model(document, name);
    const say = text(request["description"]);
    const body = fieldsOf(document, request, 0);
    const answer = model(document, TOKEN_ANSWER);
    for (const field of only ?? [])
      if (!body.some((sent) => sent.name === field))
        throw new Error(`${name} has no field \`${field}\``);
    return {
      id,
      title,
      ...(say === undefined || only !== undefined ? {} : { say: flat(say) }),
      method: "POST",
      url: `${origin}${tokenUrl}`,
      contentType: "application/x-www-form-urlencoded",
      headers: [
        { name: "content-type", required: true, value: "application/x-www-form-urlencoded" },
        { name: "dpop", required: false },
      ],
      body: only === undefined ? body : body.filter((sent) => only.includes(sent.name)),
      answer: {
        status: [200],
        keep: TOKEN_KEEPS.map((path) => kept(document, answer, path, TOKEN_ANSWER)),
      },
      here: {
        issuer: `${origin}${where.issuerPath}`,
        metadata: `${origin}${AUTHORIZATION_SERVER}`,
      },
    };
  };
  const steps = WALK.map((entry): DoorStep => {
    if ("operationId" in entry) return operationStep(document, api, entry.operationId, entry);
    if (entry.model === "AgentTokenRequest")
      return tokenStep(
        entry.id,
        entry.title,
        entry.model,
        "only" in entry ? entry.only : undefined,
      );
    const described = model(document, entry.model);
    const say = text(described["description"]);
    return {
      id: entry.id,
      title: entry.title,
      ...(say === undefined ? {} : { say: flat(say) }),
      fields: fieldsOf(document, described, 0),
    };
  });
  const tools = Object.entries(record(at(document, "paths"))).flatMap(([path, item]) =>
    Object.entries(record(item)).flatMap(([method, operation]): DoorTool[] => {
      const name = text(at(operation, "operationId"));
      if (name === undefined || !texts(at(operation, "tags")).includes("mcp")) return [];
      return [
        {
          name,
          title: text(at(operation, "summary")) ?? name,
          method: method.toUpperCase(),
          url: `${api}${path}`,
        },
      ];
    }),
  );
  const [card] = CARD_PATHS;
  return {
    name: text(at(document, "info", "title")) ?? "",
    version: text(at(document, "info", "version")) ?? "",
    about: flat(text(at(document, "info", "description")) ?? ""),
    origin,
    start: `${origin}${START_PATH}`,
    steps,
    mcp: {
      endpoint: `${origin}${MCP_PATH}`,
      resource: `${origin}${MCP_PATH}`,
      metadata: `${origin}${PROTECTED_RESOURCE}${MCP_PATH}`,
      card: `${origin}${card}`,
      tools,
    },
    documents: [
      {
        rel: "service-doc",
        title: "The walk: from a key to a token and a first change",
        url: `${origin}${START_PATH}`,
        type: "text/markdown",
      },
      {
        rel: "service-desc",
        title: "The API, as OpenAPI",
        url: `${origin}${DOCUMENT_PATH}`,
        type: "application/json",
      },
      {
        rel: "oauth-authorization-server",
        title: "Where to sign up and ask for a token (RFC 8414)",
        url: `${origin}${AUTHORIZATION_SERVER}`,
        type: "application/json",
      },
      {
        rel: "oauth-protected-resource",
        title: "How the API takes a token (RFC 9728)",
        url: `${origin}${PROTECTED_RESOURCE}`,
        type: "application/json",
      },
      {
        rel: "oauth-protected-resource",
        title: "How the MCP endpoint takes a token (RFC 9728)",
        url: `${origin}${PROTECTED_RESOURCE}${MCP_PATH}`,
        type: "application/json",
      },
      {
        rel: "mcp-server-card",
        title: "The MCP server's card",
        url: `${origin}${card}`,
        type: "application/json",
      },
      {
        rel: "api-catalog",
        title: "The catalogue of these, as a linkset (RFC 9727)",
        url: `${origin}${CATALOG_PATH}`,
        type: "application/linkset+json",
      },
      {
        rel: "allowed-signers",
        title: "The keys Keel signs trunk's commits with, for git verify-commit",
        url: `${origin}${SIGNERS_PATH}`,
        type: "text/plain",
      },
    ],
  };
}

function fieldLines(fields: readonly DoorField[], indent: string): string[] {
  return fields.flatMap((field) => {
    const allowed =
      field.value !== undefined
        ? `: \`${field.value}\``
        : field.oneOf !== undefined
          ? `: ${field.oneOf.map((value) => `\`${value}\``).join(" or ")}`
          : "";
    const marks = [...(field.required ? ["required"] : []), ...(field.many ? ["a list"] : [])];
    return [
      `${indent}- \`${field.name}\`${marks.length === 0 ? "" : ` (${marks.join(", ")})`}${allowed}${field.say === undefined ? "" : `. ${field.say}`}`,
      ...fieldLines(field.fields ?? [], `${indent}  `),
      ...(field.shapes ?? []).flatMap((shape, index) => [
        `${indent}  - shape ${index + 1}:`,
        ...fieldLines(shape, `${indent}    `),
      ]),
    ];
  });
}

const part = (title: string, fields: readonly DoorField[] | undefined): string[] =>
  fields === undefined || fields.length === 0
    ? []
    : ["", `${title}:`, "", ...fieldLines(fields, "")];

function stepLines(step: DoorStep, index: number): string[] {
  return [
    `## ${index + 1}. ${step.title}`,
    "",
    ...(step.method === undefined || step.url === undefined
      ? []
      : [`\`${step.method} ${step.url}\``, ""]),
    ...(step.say === undefined ? [] : [step.say]),
    ...(step.token === undefined
      ? []
      : [
          "",
          `Token: ${step.token}${step.scopes === undefined ? "" : `, with scope ${step.scopes.map((scope) => `\`${scope}\``).join(" or ")}`}.`,
        ]),
    ...(step.here === undefined ? [] : [""]),
    ...Object.entries(step.here ?? {}).map(([name, value]) => `- ${name} here: \`${value}\``),
    ...part("Fields", step.fields),
    ...part("Headers", step.headers),
    ...part("Query", step.query),
    ...part(`Body (\`${step.contentType ?? ""}\`)`, step.body),
    ...(step.answer === undefined
      ? []
      : part(`Answers ${step.answer.status.join(" or ")}; keep`, step.answer.keep)),
    "",
  ];
}

/** `/start` as markdown: the same steps as its JSON, in the same order. */
export function startMarkdown(door: FrontDoor): string {
  return [
    `# ${door.name}`,
    "",
    door.about,
    "",
    `Every address, method and field below is read from ${door.origin}${DOCUMENT_PATH}. The same steps as JSON: ask for \`${door.start}\` with \`Accept: application/json\`.`,
    "",
    ...door.steps.flatMap(stepLines),
    "## MCP",
    "",
    `- endpoint: \`${door.mcp.endpoint}\``,
    `- token: one asked for with \`resource\` \`${door.mcp.resource}\``,
    `- how it takes a token: ${door.mcp.metadata}`,
    `- card: ${door.mcp.card}`,
    "",
    "Each tool is also an operation of the API:",
    "",
    ...door.mcp.tools.map(
      (tool) => `- \`${tool.name}\`: ${tool.title} (\`${tool.method} ${tool.url}\`)`,
    ),
    "",
    "## The rest",
    "",
    ...door.documents.map((document) => `- [${document.title}](${document.url})`),
    "",
  ].join("\n");
}

/** `/llms.txt`: an index and nothing more. */
export function llmsText(door: FrontDoor): string {
  return [
    `# ${door.name}`,
    "",
    `> ${door.about}`,
    "",
    "## Start",
    "",
    ...door.documents.map((document) => `- [${document.title}](${document.url})`),
    "",
  ].join("\n");
}

/** RFC 9727's catalogue, as a linkset (RFC 9264): the API and the MCP endpoint, each with what describes it. */
export function apiCatalog(door: FrontDoor): unknown {
  const linked = (rel: string) =>
    door.documents
      .filter((document) => document.rel === rel)
      .map((document) => ({ href: document.url, type: document.type }));
  return {
    linkset: [
      {
        anchor: `${door.origin}/v1`,
        "service-desc": linked("service-desc"),
        "service-doc": linked("service-doc"),
      },
      {
        anchor: door.mcp.endpoint,
        "service-desc": linked("mcp-server-card"),
        "service-doc": linked("service-doc"),
      },
    ],
  };
}

/** The first sentence of what Keel is: a card's description is at most 100 characters. */
const firstSentence = (words: string): string => {
  const end = words.indexOf(". ");
  return (end === -1 ? words : words.slice(0, end + 1)).slice(0, 100);
};

/**
 * The MCP server's card: its name under this host, its version, where it
 * answers and how its token is come by. It lists no tools: a client asks the
 * server for those.
 */
export function serverCard(door: FrontDoor): unknown {
  const host = new URL(door.origin).hostname;
  return {
    $schema: CARD_SCHEMA,
    name: `${host.split(".").toReversed().join(".")}/${door.name.toLowerCase()}`,
    version: door.version,
    title: door.name,
    description: firstSentence(door.about),
    websiteUrl: door.start,
    remotes: [
      {
        type: "streamable-http",
        url: door.mcp.endpoint,
        headers: [
          {
            name: "Authorization",
            description: `A token asked for with \`resource\` ${door.mcp.resource}, as ${door.mcp.metadata} and ${door.start} say: \`DPoP <token>\` with a proof, or \`Bearer <token>\`.`,
            isRequired: true,
            isSecret: true,
          },
        ],
      },
    ],
  };
}

/** The documents change only with a deploy; a reader may keep one for five minutes. */
const CACHED = { "cache-control": "public, max-age=300" };

/**
 * The door's routes. `/start` answers JSON to a reader that asks for it and
 * markdown to every other, as `text/plain` unless markdown was asked for, so a
 * browser shows it.
 */
export function registerFrontDoor(app: Hono<AppEnv>, where: DoorPlace): void {
  let made: FrontDoor | undefined;
  const door = (): FrontDoor => (made ??= frontDoor(openApiDocument, where));
  app.get(START_PATH, (c) => {
    const accept = c.req.header("accept") ?? "";
    const headers = { ...CACHED, vary: "accept" };
    if (accept.includes("application/json")) return Response.json(door(), { headers });
    const type = accept.includes("text/markdown") ? "text/markdown" : "text/plain";
    return new Response(startMarkdown(door()), {
      headers: { ...headers, "content-type": `${type}; charset=utf-8` },
    });
  });
  app.get(
    LLMS_PATH,
    () =>
      new Response(llmsText(door()), {
        headers: { ...CACHED, "content-type": "text/plain; charset=utf-8" },
      }),
  );
  app.get(CATALOG_PATH, () =>
    Response.json(apiCatalog(door()), {
      headers: {
        ...CACHED,
        "content-type":
          'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
      },
    }),
  );
  for (const path of CARD_PATHS)
    app.get(path, () => Response.json(serverCard(door()), { headers: CACHED }));
}
