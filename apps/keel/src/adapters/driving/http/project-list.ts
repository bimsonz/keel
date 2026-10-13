import {
  personOwns,
  type Principal,
  projectAudience,
  type ProjectResource,
  roleOf,
} from "@keeltown/core/domain/identity";
import type { ProjectId } from "@keeltown/core/kernel";
import { type ListedProject, ProjectNamespaces } from "@keeltown/core/ports";
import { Effect, Result } from "effect";
import { decideEach } from "./authorize-handlers.ts";

/** A listed project as the policy needs it, from its row alone: no Project object is read for a list. */
const resourceOf = (row: ListedProject): ProjectResource => ({
  _tag: "Project",
  namespace: row.namespace,
  projectId: row.projectId,
  visibility: row.visibility,
  namespaceSuspended: row.suspended,
  personOwned: personOwns(row.kind),
});

/** One page of a list of projects: the rows the policy granted, and the last row read when more may follow. */
export interface ListedPage {
  readonly items: readonly ListedProject[];
  readonly nextCursor?: ProjectId;
}

/**
 * A page of the projects `principal` may read. One query reads the rows its
 * audience is shown, and the policy decides every one of them from the row
 * (the project's read rule). The query only narrows, so a page can hold fewer
 * than `limit` items and still name a next cursor: the rows the policy refused
 * were read, and the next page starts after the last of them.
 */
export const listProjects = (
  principal: Principal,
  after: ProjectId | undefined,
  limit: number,
): Effect.Effect<ListedPage, never, ProjectNamespaces> =>
  Effect.gen(function* () {
    const rows = yield* ProjectNamespaces.use((places) =>
      places.shownTo(projectAudience(principal), after, limit),
    );
    const items = rows.filter((row) => Result.isSuccess(decideEach(principal, resourceOf(row))));
    const last = rows.at(-1);
    return rows.length < limit || last === undefined
      ? { items }
      : { items, nextCursor: last.projectId };
  });

/** The reader's role in a listed project's namespace: its owner's in their own, a member's in an org. */
export const viewerRole = (principal: Principal, row: ListedProject) =>
  principal._tag === "User" ? roleOf(principal, row.namespace) : undefined;
