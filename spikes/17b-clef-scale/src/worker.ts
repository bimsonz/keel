// Spike Worker: a thin, authenticated pass-through to the Clef models on the
// AI binding. It times the binding call inside the Worker so that latency
// figures exclude the client's network round trip.

export interface Env {
  AI: Ai;
  SPIKE_TOKEN: string;
}

const ENDPOINTS = new Set(["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"]);

interface RunRequest {
  endpoint: string;
  input: Record<string, unknown>;
}

function errorShape(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const extra: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(err)) {
      if (key === "stack") continue;
      extra[key] = (err as unknown as Record<string, unknown>)[key];
    }
    return { name: err.name, constructor: err.constructor?.name, ...extra };
  }
  return { thrown: String(err) };
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (request.headers.get("authorization") !== `Bearer ${env.SPIKE_TOKEN}`) {
      return new Response("unauthorised", { status: 401 });
    }
    const body = (await request.json()) as RunRequest;
    if (!ENDPOINTS.has(body.endpoint)) return new Response("unknown endpoint", { status: 400 });

    const started = Date.now();
    try {
      const output = await env.AI.run(body.endpoint as Parameters<Ai["run"]>[0], body.input as never);
      return Response.json({ ok: true, ms: Date.now() - started, output });
    } catch (err) {
      return Response.json({ ok: false, ms: Date.now() - started, error: errorShape(err) });
    }
  },
} satisfies ExportedHandler<Env>;
