export { KeelSandbox } from "./adapters/driving/do/keel-sandbox.ts";
export { VerifierDO } from "./adapters/driving/do/verifier.ts";
// The sandbox SDK's proxy, exported for the containers' outbound interception.
export { ContainerProxy } from "@cloudflare/sandbox";

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, service: "keel-verify" });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
