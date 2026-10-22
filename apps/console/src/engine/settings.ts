// A project's settings, as a page offers to change them. Keel decides who may
// read them and who may replace them, and refuses the rest: this keeps a page
// from offering what Keel would refuse, and from making a project public on
// one slip of the hand.

import type { ProjectSettings, ProjectView, UpstreamSync } from "../contract/keel/index.ts";
import type { Visibility } from "./projects.ts";

/** Whether this reader owns the project's namespace, as Keel named them: its deploy targets are an owner's alone. */
export function owns(project: Pick<ProjectView, "viewer">): boolean {
  return project.viewer?.role === "owner";
}

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

/** Whether forks may propose to the project, as a page says it. */
export type ProposalsSaid = "open" | "closed" | "none";

/** The settings Keel holds, whole, with whether forks may propose changed and nothing else. */
export function proposalsBy(
  settings: ProjectSettings,
  proposals: "open" | "closed",
): ProjectSettings {
  return { ...settings, proposals };
}

/**
 * Whether forks may propose to the project: as its settings say for a public one (open until a PUT closes
 * them, and for settings kept before there was the setting); a private project takes none, whatever they say.
 */
export function proposalsSaid(settings: ProjectSettings): ProposalsSaid {
  if (settings.visibility !== "public") return "none";
  return settings.proposals ?? "open";
}

/** A ref as a code host names its branch: `refs/heads/main` is `main`. */
export function branchOf(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * Keel's answer to a sync, as a code host says it: already level with upstream, how far trunk moved, or the move
 * Keel is still finishing, which its feed then shows.
 */
export function syncedSaid(outcome: Pick<UpstreamSync, "from" | "to" | "synced">): string {
  const from = outcome.from.slice(0, 7);
  const to = outcome.to.slice(0, 7);
  if (outcome.synced) return `Fast-forwarded trunk from ${from} to ${to}.`;
  return outcome.from === outcome.to
    ? "Already up to date."
    : `Fast-forwarding trunk from ${from} to ${to}.`;
}
