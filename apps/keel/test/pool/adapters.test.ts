import { env } from "cloudflare:workers";
import {
  describeAgentDirectoryContract,
  describeTokenIssuerContract,
  makeClockMemory,
} from "@keeltown/testing";
import { Layer } from "effect";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { TokenIssuerJose } from "../../src/adapters/driven/jose/token-issuer.ts";

// The real adapters pass the same contract suites as the in-memory ones, inside workerd.
describeAgentDirectoryContract("d1", () => AgentDirectoryD1(env.DB));
describeTokenIssuerContract("jose ed25519", () =>
  TokenIssuerJose({ privateJwk: env.KEEL_SIGNING_KEY, issuer: "keel.localhost" }).pipe(
    Layer.provide(makeClockMemory().layer),
  ),
);
