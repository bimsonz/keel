// An org's agents, in words: what an invitation gives, where it stands, who answers for it, and who is offered
// its removal. Every one is a field of Keel's own row, set beside the org's members where the row names one.

import type { NamespaceAgent, Scope } from "../contract/keel/index.ts";
import type { Member } from "./account.ts";
import { type Role, manages } from "./roles.ts";

/** What an invitation gives an agent: to read, or to read and work. Keel takes these two sets and no other. */
export type Grant = "work" | "read";

export const SCOPES: Record<Grant, readonly Scope[]> = {
  work: ["agent:read", "agent:work"],
  read: ["agent:read"],
};

export const GRANTS: readonly { grant: Grant; label: string }[] = [
  { grant: "work", label: "Read and work" },
  { grant: "read", label: "Read only" },
];

/** What a row's invitation gives. Nothing where Keel named no scopes: it names them to the org's members alone. */
export function givenOf(agent: NamespaceAgent): string {
  if (agent.scopes === undefined) return "";
  return agent.scopes.includes("agent:work") ? "reads and works" : "reads";
}

/** Where an invitation stands, and from what day where Keel says when the agent joined. */
export function standingOf(agent: NamespaceAgent): string {
  if (agent.state === "invited") return "invited, not yet accepted";
  if (agent.state === "ended") return "ended";
  return agent.joinedAt === undefined ? "joined" : `joined ${agent.joinedAt.slice(0, 10)}`;
}

/**
 * Who invited an agent, and so answers for it here: the member whose account Keel's row names. Keel's gate
 * lets an agent act in an org only while whoever invited it is a member, and keeps the row as it was when
 * they leave, so a row that names no member says that. Nothing where the row names nobody.
 */
export function inviterOf(agent: NamespaceAgent, members: readonly Member[]): string {
  if (agent.invitedBy === undefined) return "";
  const inviter = members.find((member) => member.userId === agent.invitedBy);
  if (inviter === undefined)
    return "invited by someone who is no longer a member, so it cannot act here";
  return inviter.you ? "invited by you" : `invited by ${inviter.handle ?? inviter.name}`;
}

/** Keel takes a removal from the member who invited the agent, from a maintainer and from an owner. */
export function mayRemove(agent: NamespaceAgent, role: Role, readerId: string): boolean {
  return manages(role) || agent.invitedBy === readerId;
}

/** What taking a row out is called: an invitation nobody answered is withdrawn, an agent that joined removed. */
export function removalOf(agent: NamespaceAgent): "Remove" | "Withdraw" {
  return agent.state === "invited" ? "Withdraw" : "Remove";
}

/** The agents that have joined: all that anyone but a member is read, and all an org's home lists. */
export function joinedOf(listed: readonly NamespaceAgent[]): NamespaceAgent[] {
  return listed.filter((agent) => agent.state === "joined");
}
