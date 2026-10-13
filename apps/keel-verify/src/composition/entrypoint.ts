import { WorkerEntrypoint } from "cloudflare:workers";
import { VerifierUnavailable } from "@keeltown/core/domain/verification";
import { Exit, Schema } from "effect";
import { encodeExit, ProbeRunRequest, VerifierCodecs, verifierName } from "../rpc/index.ts";

const decodeProbeRun = Schema.decodeUnknownExit(ProbeRunRequest);

/**
 * keel-verify's front door, which keel reaches over its VERIFIER service
 * binding: /healthz, and `runProbe`, which routes a probe run to the
 * VerifierDO for its (namespace, probe, world).
 */
export class KeelVerifyEntrypoint extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, service: "keel-verify" });
    return new Response("Not found", { status: 404 });
  }

  async runProbe(request: unknown) {
    const decoded = decodeProbeRun(request);
    if (Exit.isFailure(decoded))
      return encodeExit(
        VerifierCodecs.runProbe,
        Exit.fail(new VerifierUnavailable({ reason: "the probe run request did not decode" })),
      );
    return this.env.VERIFIER.getByName(verifierName(decoded.value)).runProbe(request);
  }
}
