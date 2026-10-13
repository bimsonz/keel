// A project's settings, as a page offers to change them. Keel decides who may
// read them and who may replace them, and refuses the rest: this keeps a page
// from offering what Keel would refuse, and from making a project public on
// one slip of the hand.

import type { ProjectSettings, ProjectView } from "../contract/keel/index.ts";
import type { Visibility } from "./projects.ts";

/** Whether this reader is offered the project's settings: an owner or a maintainer of its namespace, as Keel named them. */
export function maintains(project: Pick<ProjectView, "viewer">): boolean {
  return project.viewer?.role === "owner" || project.viewer?.role === "maintainer";
}

/**
 * Whether making the project public is offered: once its name has been typed. A public project's code and
 * its log are read by anyone, so it is not one click. Making it private again is.
 */
export function mayPublish(project: { name: string }, typed: string): boolean {
  return typed === project.name;
}

/** The settings Keel holds, whole, with who may read the project changed and nothing else: Keel replaces them all. */
export function readBy(settings: ProjectSettings, visibility: Visibility): ProjectSettings {
  return { ...settings, visibility };
}
