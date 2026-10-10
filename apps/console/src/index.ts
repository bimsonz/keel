export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "keel-console" });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
