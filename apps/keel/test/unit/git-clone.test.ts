// The clone URL's two halves without a git client (apps/keel's node tests
// cannot spawn one): RepoServer over a recording host, which proves what the
// adapter asks the host and what it lets back, and the git routes over a
// scripted application. A real `git clone` through both is proven live.
import { describe, expect, it } from "@effect/vitest";
import {
  CodeHost,
  type RepoRef,
  RepoServer,
  UPLOAD_PACK_ANSWER_TYPE,
  UPLOAD_PACK_REQUEST_TYPE,
  type UploadPackAnswer,
  type UploadPackRequest,
} from "@keeltown/core/ports";
import { concat, FLUSH, pkt } from "@keeltown/gitcore";
import { makeCodeHostMemory } from "@keeltown/testing";
import { Effect, Layer } from "effect";
import { Hono } from "hono";
import {
  MAX_REF_LIST_BYTES,
  RepoServerArtifacts,
} from "../../src/adapters/driven/artifacts/repo-server.ts";
import { cloneAccess } from "../../src/adapters/driving/http/clone-access.ts";
import {
  CLONE_CHALLENGE,
  CLONE_CREDENTIAL,
  type CloneAccess,
  type GitClone,
  MAX_UPLOAD_PACK_REQUEST_BYTES,
  registerGitClone,
} from "../../src/adapters/driving/http/git-clone.ts";
import type { AppEnv } from "../../src/generated/http/runtime.gen.ts";

const TRUNK: RepoRef = { namespace: "memory", name: "prj" };
const enc = new TextEncoder();
const ADVERTISEMENT = enc.encode("001e# service=git-upload-pack\n0000");
const RESULT = enc.encode("0008NAK\n");

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const bytesOf = async (body: AsyncIterable<Uint8Array> | null) => {
  const parts: number[] = [];
  if (body !== null) for await (const chunk of body) parts.push(...chunk);
  return new Uint8Array(parts);
};

interface Asked {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | null;
  readonly redirect: string | undefined;
}

/** The host: every request recorded, each answered by `reply`, which is handed the token it was sent. */
function recordingHost(reply: (asked: Asked, token: string) => Response | Promise<Response>) {
  const asked: Asked[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const request: Asked = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      headers,
      body:
        init?.body === undefined || init.body === null
          ? null
          : new Uint8Array(await new Response(init.body).arrayBuffer()),
      redirect: init?.redirect,
    };
    asked.push(request);
    return await reply(request, (headers["authorization"] ?? "").replace(/^Bearer /, ""));
  };
  return { asked, fetcher };
}

const git = (type: string, body: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "Content-Type": type, ...headers } });

/** RepoServer over a memory code host holding TRUNK, every minted token recorded. */
function served(fetcher: typeof fetch) {
  const code = makeCodeHostMemory();
  const minted: string[] = [];
  const spied = Layer.effect(
    CodeHost,
    Effect.map(CodeHost, (h) =>
      CodeHost.of({
        ...h,
        mintToken: (repo, access, ttl) => {
          minted.push(`${repo.name} ${access} ${ttl}s`);
          return h.mintToken(repo, access, ttl);
        },
      }),
    ),
  ).pipe(Layer.provide(code.layer));
  const layer = Layer.mergeAll(RepoServerArtifacts(fetcher).pipe(Layer.provide(spied)), spied);
  const uploadPack = (repo: RepoRef, request: UploadPackRequest) =>
    Effect.gen(function* () {
      const host = yield* CodeHost;
      if (repo === TRUNK) yield* Effect.ignore(host.create(TRUNK));
      return yield* Effect.flatMap(RepoServer, (s) => s.uploadPack(repo, request));
    }).pipe(Effect.provide(layer));
  return { minted, uploadPack };
}

describe("RepoServer over the code host's remote", () => {
  it.effect(
    "[reposerver.read-token] each request goes to the repo's remote with a read token minted for it and gone in a minute",
    () =>
      Effect.gen(function* () {
        const host = recordingHost((asked) =>
          asked.method === "GET"
            ? git(UPLOAD_PACK_ANSWER_TYPE.advertise, ADVERTISEMENT)
            : git(UPLOAD_PACK_ANSWER_TYPE.negotiate, RESULT),
        );
        const { minted, uploadPack } = served(host.fetcher);
        const want = enc.encode(
          "0032want 1111111111111111111111111111111111111111\n00000009done\n",
        );

        const advertised = yield* uploadPack(TRUNK, {
          service: "advertise",
          protocol: null,
          body: null,
        });
        expect(advertised).toMatchObject({
          status: 200,
          contentType: UPLOAD_PACK_ANSWER_TYPE.advertise,
        });
        expect(yield* Effect.promise(() => bytesOf(advertised.body))).toEqual(ADVERTISEMENT);
        const negotiated = yield* uploadPack(TRUNK, {
          service: "negotiate",
          protocol: "version=2",
          body: want,
        });
        expect(negotiated).toMatchObject({
          status: 200,
          contentType: UPLOAD_PACK_ANSWER_TYPE.negotiate,
        });
        expect(yield* Effect.promise(() => bytesOf(negotiated.body))).toEqual(RESULT);

        expect(minted).toEqual(["prj read 60s", "prj read 60s"]);
        expect(
          host.asked.map((a) => ({
            ...a,
            headers: {
              ...a.headers,
              authorization: a.headers["authorization"]?.replace(/_\d+$/, ""),
            },
          })),
        ).toEqual([
          {
            url: "memory://memory/prj.git/info/refs?service=git-upload-pack",
            method: "GET",
            headers: {
              accept: UPLOAD_PACK_ANSWER_TYPE.advertise,
              authorization: "Bearer memrepo_read_memory/prj",
            },
            body: null,
            redirect: "manual",
          },
          {
            url: "memory://memory/prj.git/git-upload-pack",
            method: "POST",
            headers: {
              accept: UPLOAD_PACK_ANSWER_TYPE.negotiate,
              authorization: "Bearer memrepo_read_memory/prj",
              "content-type": UPLOAD_PACK_REQUEST_TYPE,
              "git-protocol": "version=2",
            },
            body: want,
            redirect: "manual",
          },
        ]);
        // Two requests, two tokens.
        expect(new Set(host.asked.map((a) => a.headers["authorization"])).size).toBe(2);
      }),
  );

  it.effect(
    "[reposerver.not-git] a redirect, a refusal, another content type or no answer at all is a 502 with nothing of the host in it",
    () =>
      Effect.gen(function* () {
        const replies: (() => Response)[] = [
          () =>
            new Response("moved", {
              status: 302,
              headers: {
                Location: "https://elsewhere.example/",
                "Content-Type": UPLOAD_PACK_ANSWER_TYPE.advertise,
              },
            }),
          () => new Response("no", { status: 401, headers: { "WWW-Authenticate": "Bearer" } }),
          () => git("text/html", enc.encode("<html>")),
          () => git(UPLOAD_PACK_ANSWER_TYPE.negotiate, ADVERTISEMENT),
          () => {
            throw new Error("connection reset");
          },
        ];
        for (const reply of replies) {
          const host = recordingHost(reply);
          const { uploadPack } = served(host.fetcher);
          expect(
            yield* uploadPack(TRUNK, { service: "advertise", protocol: null, body: null }),
          ).toEqual({ status: 502, contentType: "text/plain", body: null });
          expect(host.asked).toHaveLength(1);
        }
      }),
  );

  it.effect(
    "[reposerver.missing] a repo the host lacks is RepoNotFound, and nothing is fetched",
    () =>
      Effect.gen(function* () {
        const host = recordingHost(() => git(UPLOAD_PACK_ANSWER_TYPE.advertise, ADVERTISEMENT));
        const { minted, uploadPack } = served(host.fetcher);
        const gone = { namespace: "memory", name: "gone" };
        expect(
          yield* Effect.flip(
            uploadPack(gone, { service: "advertise", protocol: null, body: null }),
          ),
        ).toMatchObject({ _tag: "RepoNotFound", repo: gone });
        expect(host.asked).toEqual([]);
        expect(minted).toEqual([]);
      }),
  );

  it.effect(
    "[reposerver.main-only] a host whose HEAD is on another branch is shown as main alone: its advertisement rewritten, its ls-refs asked for main only, a fetch passed through",
    () =>
      Effect.gen(function* () {
        const main = "1".repeat(40);
        const master = "2".repeat(40);
        const caps = "multi_ack side-band-64k agent=host";
        const service = [pkt("# service=git-upload-pack\n"), FLUSH];
        const ls = (...args: string[]) =>
          concat([
            pkt("command=ls-refs\n"),
            pkt("agent=git/2.50.1\n"),
            enc.encode("0001"),
            ...args.map((arg) => pkt(`${arg}\n`)),
            FLUSH,
          ]);
        const fetch = concat([
          pkt("command=fetch\n"),
          enc.encode("0001"),
          pkt(`want ${master}\n`),
          pkt("done\n"),
          FLUSH,
        ]);
        const host = recordingHost((asked) => {
          if (asked.method === "GET")
            return git(
              UPLOAD_PACK_ANSWER_TYPE.advertise,
              concat([
                ...service,
                pkt(`${master} HEAD\0${caps} symref=HEAD:refs/heads/master\n`),
                pkt(`${main} refs/heads/main\n`),
                pkt(`${master} refs/heads/master\n`),
                FLUSH,
              ]),
            );
          const sent = text(asked.body ?? new Uint8Array());
          return git(
            UPLOAD_PACK_ANSWER_TYPE.negotiate,
            sent.includes("command=ls-refs")
              ? concat([pkt(`${main} refs/heads/main\n`), FLUSH])
              : RESULT,
          );
        });
        const { uploadPack } = served(host.fetcher);
        const answered = (request: UploadPackRequest) =>
          Effect.flatMap(uploadPack(TRUNK, request), (answer) =>
            Effect.promise(async () => text(await bytesOf(answer.body))),
          );

        expect(yield* answered({ service: "advertise", protocol: null, body: null })).toBe(
          text(
            concat([
              ...service,
              pkt(`${main} HEAD\0${caps} symref=HEAD:refs/heads/main\n`),
              pkt(`${main} refs/heads/main\n`),
              FLUSH,
            ]),
          ),
        );

        const v2 = { service: "negotiate", protocol: "version=2" } as const;
        expect(yield* answered({ ...v2, body: ls("symrefs", "ref-prefix HEAD") })).toBe(
          text(concat([pkt(`${main} HEAD symref-target:refs/heads/main\n`), FLUSH])),
        );
        const asked = text(host.asked[1]?.body ?? new Uint8Array());
        expect(asked).toContain("ref-prefix refs/heads/main\n");
        expect(asked).not.toContain("ref-prefix HEAD");
        expect(host.asked[1]?.headers).toMatchObject({ "git-protocol": "version=2" });

        // A fetch is the host's to answer: the client's own request, and the answer as it came.
        expect(yield* answered({ ...v2, body: fetch })).toBe(text(RESULT));
        expect(host.asked[2]?.body).toEqual(fetch);
      }),
  );

  it.effect(
    "[reposerver.ref-list-cap] a list of refs over the cap, or one the host answers with an error, is a 502 with nothing of the host in it",
    () =>
      Effect.gen(function* () {
        const main = "1".repeat(40);
        const lines = [
          pkt(`${main} HEAD\0side-band-64k\n`),
          pkt(`${main} refs/heads/main\n`),
          ...Array.from({ length: 20 }, (_, i) =>
            pkt(`${main} refs/heads/${i}-${"b".repeat(60_000)}\n`),
          ),
          FLUSH,
        ];
        const under = concat([...lines.slice(0, 12), FLUSH]);
        const over = concat(lines);
        expect(under.length).toBeLessThan(MAX_REF_LIST_BYTES);
        expect(over.length).toBeGreaterThan(MAX_REF_LIST_BYTES);
        const advertise = { service: "advertise", protocol: null, body: null } as const;

        const small = served(
          recordingHost(() => git(UPLOAD_PACK_ANSWER_TYPE.advertise, under)).fetcher,
        );
        expect(yield* small.uploadPack(TRUNK, advertise)).toMatchObject({ status: 200 });
        const large = served(
          recordingHost(() => git(UPLOAD_PACK_ANSWER_TYPE.advertise, over)).fetcher,
        );
        expect(yield* large.uploadPack(TRUNK, advertise)).toEqual({
          status: 502,
          contentType: "text/plain",
          body: null,
        });
        const refusing = served(
          recordingHost(() =>
            git(UPLOAD_PACK_ANSWER_TYPE.advertise, pkt("ERR the repository is not available\n")),
          ).fetcher,
        );
        expect(yield* refusing.uploadPack(TRUNK, advertise)).toEqual({
          status: 502,
          contentType: "text/plain",
          body: null,
        });
      }),
  );
});

/** The git routes over a scripted application: what was asked of it, and what it answers. */
function routes(
  access: CloneAccess = { kind: "granted", repo: TRUNK },
  uploadPack?: GitClone["uploadPack"],
) {
  const asked: string[] = [];
  const packed: { readonly repo: RepoRef; readonly request: UploadPackRequest }[] = [];
  const app = new Hono<AppEnv>();
  registerGitClone(app, {
    access: (_request, org, project) => {
      asked.push(`${org}/${project}`);
      return Promise.resolve(access);
    },
    uploadPack: (repo, request) => {
      packed.push({ repo, request });
      if (uploadPack !== undefined) return uploadPack(repo, request);
      const body = request.service === "advertise" ? ADVERTISEMENT : RESULT;
      return Promise.resolve({
        status: 200,
        contentType: UPLOAD_PACK_ANSWER_TYPE[request.service],
        body: (async function* () {
          yield body;
        })(),
      } satisfies UploadPackAnswer);
    },
  });
  return { app, asked, packed };
}

const REFS = "/acme/forge.git/info/refs?service=git-upload-pack";
const UPLOAD = "/acme/forge.git/git-upload-pack";
const post = (body: BodyInit, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": UPLOAD_PACK_REQUEST_TYPE, ...headers },
  body,
});
const gzipped = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
const headersOf = (response: Response) => {
  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
};

describe("the clone URL", () => {
  it("[clone.fetch] the advertisement and the negotiation reach the repo access granted, and its bytes come back under git's content types", async () => {
    const { app, asked, packed } = routes();
    const refs = await app.request(REFS);
    expect(refs.status).toBe(200);
    expect(headersOf(refs)).toEqual({
      "content-type": UPLOAD_PACK_ANSWER_TYPE.advertise,
      "cache-control": "no-cache, max-age=0, must-revalidate",
    });
    expect(new Uint8Array(await refs.arrayBuffer())).toEqual(ADVERTISEMENT);

    const want = new Uint8Array(enc.encode("0009done\n"));
    const pack = await app.request(UPLOAD, post(want));
    expect(pack.status).toBe(200);
    expect(pack.headers.get("content-type")).toBe(UPLOAD_PACK_ANSWER_TYPE.negotiate);
    expect(new Uint8Array(await pack.arrayBuffer())).toEqual(RESULT);

    // git gzips a negotiation over 1 KiB; the application sees it undone.
    await app.request(UPLOAD, post(await gzipped(want), { "Content-Encoding": "gzip" }));

    expect(asked).toEqual(["acme/forge", "acme/forge", "acme/forge"]);
    expect(packed).toEqual([
      { repo: TRUNK, request: { service: "advertise", protocol: null, body: null } },
      { repo: TRUNK, request: { service: "negotiate", protocol: null, body: want } },
      { repo: TRUNK, request: { service: "negotiate", protocol: null, body: want } },
    ]);
  });

  it("[clone.receive-pack-refused] a push is refused 403 on both of its requests, and nothing is looked up or fetched", async () => {
    const { app, asked, packed } = routes();
    const advertised = await app.request("/acme/forge.git/info/refs?service=git-receive-pack");
    const pushed = await app.request("/acme/forge.git/git-receive-pack", {
      method: "POST",
      headers: { "Content-Type": "application/x-git-receive-pack-request" },
      body: enc.encode("0000"),
    });
    expect([advertised.status, pushed.status]).toEqual([403, 403]);
    for (const said of await Promise.all([advertised.text(), pushed.text()]))
      expect(said).toContain("fetches only");
    // The dumb protocol (no service) is refused the same way.
    expect((await app.request("/acme/forge.git/info/refs")).status).toBe(403);
    expect(asked).toEqual([]);
    expect(packed).toEqual([]);
  });

  it("[clone.v2] Git-Protocol's version reaches the host on both requests, and nothing else of the header does", async () => {
    const { app, packed } = routes();
    await app.request(REFS, { headers: { "Git-Protocol": "version=2" } });
    await app.request(UPLOAD, post(enc.encode("0000"), { "Git-Protocol": "version=2" }));
    await app.request(REFS, { headers: { "Git-Protocol": "version=2:evil=1" } });
    await app.request(REFS);
    expect(packed.map((p) => p.request.protocol)).toEqual(["version=2", "version=2", null, null]);
  });

  it("[clone.body-cap] a negotiation over 8 MiB is refused 413 unread by the host, declared, streamed or gzipped; 8 MiB exactly passes", async () => {
    const { app, packed } = routes();
    const cap = MAX_UPLOAD_PACK_REQUEST_BYTES;
    expect(cap).toBe(8 * 1024 * 1024);

    const exact = await app.request(UPLOAD, post(new Uint8Array(cap)));
    expect(exact.status).toBe(200);
    expect(packed.map((p) => p.request.body?.length)).toEqual([cap]);

    const declared = await app.request(
      UPLOAD,
      post(new Uint8Array(1), { "Content-Length": String(cap + 1) }),
    );
    const streamed = await app.request(UPLOAD, {
      ...post(new Blob([new Uint8Array(cap + 1)]).stream()),
      duplex: "half",
    } as RequestInit);
    const bomb = await app.request(
      UPLOAD,
      post(await gzipped(new Uint8Array(cap + 1)), { "Content-Encoding": "gzip" }),
    );
    expect([declared.status, streamed.status, bomb.status]).toEqual([413, 413, 413]);
    expect(await Promise.all([declared.text(), streamed.text(), bomb.text()])).toEqual(
      Array.from({ length: 3 }, () => "The request exceeds 8 MiB.\n"),
    );
    expect(packed).toHaveLength(1);
  });

  it("[clone.unchecked] a credential the gate could not check is told to try again: it is not asked for again, and nothing is looked up", async () => {
    const access = cloneAccess(
      () => Promise.resolve(new Response("later", { status: 503 })),
      () => Promise.reject(new Error("nothing is looked up")),
    );
    expect(await access(new Request(`https://keel.test${REFS}`), "acme", "forge")).toEqual({
      kind: "unavailable",
    });
    const later = routes({ kind: "unavailable" });
    const answered = await later.app.request(REFS);
    expect([answered.status, answered.headers.get("www-authenticate")]).toEqual([503, null]);
    expect(later.packed).toEqual([]);
  });

  it("[clone.refusals] no credential asks git for one; a repo the caller cannot see and one the host lacks read the same", async () => {
    const anonymous = routes({ kind: "unauthenticated" });
    const challenged = await anonymous.app.request(REFS);
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("www-authenticate")).toBe(CLONE_CHALLENGE);
    expect(await challenged.text()).toBe(`${CLONE_CREDENTIAL}\n`);
    expect(anonymous.packed).toEqual([]);

    const hidden = await routes({ kind: "not-found" }).app.request(REFS);
    const gone = await routes({ kind: "granted", repo: TRUNK }, () =>
      Promise.resolve(null),
    ).app.request(REFS);
    expect(hidden.status).toBe(404);
    expect(gone.status).toBe(404);
    expect(headersOf(hidden)).toEqual(headersOf(gone));
    expect(await hidden.text()).toBe(await gone.text());

    const wrongType = await routes().app.request(UPLOAD, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    expect(wrongType.status).toBe(415);
    const down = await routes({ kind: "granted", repo: TRUNK }, () =>
      Promise.resolve({ status: 502, contentType: "text/plain", body: null }),
    ).app.request(REFS);
    expect(down.status).toBe(502);
  });

  it("[clone.token-never-returned] a host that echoes the token in every header it sends gets none of it through", async () => {
    let token = "";
    const host = recordingHost((_asked, sent) => {
      token = sent;
      return git(`${UPLOAD_PACK_ANSWER_TYPE.advertise}; token=${sent}`, ADVERTISEMENT, {
        "Set-Cookie": `session=${sent}`,
        Location: `https://host.example/?t=${sent}`,
        "WWW-Authenticate": `Bearer realm="${sent}"`,
        "X-Repo-Token": sent,
      });
    });
    const { uploadPack } = served(host.fetcher);
    const { app } = routes({ kind: "granted", repo: TRUNK }, (repo, request) =>
      Effect.runPromise(uploadPack(repo, request)),
    );
    const response = await app.request(REFS);
    expect(token).toMatch(/^memrepo_read_/);
    expect(response.status).toBe(200);
    expect(headersOf(response)).toEqual({
      "content-type": UPLOAD_PACK_ANSWER_TYPE.advertise,
      "cache-control": "no-cache, max-age=0, must-revalidate",
    });
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(ADVERTISEMENT);
    expect(JSON.stringify(headersOf(response))).not.toContain(token);
  });
});
