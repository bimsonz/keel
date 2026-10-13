// The front door, walked against a deployed Keel by a client that is given one address.
//   node e2e/src/door.ts <keel's origin>
//
// No credential is given and none is kept. The script reads `<origin>/start`
// and takes every address, method, header and field name after that from what
// it read, but for `/llms.txt`, which a reader finds by its name. It brings
// only what an arriving agent holds: a key it has just made, and the proofs
// and the signed request that key makes.
//   (a) /start answers the walk as JSON, and as text to a reader that asks for
//       nothing, and those answers and /llms.txt name the catalogue in a Link
//       header;
//   (b) the key signs up at the address the page gives, with the body the page
//       spells out;
//   (c) it asks the page's token endpoint for a token, bound to a key made for
//       the run, with a request signed for the issuer the page names;
//   (d) it presents the token as the answer says to, and whoami answers it by
//       the handle sign-up gave it; the same request with no token is refused,
//       and the refusal's challenge leads back to /start in two reads;
//   (e) every document the page lists answers, and the token asked for by the
//       MCP door's name is taken at /mcp, where the API's is refused;
//   (f) the document, the walk, the MCP server's card and the MCP server as it
//       answers server/discover say one release's version.
// Each run is a new key, so a new agent: run it on purpose. No token or key is printed.
import { clientAssertion, dpopProof, generateAgentKey, runKey } from "@keeltown/sdk";

const [origin] = process.argv.slice(2);
if (origin === undefined || !/^https:\/\/[^/]+$/.test(origin))
  throw new Error("usage: door.ts <keel's origin>, as https://<host> with no path");
const START = `${origin}/start`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

type Json = Readonly<Record<string, unknown>>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

interface Field {
  readonly name: string;
  readonly required: boolean;
  readonly value?: string;
  readonly many?: boolean;
  readonly fields?: readonly Field[];
}

interface Step {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly contentType?: string;
  readonly headers: readonly Field[];
  readonly body?: readonly Field[];
  readonly keep: readonly string[];
  readonly here: Json;
}

const fieldsOf = (value: unknown): readonly Field[] =>
  list(value).map((entry): Field => {
    const { name, required, value: fixed, many, fields } = record(entry);
    return {
      name: text(name),
      required: required === true,
      ...(typeof fixed === "string" ? { value: fixed } : {}),
      ...(many === true ? { many: true } : {}),
      ...(fields === undefined ? {} : { fields: fieldsOf(fields) }),
    };
  });

/** One of the page's steps that is a request. A page without it is no walk. */
function stepOf(door: Json, id: string): Step {
  const step = record(list(door["steps"]).find((candidate) => record(candidate)["id"] === id));
  const [method, url] = [text(step["method"]), text(step["url"])];
  if (method === "" || url === "") throw new Error(`/start has no request for the step ${id}`);
  return {
    id,
    method,
    url,
    ...(typeof step["contentType"] === "string" ? { contentType: step["contentType"] } : {}),
    headers: fieldsOf(step["headers"]),
    ...(step["body"] === undefined ? {} : { body: fieldsOf(step["body"]) }),
    keep: list(record(step["answer"])["keep"]).map((kept) => text(record(kept)["name"])),
    here: record(step["here"]),
  };
}

/** What a step sends: the page's fixed values, and the walker's own under the names the page uses. */
function filled(fields: readonly Field[], own: Json): Record<string, unknown> {
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
  readonly headers?: Json;
  readonly body?: Json;
  readonly presented?: Readonly<Record<string, string>>;
}

function send(step: Step, own: Own = {}): Promise<Response> {
  const headers = new Headers(own.presented);
  for (const [name, value] of Object.entries(filled(step.headers, own.headers ?? {})))
    headers.set(name, String(value));
  const body = step.body === undefined ? undefined : filled(step.body, own.body ?? {});
  const encoded =
    body === undefined
      ? undefined
      : step.contentType === "application/json"
        ? JSON.stringify(body)
        : new URLSearchParams(
            Object.entries(body).map(([name, value]) => [name, String(value)]),
          ).toString();
  return fetch(step.url, {
    method: step.method,
    headers,
    ...(encoded === undefined ? {} : { body: encoded }),
  });
}

/** A value the step says to keep, by the dotted name it gives; none when the step does not keep it. */
function keptOf(step: Step, answer: unknown, name: string): unknown {
  if (!step.keep.includes(name)) return undefined;
  return name.split(".").reduce<unknown>((inner, key) => record(inner)[key], answer);
}

/** A refusal in its own words, never the request that drew it. */
const refusalOf = async (response: Response): Promise<string> => {
  const body = record(await response.json().catch(() => undefined));
  return `${response.status} ${text(body["code"]) || text(body["error"])} ${text(body["detail"]) || text(body["error_description"])}`.trim();
};

async function walk(): Promise<void> {
  // (a) the page.
  const page = await fetch(START, { headers: { accept: "application/json" } });
  check(page.status === 200, `(a) ${START} answers the walk as JSON`);
  const door = record(await page.json());
  const plain = await fetch(START);
  const words = await plain.text();
  check(
    plain.status === 200 &&
      (plain.headers.get("content-type") ?? "").startsWith("text/plain") &&
      words.startsWith(`# ${text(door["name"])}\n`),
    "(a) a reader that asks for nothing is answered the same walk as text",
  );
  // The catalogue, named by each answer's own header (RFC 9727): on the walk, and on the index a reader finds by its conventional name.
  const documentOf = (rel: string) =>
    text(
      record(
        list(door["documents"])
          .map(record)
          .find((document) => text(document["rel"]) === rel),
      )["url"],
    );
  const index = await fetch(`${origin}/llms.txt`);
  await index.body?.cancel();
  const pointer = `<${documentOf("api-catalog")}>; rel="api-catalog"`;
  check(
    documentOf("api-catalog") !== "" &&
      [page, plain, index].every((answer) => answer.headers.get("link") === pointer),
    "(a) the walk, as JSON and as text, and /llms.txt each name the catalogue in a Link header",
  );
  const ids = list(door["steps"]).map((step) => text(record(step)["id"]));
  check(
    ids.slice(0, 4).join() === "key,sign-up,token,whoami",
    "(a) the walk starts: a key, sign-up, a token, whoami",
  );

  // (b) sign-up.
  const { signer } = await generateAgentKey();
  const signingUp = stepOf(door, "sign-up");
  const registered = await send(signingUp, {
    headers: { dpop: await dpopProof(signer, signingUp) },
    body: { ...signer.publicJwk, client_name: "door-walk" },
  });
  if (registered.status !== 201)
    throw new Error(`sign-up at ${signingUp.url} answered ${await refusalOf(registered)}`);
  const made: unknown = await registered.json();
  const agentId = text(keptOf(signingUp, made, "client_id"));
  const handle = text(keptOf(signingUp, made, "handle"));
  console.log(`     agent ${agentId}, handle ${handle}`);
  check(
    agentId !== "" && handle !== "",
    "(b) the key signs up as a new agent at the page's address",
  );

  // (c) a token.
  const asking = stepOf(door, "token");
  const issuer = text(asking.here["issuer"]);
  const run = await runKey();
  const assertion = () => clientAssertion(signer, { agentId, audience: issuer });
  const asked = await send(asking, {
    headers: { dpop: await dpopProof(run, asking) },
    body: { client_assertion: await assertion() },
  });
  if (asked.status !== 200)
    throw new Error(`the token request at ${asking.url} answered ${await refusalOf(asked)}`);
  const grant: unknown = await asked.json();
  const token = text(keptOf(asking, grant, "access_token"));
  const scheme = text(keptOf(asking, grant, "token_type"));
  check(
    token !== "" && scheme === "DPoP",
    "(c) a request the key signed for the page's issuer is granted a token bound to the run's key",
  );

  // (d) whoami.
  const reading = stepOf(door, "whoami");
  const answered = await send(reading, {
    presented: {
      authorization: `${scheme} ${token}`,
      dpop: await dpopProof(run, { ...reading, accessToken: token }),
    },
  });
  const me: unknown = answered.status === 200 ? await answered.json() : undefined;
  check(
    answered.status === 200 &&
      keptOf(reading, me, "result.agent.id") === agentId &&
      keptOf(reading, me, "result.agent.handle") === handle,
    "(d) whoami answers the token by the agent's id and the handle sign-up gave it",
  );
  const bare = await send(reading);
  const told = list(record(await bare.json().catch(() => undefined))["nextActions"]).map(record);
  check(
    bare.status === 401 &&
      told[0]?.["operationId"] === "Auth_registerClient" &&
      text(told[1]?.["title"]).includes("/start") &&
      !told.some((next) => next["operationId"] === "Auth_exchangeToken"),
    "(d) with no token it is refused, and told to sign up and to read /start",
  );
  const [, resourceUrl] =
    /resource_metadata="([^"]+)"/.exec(bare.headers.get("www-authenticate") ?? "") ?? [];
  const resource = resourceUrl === undefined ? {} : record(await (await fetch(resourceUrl)).json());
  check(
    resource["resource_documentation"] === START,
    "(d) the refusal's challenge names the resource's document, which names /start",
  );

  // (e) the rest.
  const documents = list(door["documents"]).map((document) => text(record(document)["url"]));
  const answers = await Promise.all(
    documents.map(async (url) => {
      const response = await fetch(url);
      await response.body?.cancel();
      return [url, response.status] as const;
    }),
  );
  const silent = answers.filter(([, status]) => status !== 200);
  check(
    documents.length > 5 && silent.length === 0,
    `(e) each of the ${documents.length} documents the page lists answers${silent.length === 0 ? "" : `; not ${silent.map(([url, status]) => `${url} (${status})`).join(", ")}`}`,
  );
  const mcp = record(door["mcp"]);
  const plainToken = async (forDoor?: string) => {
    const response = await send(asking, {
      body: {
        client_assertion: await assertion(),
        ...(forDoor === undefined ? {} : { resource: forDoor }),
      },
    });
    return text(record(await response.json())["access_token"]);
  };
  const atMcp = async (bearer: string) => {
    const response = await fetch(text(mcp["endpoint"]), {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    await response.body?.cancel();
    return response.status;
  };
  const [forMcp, forApi] = [await plainToken(text(mcp["resource"])), await plainToken()];
  const [taken, refused] = [await atMcp(forMcp), await atMcp(forApi)];
  check(
    forMcp !== "" && taken !== 401 && taken !== 403 && refused === 401,
    `(e) a token asked for by the MCP door's name is taken at /mcp (${taken}), and the API's is refused there (${refused})`,
  );

  // (f) one release's version, wherever Keel says one.
  const versionAt = async (rel: string, ...path: string[]) => {
    const body: unknown = await (await fetch(documentOf(rel))).json().catch(() => undefined);
    return text(path.reduce<unknown>((inner, key) => record(inner)[key], body));
  };
  const revision = "2026-07-28";
  const discovering = await fetch(text(mcp["endpoint"]), {
    method: "POST",
    headers: {
      authorization: `Bearer ${forMcp}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": revision,
      "mcp-method": "server/discover",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": revision,
          "io.modelcontextprotocol/clientInfo": { name: "keel-door-walk", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  // The answer is one JSON body or one event of a stream.
  const discoveryBody = await discovering.text();
  const message = discoveryBody.startsWith("{")
    ? discoveryBody
    : (discoveryBody
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6) ?? "{}");
  const discovered: unknown = JSON.parse(message);
  // The current revision has no handshake: a server names itself in the `_meta` of its answers.
  const meta = record(record(record(discovered)["result"])["_meta"]);
  const serverSays = text(record(meta["io.modelcontextprotocol/serverInfo"])["version"]);
  const [published, carded] = [
    await versionAt("service-desc", "info", "version"),
    await versionAt("mcp-server-card", "version"),
  ];
  check(
    /^(?!0\.0\.0$)\d+\.\d+\.\d+$/.test(published) &&
      [text(door["version"]), carded, serverSays].every((said) => said === published),
    `(f) the document, the walk, the MCP server's card and the MCP server say one release's version: ${published}, ${text(door["version"])}, ${carded}, ${serverSays}`,
  );
}

try {
  await walk();
} catch (error) {
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  failures += 1;
}
console.log(failures === 0 ? "\nall door checks hold" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
