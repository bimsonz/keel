import { describe, expect, it } from "@effect/vitest";
import { type DeployAccount, Deployer, type WorkerUpload } from "@keeltown/core/ports";
import { Effect, Exit, Redacted } from "effect";
import { gzipSync } from "node:zlib";
import { DeployerCloudflare } from "../../src/adapters/driven/deploy/cloudflare-deployer.ts";

const TOKEN = "cf-token-SECRET-0123456789abcdef";
const ACCOUNT: DeployAccount = {
  accountId: "0123456789abcdef0123456789abcdef",
  workersDev: "owner.workers.dev",
};
const MODULE = "export default { fetch() { return new Response('ok'); } };";
const VERSION = "8d2a91c4-5f3e-4b2a-9c1d-0e6f7a8b9c0d";
const UPLOAD: WorkerUpload = {
  worker: "worker-lite",
  mainModule: "worker.js",
  moduleGzip: gzipSync(MODULE).toString("base64"),
  compatibilityDate: "2026-10-01",
  compatibilityFlags: ["nodejs_compat"],
  vars: { GREETING: "hello", LIMITS: { max: 3 } },
  alias: "ch-0000000001",
  tag: "cnd_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
  message: "keel: candidate cnd_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
};

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | FormData | undefined;
}
type Reply = { readonly status: number; readonly body?: unknown } | "no answer";

/** A Cloudflare that answers each request by the first route whose method and path it starts with, recording every request. */
const cloudflare = (routes: readonly (readonly [string, Reply])[]) => {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    const body = init.body;
    seen.push({
      method,
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: body instanceof FormData || typeof body === "string" ? body : undefined,
    });
    const path = url.replace("https://api.cloudflare.com/client/v4", "");
    const reply = routes.find(([route]) => `${method} ${path}`.startsWith(route))?.[1] ?? {
      status: 404,
      body: { success: false, errors: [{ code: 10007, message: "not found" }] },
    };
    if (reply === "no answer") throw new TypeError("network down");
    return new Response(JSON.stringify(reply.body ?? { success: true, result: {} }), {
      status: reply.status,
    });
  };
  return { seen, layer: DeployerCloudflare({ fetch }) };
};

const A = `/accounts/${ACCOUNT.accountId}`;
const uploaded: Reply = { status: 200, body: { success: true, result: { id: VERSION } } };
const exists: Reply = { status: 200, body: { success: true, result: { name: "worker-lite" } } };
const previewsOn: Reply = {
  status: 200,
  body: { success: true, result: { enabled: true, previews_enabled: true } },
};

const preview = (upload: WorkerUpload = UPLOAD) =>
  Effect.gen(function* () {
    return yield* (yield* Deployer).preview(ACCOUNT, Redacted.make(TOKEN), upload);
  });

/** A request's JSON body. */
const jsonOf = (seen: Seen | undefined): unknown =>
  typeof seen?.body === "string" ? JSON.parse(seen.body) : undefined;

const metadataOf = async (seen: Seen): Promise<unknown> => {
  if (!(seen.body instanceof FormData)) throw new Error("not a form");
  const part = seen.body.get("metadata");
  if (!(part instanceof Blob)) throw new Error("no metadata part");
  return JSON.parse(await part.text());
};

const failed = (routes: readonly (readonly [string, Reply])[]) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(preview().pipe(Effect.provide(cloudflare(routes).layer)));
    if (Exit.isSuccess(exit)) return "succeeded";
    const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error;
    return error === undefined ? "died" : `${error.reason} ${error.code ?? "-"} ${error.detail}`;
  });

describe("the Cloudflare Deployer", () => {
  it.effect(
    "[deployer.preview-first] an account with no Worker of the name gets one with no code and no deployment, then an undeployed version with the change's alias, and its two addresses",
    () =>
      Effect.gen(function* () {
        const cf = cloudflare([
          [
            `POST ${A}/workers/workers`,
            { status: 200, body: { success: true, result: { id: "w1" } } },
          ],
          [`POST ${A}/workers/scripts/worker-lite/versions`, uploaded],
        ]);
        const made = yield* preview().pipe(Effect.provide(cf.layer));
        expect(made).toEqual({
          versionId: VERSION,
          url: "https://8d2a91c4-worker-lite.owner.workers.dev",
          aliasUrl: "https://ch-0000000001-worker-lite.owner.workers.dev",
        });
        expect(
          cf.seen.map(
            (s) => `${s.method} ${s.url.replace(`https://api.cloudflare.com/client/v4${A}`, "")}`,
          ),
        ).toEqual([
          "GET /workers/workers/worker-lite",
          "POST /workers/workers",
          "POST /workers/scripts/worker-lite/versions?bindings_inherit=strict",
        ]);
        expect(jsonOf(cf.seen[1])).toEqual({
          name: "worker-lite",
          subdomain: { enabled: true, previews_enabled: true },
        });
        expect(cf.seen.some((s) => s.url.includes("/deployments"))).toBe(false);
      }),
  );

  it.effect(
    "[deployer.preview-upload] a version carries the module, the config's facts and plain vars, its alias and tag, and never keeps the deployed version's bindings",
    () =>
      Effect.gen(function* () {
        const cf = cloudflare([
          [`GET ${A}/workers/workers/worker-lite`, exists],
          [`GET ${A}/workers/scripts/worker-lite/subdomain`, previewsOn],
          [`POST ${A}/workers/scripts/worker-lite/versions`, uploaded],
        ]);
        yield* preview().pipe(Effect.provide(cf.layer));
        const upload = cf.seen.at(-1);
        if (upload === undefined) throw new Error("no upload");
        expect(upload.url).toContain("?bindings_inherit=strict");
        const metadata = yield* Effect.promise(() => metadataOf(upload));
        expect(metadata).toEqual({
          main_module: "worker.js",
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          bindings: [
            { type: "plain_text", name: "GREETING", text: "hello" },
            { type: "json", name: "LIMITS", json: { max: 3 } },
          ],
          annotations: {
            "workers/message": UPLOAD.message,
            "workers/tag": UPLOAD.tag,
            "workers/alias": "ch-0000000001",
          },
        });
        const form = upload.body instanceof FormData ? upload.body : undefined;
        const module = form?.get("worker.js");
        expect(
          module instanceof Blob ? [module.type, yield* Effect.promise(() => module.text())] : [],
        ).toEqual(["application/javascript+module", MODULE]);
        expect(cf.seen[1]?.headers["cloudflare-workers-script-api-date"]).toBe("2025-08-01");
        const { alias: _alias, ...unaliased } = UPLOAD;
        const again = cloudflare([
          [`GET ${A}/workers/workers/worker-lite`, exists],
          [`GET ${A}/workers/scripts/worker-lite/subdomain`, previewsOn],
          [`POST ${A}/workers/scripts/worker-lite/versions`, uploaded],
        ]);
        const made = yield* preview(unaliased).pipe(Effect.provide(again.layer));
        expect(made).not.toHaveProperty("aliasUrl");
        const last = again.seen.at(-1);
        expect(
          last === undefined ? undefined : yield* Effect.promise(() => metadataOf(last)),
        ).not.toHaveProperty(["annotations", "workers/alias"]);
      }),
  );

  it.effect(
    "[deployer.token-header-only] the token goes in each call's Authorization header and nowhere else, and no failure carries it",
    () =>
      Effect.gen(function* () {
        const cf = cloudflare([
          [`GET ${A}/workers/workers/worker-lite`, exists],
          [`GET ${A}/workers/scripts/worker-lite/subdomain`, previewsOn],
          [
            `POST ${A}/workers/scripts/worker-lite/versions`,
            {
              status: 400,
              body: {
                success: false,
                errors: [{ code: 10021, message: "Uncaught Error: boom" }],
              },
            },
          ],
        ]);
        const exit = yield* Effect.exit(preview().pipe(Effect.provide(cf.layer)));
        expect(cf.seen.map((s) => s.headers.authorization)).toEqual(
          cf.seen.map(() => `Bearer ${TOKEN}`),
        );
        for (const s of cf.seen) {
          expect(s.url).not.toContain(TOKEN);
          const metadata =
            s.body instanceof FormData ? yield* Effect.promise(() => metadataOf(s)) : s.body;
          expect(JSON.stringify(metadata ?? "")).not.toContain(TOKEN);
        }
        expect(JSON.stringify(exit)).not.toContain(TOKEN);
      }),
  );

  it.effect(
    "[deployer.failures] a Worker Cloudflare refuses is refused with its message, a refused token and an unreachable provider are not the change's, and version addresses switched off are the owner's to turn on",
    () =>
      Effect.gen(function* () {
        const existing = [
          [`GET ${A}/workers/workers/worker-lite`, exists],
          [`GET ${A}/workers/scripts/worker-lite/subdomain`, previewsOn],
        ] as const;
        expect(
          yield* failed([
            ...existing,
            [
              `POST ${A}/workers/scripts/worker-lite/versions`,
              {
                status: 400,
                body: {
                  success: false,
                  errors: [{ code: 10021, message: "Uncaught Error: boom" }],
                },
              },
            ],
          ]),
        ).toBe("refused 10021 Cloudflare refused it (400): Uncaught Error: boom");
        expect(
          yield* failed([
            [
              `GET ${A}/workers/workers/worker-lite`,
              {
                status: 401,
                body: {
                  success: false,
                  errors: [{ code: 10000, message: "Authentication error" }],
                },
              },
            ],
          ]),
        ).toBe(
          "token-refused 10000 Cloudflare refused the deploy target's token (401): Authentication error",
        );
        expect(yield* failed([[`GET ${A}/workers/workers/worker-lite`, "no answer"]])).toBe(
          "unreachable - Cloudflare did not answer",
        );
        expect(
          yield* failed([
            ...existing,
            [`POST ${A}/workers/scripts/worker-lite/versions`, { status: 502, body: "<html>" }],
          ]),
        ).toBe("unreachable - Cloudflare answered 502");
        // Cloudflare's own 5xx, in its error envelope, is still Cloudflare's.
        expect(
          yield* failed([
            ...existing,
            [
              `POST ${A}/workers/scripts/worker-lite/versions`,
              {
                status: 503,
                body: {
                  success: false,
                  errors: [{ code: 10013, message: "An unknown error has occurred" }],
                },
              },
            ],
          ]),
        ).toBe("unreachable 10013 Cloudflare answered 503: An unknown error has occurred");
        expect(
          yield* failed([
            [`GET ${A}/workers/workers/worker-lite`, exists],
            [
              `GET ${A}/workers/scripts/worker-lite/subdomain`,
              {
                status: 200,
                body: { success: true, result: { enabled: true, previews_enabled: false } },
              },
            ],
          ]),
        ).toMatch(/^previews-off - worker-lite's version addresses are off/);
      }),
  );

  it.effect(
    "[deployer.promote] promoting sends all of the Worker's traffic to the one version, and a version deleted twice is gone either way",
    () =>
      Effect.gen(function* () {
        const cf = cloudflare([
          [
            `POST ${A}/workers/scripts/worker-lite/deployments`,
            { status: 200, body: { success: true, result: { id: "dep-1" } } },
          ],
          [
            `DELETE ${A}/workers/workers/worker-lite/versions/${VERSION}`,
            { status: 404, body: { success: false, errors: [{ code: 10007 }] } },
          ],
        ]);
        const deployer = yield* Deployer.pipe(Effect.provide(cf.layer));
        const promoted = yield* deployer.promote(ACCOUNT, Redacted.make(TOKEN), {
          worker: "worker-lite",
          versionId: VERSION,
          message: "keel: trunk at abc",
        });
        expect(promoted).toEqual({ deploymentId: "dep-1" });
        expect(jsonOf(cf.seen[0])).toEqual({
          strategy: "percentage",
          versions: [{ version_id: VERSION, percentage: 100 }],
          annotations: { "workers/message": "keel: trunk at abc" },
        });
        yield* deployer.deleteVersion(ACCOUNT, Redacted.make(TOKEN), {
          worker: "worker-lite",
          versionId: VERSION,
        });
        expect(cf.seen.map((s) => s.method)).toEqual(["POST", "DELETE"]);
      }),
  );
});
