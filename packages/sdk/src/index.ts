/** Typed client for Keel's public API. No runtime dependencies; types from `@keeltown/contracts`. */
export { createKeelClient, KeelClient } from "./client.ts";
export type {
  CallOptions,
  Idempotent,
  KeelClientOptions,
  KeyClientOptions,
  PublicClientOptions,
  SessionClientOptions,
} from "./client.ts";
export {
  clientAssertion,
  discover,
  dpopProof,
  generateAgentKey,
  runKey,
  signerFromJwk,
  signUp,
  thumbprint,
} from "./agent-key.ts";
export type {
  AgentSigner,
  Discovered,
  PrivateJwk,
  ProofRequest,
  PublicJwk,
  SignedUp,
  SignUpRequest,
} from "./agent-key.ts";
export { KeelProblem, KeelTokenError } from "./problem.ts";
export type { ProblemBody, ProblemIssue } from "./problem.ts";
export { ROUTES } from "./routes.ts";
export type { Route, RoutedOperation } from "./routes.ts";
