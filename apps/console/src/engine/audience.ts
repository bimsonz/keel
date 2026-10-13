// Who Keel is reading a project's log to. Its members are read all of it.
// Anyone else is read the public part: Keel keeps for a project's members the
// questions put to a person and their rulings, an agent's enrolment, standing
// and sessions, and the project's settings. So for that reader the console
// has no question, no agent's class and no session, and cannot tell whether
// there are none or they were not shown. It says which is the case, and never
// counts what it was not read as nought. An agent's name is not among them:
// Keel reads its public card to anyone.

import type { AgentCard, NamespaceKind } from "../contract/keel/index.ts";
import type { ShownClass } from "../domain/state.ts";
import type { SourceDescriptor } from "../source/types.ts";
import type { AgentEntry } from "./world.ts";

/**
 * Whether this reader is read the public part of the project's log alone: someone Keel named no member of
 * the project's namespace, signed in or not. A test fixture's log is whole.
 */
export function publicOnly(descriptor: SourceDescriptor): boolean {
  return descriptor.mode === "live" && descriptor.project?.viewer === undefined;
}

/**
 * Who Keel reads the rest of a project's log to, as a page names them: an org's members, or the one whose
 * namespace the project is in. A person's namespace, and an agent's, has nobody in it but its owner. Where Keel
 * has not said whose the namespace is, they are the project's members and no more is claimed.
 */
export function membersOf(namespace: { handle: string; kind?: NamespaceKind }): string {
  if (namespace.kind === undefined) return "this project's members";
  return namespace.kind === "org" ? `the members of ${namespace.handle}` : namespace.handle;
}

/**
 * An agent's name for this reader, as the agents' pages give it: as Keel's public card of it has it, and as the
 * log enrolled it while its card is not read. An agent that signed itself up is enrolled in no project's log,
 * and a reader who is no member is read no enrolment, so for both the card is the only place the name is.
 * Absent where the reader has neither.
 */
export const agentName = (
  by: AgentEntry | undefined,
  card?: AgentCard | null,
): string | undefined => card?.name ?? by?.name;

/**
 * An agent as a page names it. Its class and its harness are its enrolment's alone: a card says what the agent
 * declared of itself, so an agent this reader's log has not enrolled is given no class, whatever its card says,
 * and is never taken for a kind of agent nobody said it was.
 */
export function shownAgent(
  by: AgentEntry | undefined,
  card?: AgentCard | null,
): {
  label: string;
  class: ShownClass;
  harness: string;
} {
  const label = agentName(by, card) ?? "Agent";
  return by === undefined
    ? { label, class: "unnamed", harness: "" }
    : { label, class: by.class, harness: by.harness };
}
