// The Worker keel-verify's test/live/p6-staging.ts drives: it runs core's
// draftProbe on exactly the layer the Probe Workflow composes,
// probeDraftingLayer, over this Worker's own bindings (p6-driver.wrangler.jsonc).
// The one addition is a tee on the AI stream that records the model each
// event says served it; the adapter reads the same stream, unchanged.
//
//   HEAD|PUT /r2/<key>   the bundle bucket, for the harness's world bundles
//   POST /draft          {pins, context, worlds, a} → {outcome, served, ms}; A-noop is built
//                        per draft from A's files (`a`) and the recipe the slots name
import {
  type DraftContext,
  draftProbe,
  FRESHNESS_TEMPLATE,
} from "@keeltown/core/application/verification";
import { Proposition } from "@keeltown/core/domain/coordination";
import { FlowWorld } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { Effect, Schema } from "effect";
import { BundleStoreR2 } from "../../src/adapters/driven/r2/bundle-store.ts";
import { noopWorld } from "../../src/adapters/driven/r2/noop-world.ts";
import type { StreamingAi } from "../../src/adapters/driven/workers-ai/platform-function.ts";
import { probeDraftingLayer } from "../../src/composition/workflow.ts";

interface DriverEnv {
  readonly AI: StreamingAi;
  readonly VERIFIER: Fetcher;
  readonly BUNDLES: R2Bucket;
}

const DraftRequest = Schema.Struct({
  pins: Schema.Unknown,
  context: Schema.Struct({
    premise: Proposition,
    effect: Proposition,
    anchors: Schema.Array(Schema.String),
    source: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })),
    hunks: Schema.Struct({ A: Schema.String, B: Schema.String }),
  }),
  worlds: Schema.Record(FlowWorld, ContentHash),
  /** A's files, base64: what A-noop is built from. */
  a: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      base64: Schema.String,
      executable: Schema.optional(Schema.Boolean),
    }),
  ),
});

/** Every `model` a server-sent event in `stream` names, read to its end. */
async function modelsIn(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const models = new Set<string>();
  const text = await new Response(stream).text();
  for (const line of text.split("\n")) {
    const data = line.trim();
    if (!data.startsWith("data:")) continue;
    try {
      const model: unknown = Reflect.get(Object(JSON.parse(data.slice(5).trim())), "model");
      if (typeof model === "string") models.add(model);
    } catch {
      // Not JSON ([DONE]): nothing to record.
    }
  }
  return [...models];
}

/** The AI binding with each streamed answer teed: one branch to the adapter, one read for the model it names. */
function recording(ai: StreamingAi, served: Promise<string[]>[]): StreamingAi {
  return {
    run: async (model, inputs) => {
      const answer = await ai.run(model, inputs);
      if (!(answer instanceof ReadableStream)) return answer;
      const [forAdapter, forRecord] = answer.tee();
      served.push(modelsIn(forRecord));
      return forAdapter;
    },
  };
}

async function draft(request: Request, env: DriverEnv): Promise<Response> {
  const body = Schema.decodeUnknownSync(DraftRequest)(await request.json());
  const served: Promise<string[]>[] = [];
  const context: DraftContext = body.context;
  const a = body.a.map((f) => ({
    path: f.path,
    bytes: Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)),
    ...(f.executable === true ? { executable: true } : {}),
  }));
  const aNoop = noopWorld(a);
  const started = Date.now();
  const outcome = await Effect.runPromise(
    draftProbe(FRESHNESS_TEMPLATE, context, body.worlds, (recipe) =>
      aNoop(recipe).pipe(Effect.provide(BundleStoreR2(env.BUNDLES))),
    ).pipe(
      Effect.provide(
        probeDraftingLayer({
          AI: recording(env.AI, served),
          PLATFORM_FUNCTION_PINS: body.pins,
          BUNDLES: env.BUNDLES,
          VERIFIER: env.VERIFIER,
        }),
      ),
    ),
  );
  const ms = Date.now() - started;
  return Response.json({ outcome, served: await Promise.all(served), ms });
}

async function r2(request: Request, env: DriverEnv, key: string): Promise<Response> {
  if (request.method === "HEAD")
    return new Response(null, { status: (await env.BUNDLES.head(key)) === null ? 404 : 200 });
  if (request.method === "PUT") {
    await env.BUNDLES.put(key, await request.arrayBuffer());
    return new Response(null, { status: 204 });
  }
  return new Response("method not allowed", { status: 405 });
}

export default {
  async fetch(request: Request, env: DriverEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/r2/")) return r2(request, env, pathname.slice("/r2/".length));
    if (pathname === "/draft" && request.method === "POST")
      // A draft that fails (keel-verify unreachable, a defect) is reported as such, not as a 500 with no body.
      return draft(request, env).catch((error: unknown) =>
        Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        ),
      );
    return new Response("not found", { status: 404 });
  },
};
