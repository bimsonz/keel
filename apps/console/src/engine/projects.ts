// Which project an event belongs to, and the projects a log has named.
//
// One Keel holds several projects, and an observer reads the log of all of
// them. A project's pages are folded from its own events and no other's, so
// that what one project lands, parks or questions is never counted in
// another.

import type { AnyEvent } from "../contract/events.ts";
import type { ProjectSettings } from "../contract/keel/index.ts";

export type Visibility = NonNullable<ProjectSettings["visibility"]>;

export interface ProjectEntry {
  id: string;
  name: string;
  /** Who may read it. Keel creates a project private, and says when that changes. */
  visibility: Visibility;
  /** True once its trunk has advanced with verification switched off. */
  unverified: boolean;
}

/** The project an event belongs to: the one Keel stamped on it, or failing that the one its own payload names. */
export function projectOf(event: AnyEvent): string | undefined {
  if (event.project !== undefined) return event.project;
  const named: unknown = "projectId" in event.payload ? event.payload.projectId : undefined;
  return typeof named === "string" ? named : undefined;
}

/** The projects Keel's log has named, in the order it named them. */
export class Projects {
  readonly #byId = new Map<string, ProjectEntry>();

  /** Reads one event of the log. True when what is known of the projects changed. */
  note(event: AnyEvent): boolean {
    if (event.type === "ProjectCreated") {
      const { projectId: id, name } = event.payload;
      if (this.#byId.has(id)) return false;
      this.#byId.set(id, { id, name, visibility: "private", unverified: false });
      return true;
    }
    if (event.type === "TrunkAdvanced" && event.payload.verified === false) {
      const entry = this.#byId.get(projectOf(event) ?? "");
      if (entry === undefined || entry.unverified) return false;
      entry.unverified = true;
      return true;
    }
    if (event.type === "ProjectSettingsChanged") {
      const entry = this.#byId.get(event.payload.projectId);
      const to = event.payload.changes.findLast((change) => change.field === "visibility")?.to;
      if (entry === undefined || (to !== "public" && to !== "private") || entry.visibility === to)
        return false;
      entry.visibility = to;
      return true;
    }
    return false;
  }

  get list(): readonly ProjectEntry[] {
    return [...this.#byId.values()];
  }

  /** The project called `name`, if the log has named one. */
  named(name: string): ProjectEntry | undefined {
    return this.list.find((entry) => entry.name === name);
  }
}
