import { Schema } from "effect";
import { AgentId, InstantSchema, ProjectId } from "../kernel/index.ts";
import { Agent, type Principal } from "./agent.ts";

/**
 * The bootstrap credential: how a new deployment gets its first operator.
 * Its secret is a Worker secret (KEEL_BOOTSTRAP_SECRET), exchanged under
 * `BOOTSTRAP_CLIENT_ID` for an operator-scoped token. That token may enrol
 * agents and nothing else; the real operator it enrols does the rest. The
 * agent is never stored, so no D1 row can be read for it or revoked: rotating
 * the secret retires it.
 */
export const BOOTSTRAP_CLIENT_ID = "keel-bootstrap";

/** Fixed ids, in Crockford base32 (no I, L, O or U). */
export const BOOTSTRAP_AGENT_ID = Schema.decodeSync(AgentId)("agt_0B00TSTRAP0000000000000000");

/** The project the platform's own agents belong to: the bootstrap operator and the operators it enrols. */
export const PLATFORM_PROJECT_ID = Schema.decodeSync(ProjectId)("prj_0SYSTEM0000000000000000000");

export const BOOTSTRAP_AGENT: Agent = Schema.decodeSync(Agent)({
  id: BOOTSTRAP_AGENT_ID,
  projectId: PLATFORM_PROJECT_ID,
  name: "bootstrap",
  kind: "hosted",
  scopes: ["operator"],
  state: "active",
  revocationEpoch: 0,
  createdAt: Schema.decodeSync(InstantSchema)(0),
});

/** Whether a verified token is the bootstrap credential's. */
export const isBootstrap = (principal: Principal | null): boolean =>
  principal?.agentId === BOOTSTRAP_AGENT_ID;
