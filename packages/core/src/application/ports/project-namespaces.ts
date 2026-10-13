import { Context, type Effect, type Option } from "effect";
import type {
  Handle,
  NamespaceFull,
  ProjectAudience,
  ProjectNameTaken,
  Visibility,
} from "../../domain/identity/index.ts";
import type { NamespaceId, NamespaceKind, ProjectId } from "../../domain/kernel/index.ts";

/** Where a project lives: its namespace, and its name there, the second segment of `/<namespace>/<project>`. */
export interface ProjectPlace {
  readonly projectId: ProjectId;
  readonly namespace: NamespaceId;
  readonly name: string;
}

/**
 * A project as a list shows it: its place, its visibility as its row mirrors
 * it, and what the policy reads of its namespace.
 */
export interface ListedProject extends ProjectPlace {
  readonly visibility: Visibility;
  readonly handle: Handle;
  readonly kind: NamespaceKind;
  /** A person's ban while it holds, or an org suspended by whoever runs the instance. */
  readonly suspended: boolean;
}

/** How many projects a namespace may hold once an assignment is made. */
export interface NamespaceRoom {
  readonly atMost: number;
}

/**
 * Each project's namespace and name. Keel owns them, in its D1 `projects`
 * table, written when a project is created. A name is held lower-case, unique
 * in its namespace and found in any case. Assigning a project the place it has
 * is a no-op; a name another project of the namespace holds, or another place
 * for a placed project (a project never moves), is ProjectNameTaken.
 *
 * An assignment given `room` is made only while the namespace holds fewer
 * projects than `atMost`, decided with the write, so two at once never both
 * take the last place: otherwise it is NamespaceFull, with the number held. A
 * taken name is told first, and a repeat of a project's own place is a no-op
 * however many the namespace holds.
 *
 * The row also mirrors the project's visibility, so a list is narrowed where
 * it is read. The Project object stays the authority: it writes the mirror
 * after each settings commit that moves it, and a new row reads `private`, as
 * a new project is.
 */
export class ProjectNamespaces extends Context.Service<
  ProjectNamespaces,
  {
    readonly assign: (
      place: ProjectPlace,
      room?: NamespaceRoom,
    ) => Effect.Effect<void, ProjectNameTaken | NamespaceFull>;
    /**
     * Gives a project's place back, so its name is free in its namespace
     * again. For a project that was never made (its start was refused, and
     * nothing of it exists): a project that exists keeps its place for good.
     * Releasing a project with no place is a no-op.
     */
    readonly release: (projectId: ProjectId) => Effect.Effect<void>;
    readonly byId: (projectId: ProjectId) => Effect.Effect<Option.Option<ProjectPlace>>;
    readonly byName: (
      namespace: NamespaceId,
      name: string,
    ) => Effect.Effect<Option.Option<ProjectPlace>>;
    /** The namespace's projects, by name. */
    readonly inNamespace: (namespace: NamespaceId) => Effect.Effect<readonly ProjectPlace[]>;
    /**
     * A page of the projects an audience is shown, by id, up to `limit` after
     * `after`: the public ones, those of the audience's namespaces, and its
     * one project. It narrows and decides nothing: the policy decides every
     * row. A project whose namespace's account is gone is left out.
     */
    readonly shownTo: (
      audience: ProjectAudience,
      after: ProjectId | undefined,
      limit: number,
    ) => Effect.Effect<readonly ListedProject[]>;
    /**
     * Mirrors a project's visibility as its settings event of `seq` left it.
     * A write whose seq is not above the row's changes nothing, so a late or
     * repeated one never moves the row back; nor does one for a project with
     * no place.
     */
    readonly visibility: (
      projectId: ProjectId,
      visibility: Visibility,
      seq: number,
    ) => Effect.Effect<void>;
  }
>()("keel/ProjectNamespaces") {}
