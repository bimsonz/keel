// Who Keel is reading a project's log to. Its members are read all of it.
// Anyone else is read the public part: Keel keeps for a project's members the
// questions put to a person and their rulings, an agent's enrolment, standing
// and sessions, and the project's settings. So for that reader the console
// has no question, no agent's name and no session, and cannot tell whether
// there are none or they were not shown. It says which is the case, and never
// counts what it was not read as nought.

import type { ShownClass } from "../domain/state.ts";
import type { SourceDescriptor } from "../source/types.ts";
import type { AgentEntry } from "./world.ts";

/**
 * Whether this reader is read the public part of the project's log alone: someone Keel named no member of
 * the project's org, signed in or not. A test fixture's log is whole.
 */
export function publicOnly(descriptor: SourceDescriptor): boolean {
  return descriptor.mode === "live" && descriptor.project?.viewer === undefined;
}

/**
 * An agent as a page names it. One Keel has not named to this reader is shown as unnamed: it is never taken
 * for a kind of agent nobody said it was.
 */
export function shownAgent(by: AgentEntry | undefined): {
  label: string;
  class: ShownClass;
  harness: string;
} {
  return by === undefined
    ? { label: "Agent", class: "unnamed", harness: "" }
    : { label: by.name, class: by.class, harness: by.harness };
}
