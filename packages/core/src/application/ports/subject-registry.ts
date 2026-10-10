import { Context, type Effect, type Option } from "effect";
import type { SubjectKey } from "../../domain/coordination/index.ts";
import type { Anchor, ProjectId, SubjectId } from "../../domain/kernel/index.ts";

export interface SubjectEntry {
  readonly id: SubjectId;
  readonly key: SubjectKey;
  readonly anchors: readonly Anchor[];
  readonly gloss: string;
}

/** The project's subjects: resolve by key or anchor, mint when normalisation finds none. */
export class SubjectRegistry extends Context.Service<SubjectRegistry, {
  readonly byKey: (projectId: ProjectId, key: SubjectKey) => Effect.Effect<Option.Option<SubjectEntry>>;
  readonly byAnchor: (projectId: ProjectId, anchor: Anchor) => Effect.Effect<readonly SubjectEntry[]>;
  readonly mint: (
    projectId: ProjectId,
    entry: Omit<SubjectEntry, "id">,
    mintedBy: "scan" | "clef" | "agent",
  ) => Effect.Effect<SubjectEntry>;
}>()("keel/SubjectRegistry") {}
