// An org's agents, in words: what an invitation gives, where it stands, who answers for it, and who is offered
// its removal. Every one is a field of Keel's own row, set beside the org's members where the row names one.

import type { AgentProfile, NamespaceAgent, Scope } from "../contract/keel/index.ts";
import type { Member } from "./account.ts";
import { type Role, manages } from "./roles.ts";

/** What an invitation gives an agent: to read, or to read and work. Keel takes these two sets and no other. */
export type Grant = "work" | "read";

export const SCOPES: Record<Grant, readonly Scope[]> = {
  work: ["agent:read", "agent:work"],
  read: ["agent:read"],
};

export const GRANTS: readonly { grant: Grant; label: string }[] = [
  { grant: "work", label: "Write" },
  { grant: "read", label: "Read" },
];

/** A row's role: what its invitation gives. Nothing where Keel named no scopes: it names them to members alone. */
export function givenOf(agent: NamespaceAgent): string {
  if (agent.scopes === undefined) return "";
  return agent.scopes.includes("agent:work") ? "Write" : "Read";
}

/** Where an invitation stands, and from what day where Keel says when the agent joined. */
export function standingOf(agent: NamespaceAgent): string {
  if (agent.state === "invited") return "Pending";
  if (agent.state === "ended") return "Ended";
  return agent.joinedAt === undefined ? "Joined" : `Joined ${agent.joinedAt.slice(0, 10)}`;
}

/** What a row says of an agent whose inviter has left: Keel lets it do nothing in the org until it is invited again. */
export const INVITER_GONE = "Inactive: inviter left the org";

/**
 * Who invited an agent, and so answers for it here: the member whose account Keel's row names. Keel's gate
 * lets an agent act in an org only while whoever invited it is a member, and keeps the row as it was when
 * they leave, so a row that names no member says that. Nothing where the row names nobody.
 */
export function inviterOf(agent: NamespaceAgent, members: readonly Member[]): string {
  if (agent.invitedBy === undefined) return "";
  const inviter = members.find((member) => member.userId === agent.invitedBy);
  if (inviter === undefined) return INVITER_GONE;
  return inviter.you
    ? "Invited by you"
    : `Invited by ${inviter.handle === undefined ? inviter.name : `@${inviter.handle}`}`;
}

/** Keel takes a removal from the member who invited the agent, from a maintainer and from an owner. */
export function mayRemove(agent: NamespaceAgent, role: Role, readerId: string): boolean {
  return manages(role) || agent.invitedBy === readerId;
}

/** What taking a row out is called: an invitation nobody answered is cancelled, an agent that joined removed. */
export function removalOf(agent: NamespaceAgent): "Remove" | "Cancel invitation" {
  return agent.state === "invited" ? "Cancel invitation" : "Remove";
}

/** The agents that have joined: all that anyone but a member is read, and all an org's home lists. */
export function joinedOf(listed: readonly NamespaceAgent[]): NamespaceAgent[] {
  return listed.filter((agent) => agent.state === "joined");
}

/**
 * The agents the reader sponsors to offer for an invitation, as a code host's "Add people" suggests people: with
 * nothing typed, each of them; with something typed, those whose handle or name holds it. One the org has invited
 * or that has joined (`listed`) is not offered again. Only an agent with a handle can be invited, so only those are
 * offered; one whose handle was typed whole is already chosen.
 */
export function sponsoredMatching(
  sponsored: readonly AgentProfile[],
  typed: string,
  listed: readonly NamespaceAgent[] = [],
): AgentProfile[] {
  const asked = typed.trim().toLowerCase();
  if (asked !== "" && sponsored.some((agent) => agent.handle?.toLowerCase() === asked)) return [];
  const taken = new Set(listed.filter((agent) => agent.state !== "ended").map((agent) => agent.id));
  return sponsored.filter(
    (agent) =>
      agent.handle !== undefined &&
      !taken.has(agent.id) &&
      (agent.handle.toLowerCase().includes(asked) || agent.name.toLowerCase().includes(asked)),
  );
}

/**
 * The handle Keel is asked to invite: what was typed, unless it is the name of exactly one agent the reader
 * sponsors, whose handle it is then. Keel invites by handle alone.
 */
export function handleFor(sponsored: readonly AgentProfile[], typed: string): string {
  const asked = typed.trim();
  const named = sponsored.filter(
    (agent) => agent.handle !== undefined && agent.name.toLowerCase() === asked.toLowerCase(),
  );
  const [only] = named;
  return named.length === 1 && only?.handle !== undefined ? only.handle : asked;
}
