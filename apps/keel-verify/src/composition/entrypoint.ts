import { WorkerEntrypoint } from "cloudflare:workers";
import { VerifierUnavailable } from "@keeltown/core/domain/verification";
import { Exit, Schema } from "effect";
import { worldReady } from "../adapters/driving/do/tier1/run-probe.ts";
import {
  type DepsAnswerJson,
  depsBoxName,
  DepsBuildRequest,
  DepsCodecs,
  encodeExit,
  ProbeRunRequest,
  VerifierCodecs,
  verifierName,
  WorldReadyRequest,
} from "../rpc/index.ts";

const decodeProbeRun = Schema.decodeUnknownExit(ProbeRunRequest);
const decodeWorldReady = Schema.decodeUnknownExit(WorldReadyRequest);
const decodeDepsBuild = Schema.decodeUnknownExit(DepsBuildRequest);

/**
 * keel-verify's front door, which keel reaches over its VERIFIER service
 * binding: /healthz; `runProbe`, which routes a probe run to the VerifierDO
 * for its (namespace, probe, world); `worldReady`, which answers from the
 * bundle store whether a probe could run against a world at all; and
 * `buildDeps`, which routes a deps build to the KeelDepsBox for its
 * (namespace, install digest).
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

  async worldReady(request: unknown) {
    const decoded = decodeWorldReady(request);
    if (Exit.isFailure(decoded))
      return encodeExit(
        VerifierCodecs.worldReady,
        Exit.fail(
          new VerifierUnavailable({ reason: "the world readiness request did not decode" }),
        ),
      );
    return encodeExit(
      VerifierCodecs.worldReady,
      Exit.succeed(await worldReady(this.env, decoded.value)),
    );
  }

  async buildDeps(request: unknown) {
    const decoded = decodeDepsBuild(request);
    if (Exit.isFailure(decoded))
      return encodeExit(
        DepsCodecs.build,
        Exit.succeed<DepsAnswerJson>({
          _tag: "DepsUnavailable",
          reason: "the deps build request did not decode",
        }),
      );
    return this.env.DEPSBOX.getByName(depsBoxName(decoded.value)).build(request);
  }
}
