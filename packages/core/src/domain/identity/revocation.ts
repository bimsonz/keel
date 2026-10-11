import type { AgentId } from "../kernel/index.ts";
import type { Agent } from "./agent.ts";
import type { MembershipChanged } from "./events.ts";

/**
 * The agents a membership change revokes: ending a user's membership of an
 * org revokes every agent it sponsored there that is not already revoked. A
 * change of role revokes nothing; an agent's rights follow its sponsor's role
 * through `authorize`.
 */
export const revokedBy = (
  change: typeof MembershipChanged.Type,
  agents: readonly Agent[],
): AgentId[] =>
  change.to !== undefined
    ? []
    : agents
        .filter(
          (agent) =>
            agent.state !== "revoked" &&
            agent.org === change.orgId &&
            agent.sponsor === change.userId,
        )
        .map((agent) => agent.id);
