import { openApiDocument } from "@keeltown/contracts";
import { describe, expect, it } from "vitest";
import {
  type DoorStep,
  frontDoor,
  startMarkdown,
  WALK,
} from "../../src/adapters/driving/http/front-door.ts";

const ORIGIN = "https://keel.test";
const PLACE = { origin: ORIGIN, issuerPath: "/v1/auth" };
const door = frontDoor(openApiDocument, PLACE);

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((inner, key) => record(inner)[key], value);
const flat = (said: unknown): string => String(said).replace(/\s+/g, " ").trim();
/** A description as the door says it: one line, or nothing where the document says nothing. */
const words = (said: unknown): string | undefined => (said === undefined ? undefined : flat(said));

/** The schema a reference names, read the long way round: by its path in the document. */
const named = (schema: unknown): Json => {
  const ref = at(schema, "$ref");
  return typeof ref === "string"
    ? named(at(openApiDocument, ...ref.split("/").slice(1)))
    : record(schema);
};

/** The document's own operation, found by walking its paths here and not by the code under test. */
function published(operationId: string) {
  for (const [path, item] of Object.entries(openApiDocument.paths))
    for (const [method, operation] of Object.entries(item))
      if (at(operation, "operationId") === operationId)
        return { method: method.toUpperCase(), path, operation: record(operation) };
  throw new Error(`no operation ${operationId}`);
}

const stepOf = (id: string): DoorStep => {
  const step = door.steps.find((candidate) => candidate.id === id);
  if (step === undefined) throw new Error(`the door has no step ${id}`);
  return step;
};
const names = (fields: DoorStep["body"]) => (fields ?? []).map((field) => field.name);

/** The document with one thing taken out, as a spec that had moved under the walk would read. */
const without = (...path: string[]): unknown => {
  const copy: unknown = structuredClone(openApiDocument);
  const last = path.at(-1);
  if (last !== undefined) Reflect.deleteProperty(Object(at(copy, ...path.slice(0, -1))), last);
  return copy;
};

describe("the front door is read from the published document", () => {
  it("[door.from-spec] every step that is an operation says that operation's method, address, summary and words, sends the headers and the body fields the document gives it, and keeps only what its answer holds", () => {
    const operations = WALK.flatMap((entry) => ("operationId" in entry ? [entry] : []));
    expect(operations.map((entry) => entry.operationId)).toEqual([
      "Auth_registerClient",
      "whoami",
      "Operator_createProject",
      "declare",
      "submit",
      "status",
    ]);
    for (const entry of operations) {
      const { method, path, operation } = published(entry.operationId);
      const step = stepOf(entry.id);
      expect([entry.id, step.operationId, step.method, step.url]).toEqual([
        entry.id,
        entry.operationId,
        method,
        `${ORIGIN}/v1${path}`,
      ]);
      expect([entry.id, step.title]).toEqual([entry.id, operation["summary"]]);
      expect([entry.id, step.say]).toEqual([entry.id, words(operation["description"])]);
      const sent = Object.values(record(operation["parameters"]))
        .map(named)
        .filter((parameter) => parameter["in"] === "header")
        .map((parameter) => parameter["name"]);
      const [media] = Object.entries(record(at(operation, "requestBody", "content")));
      expect([entry.id, names(step.headers)]).toEqual([
        entry.id,
        [...(media === undefined ? [] : ["content-type"]), ...sent],
      ]);
      expect([entry.id, names(step.body)]).toEqual([
        entry.id,
        media === undefined ? [] : Object.keys(record(named(at(media[1], "schema"))["properties"])),
      ]);
      const worked = Object.keys(record(operation["responses"])).filter((status) =>
        status.startsWith("2"),
      );
      expect([entry.id, step.answer?.status]).toEqual([entry.id, worked.map(Number)]);
      expect([entry.id, names(step.answer?.keep)]).toEqual([entry.id, [...entry.keep]]);
    }
    // What the token is for is the operation's own security: none to sign up, a scope to read and to work.
    expect(
      ["sign-up", "whoami", "declare"].map((id) => [stepOf(id).token, stepOf(id).scopes]),
    ).toEqual([
      [undefined, undefined],
      ["required", ["agent:read"]],
      ["required", ["agent:work"]],
    ]);
    // Sign-up's body is spelled out down to the key's own members, each with what the document allows.
    const [jwks] = stepOf("sign-up").body ?? [];
    const [keys] = jwks?.fields ?? [];
    expect([jwks?.name, jwks?.required, keys?.name, keys?.many]).toEqual([
      "jwks",
      true,
      "keys",
      true,
    ]);
    expect(keys?.fields?.find((field) => field.name === "kty")?.oneOf).toEqual(["OKP", "EC"]);
  });

  it("[door.from-spec] the token step is the spec's model at the security scheme's address: every field with its fixed value and its words, the answer's fields, and the issuer a signed request is addressed to", () => {
    const request = record(openApiDocument.components.schemas.AgentTokenRequest);
    const properties = record(request["properties"]);
    const token = stepOf("token");
    expect([token.method, token.url, token.contentType]).toEqual([
      "POST",
      `${ORIGIN}${openApiDocument.components.securitySchemes.OAuth2Auth.flows.clientCredentials.tokenUrl}`,
      "application/x-www-form-urlencoded",
    ]);
    expect(token.say).toBe(flat(request["description"]));
    expect(names(token.body)).toEqual(Object.keys(properties));
    for (const field of token.body ?? []) {
      const property = record(properties[field.name]);
      const fixed = property["enum"];
      expect([field.name, field.value]).toEqual([
        field.name,
        Array.isArray(fixed) ? fixed[0] : undefined,
      ]);
      expect([field.name, field.required]).toEqual([
        field.name,
        Object.values(record(request["required"])).includes(field.name),
      ]);
      expect([field.name, field.say]).toEqual([field.name, words(property["description"])]);
    }
    expect(names(token.headers)).toEqual(["content-type", "dpop"]);
    expect(names(token.answer?.keep)).toEqual(["access_token", "token_type", "expires_in"]);
    expect(token.answer?.keep.find((field) => field.name === "token_type")?.oneOf).toEqual([
      "DPoP",
      "Bearer",
    ]);
    expect(token.here).toEqual({
      issuer: `${ORIGIN}/v1/auth`,
      metadata: `${ORIGIN}/.well-known/oauth-authorization-server`,
    });
    // Asked again once there is a project: the same request, by the two fields that name the work.
    const again = stepOf("work-token");
    expect([again.url, names(again.body)]).toEqual([token.url, ["project", "run"]]);
    // The MCP tools are the operations tagged `mcp`, each by its id.
    const tagged = Object.values(openApiDocument.paths).flatMap((item) =>
      Object.values(item).flatMap((operation) => {
        const tags: unknown = at(operation, "tags");
        return Array.isArray(tags) && tags.includes("mcp") ? [at(operation, "operationId")] : [];
      }),
    );
    expect(door.mcp.tools.map((tool) => tool.name)).toEqual(tagged);
    expect(tagged.length).toBeGreaterThan(10);
    expect([door.name, door.version]).toEqual([
      openApiDocument.info.title,
      openApiDocument.info.version,
    ]);
  });

  it("[door.from-spec] the markdown and the JSON say the same steps in the same order: each step's title, its request line, and every field it sends and keeps", () => {
    const markdown = startMarkdown(door);
    const sections = markdown.split(/^## /m).slice(1);
    const numbered = sections.filter((section) => /^\d+\. /.test(section));
    expect(numbered.map((section) => section.split("\n")[0])).toEqual(
      door.steps.map((step, index) => `${index + 1}. ${step.title}`),
    );
    for (const [index, step] of door.steps.entries()) {
      const section = numbered[index] ?? "";
      // A step that is no request has no request line, and one the document gives no words has none.
      expect(section).toContain(
        step.method === undefined ? "" : `\`${step.method} ${step.url ?? ""}\``,
      );
      expect(section).toContain(step.say ?? "");
      const said = [
        ...(step.fields ?? []),
        ...(step.headers ?? []),
        ...(step.query ?? []),
        ...(step.body ?? []),
        ...(step.answer?.keep ?? []),
      ];
      expect(said.length).toBeGreaterThan(0);
      for (const field of said) expect(section).toContain(`- \`${field.name}\``);
      for (const value of Object.values(step.here ?? {})) expect(section).toContain(value);
    }
    for (const tool of door.mcp.tools)
      expect(markdown).toContain(
        `- \`${tool.name}\`: ${tool.title} (\`${tool.method} ${tool.url}\`)`,
      );
    for (const document of door.documents) expect(markdown).toContain(`](${document.url})`);
  });

  it("[door.from-spec] a walk that names what the document does not hold is no door: an operation, a model, a kept field or the token endpoint gone from the spec throws", () => {
    const whoami = published("whoami");
    expect(() => frontDoor(without("paths", whoami.path), PLACE)).toThrow(/no operation whoami/);
    expect(() => frontDoor(without("components", "schemas", "AgentTokenRequest"), PLACE)).toThrow(
      /no model AgentTokenRequest/,
    );
    expect(() =>
      frontDoor(
        without("components", "schemas", "ClientRegistration", "properties", "handle"),
        PLACE,
      ),
    ).toThrow(/Auth_registerClient answers no `handle`/);
    expect(() =>
      frontDoor(without("components", "schemas", "AgentTokenRequest", "properties", "run"), PLACE),
    ).toThrow(/AgentTokenRequest has no field `run`/);
    expect(() =>
      frontDoor(
        without("components", "securitySchemes", "OAuth2Auth", "flows", "clientCredentials"),
        PLACE,
      ),
    ).toThrow(/names no token endpoint/);
    expect(() => frontDoor(openApiDocument, PLACE)).not.toThrow();
  });
});
