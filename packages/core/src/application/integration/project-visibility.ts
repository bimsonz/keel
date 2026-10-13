import { Effect, Schema } from "effect";
import { Visibility } from "../../domain/identity/index.ts";
import { ProjectSettingsChanged } from "../../domain/integration/index.ts";
import { type EventEnvelope, ProjectId } from "../../domain/kernel/index.ts";
import { EntityStore, ProjectNamespaces, type Stored } from "../ports/index.ts";

const decodeChanged = Schema.decodeUnknownOption(ProjectSettingsChanged);
const decodeVisibility = Schema.decodeUnknownOption(Visibility);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

/**
 * The visibility a project's settings event leaves it with, with the project
 * and the event's seq on the project's entity: what the guarded write of its
 * place's mirror takes. None for an event that leaves visibility as it was.
 */
export function visibilityOf(
  event: EventEnvelope,
):
  | { readonly projectId: ProjectId; readonly visibility: Visibility; readonly seq: number }
  | undefined {
  if (event.entity.kind !== "project" || event.type !== "ProjectSettingsChanged") return undefined;
  const changed = decodeChanged(event.payload);
  if (changed._tag === "None") return undefined;
  const moved = changed.value.changes.find((change) => change.field === "visibility");
  if (moved === undefined) return undefined;
  const visibility = decodeVisibility(moved.to);
  return visibility._tag === "Some"
    ? { projectId: changed.value.projectId, visibility: visibility.value, seq: event.seq }
    : undefined;
}

/**
 * The Projector's repair of the mirror: each visibility a settings event
 * leaves is noted here in the receipt's transaction (the newest per project),
 * and written once the transaction is done. The Project object's inline write
 * normally got there first, and the seq guard makes the repeat a no-op.
 */
export const VISIBILITY_PENDING = "visibility-pending";

const Pending = Schema.Struct({ visibility: Visibility, seq: Schema.Int });
const decodePending = Schema.decodeUnknownSync(Pending);

/** Notes the visibility a project's settings event leaves it with, for `repairVisibility`; any other event is ignored. */
export function noteVisibility(store: (typeof EntityStore)["Service"], event: EventEnvelope): void {
  const moved = visibilityOf(event);
  if (moved === undefined) return;
  const held = store.get(VISIBILITY_PENDING, moved.projectId);
  if (held !== undefined && decodePending(held).seq >= moved.seq) return;
  store.put(
    VISIBILITY_PENDING,
    moved.projectId,
    asStored({ visibility: moved.visibility, seq: moved.seq }),
  );
}

/**
 * Writes every noted visibility to its project's place, and forgets each once
 * written. A write that fails stays noted for the next delivery's repair.
 */
export const repairVisibility: Effect.Effect<void, never, EntityStore | ProjectNamespaces> =
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const places = yield* ProjectNamespaces;
    for (const { id, value } of store.list(VISIBILITY_PENDING)) {
      const pending = decodePending(value);
      const written = yield* Effect.exit(
        places.visibility(Schema.decodeUnknownSync(ProjectId)(id), pending.visibility, pending.seq),
      );
      if (written._tag === "Failure") continue;
      store.transaction(() => {
        const now = store.get(VISIBILITY_PENDING, id);
        if (now !== undefined && decodePending(now).seq === pending.seq)
          store.remove(VISIBILITY_PENDING, id);
      });
    }
  });
