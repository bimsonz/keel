// The Worker p4-staging.ts drives staging through, run locally by wrangler
// with remote bindings (p4-staging.wrangler.jsonc): calls fan out from inside
// workerd, so runs sent together reach keel-verify together. A Node-side
// binding proxy resolves each call synchronously and would send them one by one.
//
//   HEAD|PUT /r2/<key>   the bundle bucket
//   POST /run            [encoded ProbeRunRequest, …] → [{from, to, reply}, …],
//                        all sent at once, `from` and `to` in ms since the batch began

/** The two bindings, as far as the driver uses them. */
interface DriverEnv {
  readonly VERIFIER: { runProbe(request: unknown): Promise<unknown> };
  readonly BUNDLES: {
    head(key: string): Promise<unknown>;
    put(key: string, value: ArrayBuffer): Promise<unknown>;
  };
}

const r2 = async (request: Request, env: DriverEnv, key: string): Promise<Response> => {
  if (request.method === "HEAD")
    return new Response(null, { status: (await env.BUNDLES.head(key)) === null ? 404 : 200 });
  if (request.method === "PUT") {
    await env.BUNDLES.put(key, await request.arrayBuffer());
    return new Response(null, { status: 204 });
  }
  return new Response("method not allowed", { status: 405 });
};

const run = async (request: Request, env: DriverEnv): Promise<Response> => {
  const requests: unknown = await request.json();
  if (!Array.isArray(requests)) return new Response("a JSON array of requests", { status: 400 });
  const began = Date.now();
  const replies = await Promise.all(
    requests.map(async (r: unknown) => {
      const from = Date.now() - began;
      const reply = await env.VERIFIER.runProbe(r);
      return { from, to: Date.now() - began, reply };
    }),
  );
  return Response.json(replies);
};

export default {
  async fetch(request: Request, env: DriverEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/r2/")) return r2(request, env, pathname.slice("/r2/".length));
    if (pathname === "/run" && request.method === "POST") return run(request, env);
    return new Response("not found", { status: 404 });
  },
};
