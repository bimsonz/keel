import { Effect, Result, Schema } from "effect";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import { ProjectNotFound, ProjectSettingsChanged } from "../../domain/integration/index.ts";
import {
  type CommandActor,
  canonicalJson,
  contentHashOf,
  type EntityRef,
  Glob,
  type Json,
  type ProjectId,
  type RunRef,
} from "../../domain/kernel/index.ts";
import {
  type Clock,
  commit,
  EntityStore,
  type EventDraft,
  type EventOutbox,
  ProjectNamespaces,
  type ProjectSettings,
  type PutProjectSettings,
  type Stored,
  type Transaction,
  type Transition,
} from "../ports/index.ts";
import { PROJECT } from "./create-project.ts";
import { visibilityOf } from "./project-visibility.ts";

/** Where the Project DO keeps its settings, keyed by the project id: absent until a PUT first changes one. */
export const PROJECT_SETTINGS = "project-settings";

/**
 * A project's settings before any PUT. A lane batches up to `maxBatchSize`
 * changes, fewer as its recent failure rate rises.
 */
export const DEFAULT_SETTINGS: ProjectSettings = {
  protectedPaths: [],
  maxBatchSize: 8,
  verification: "required",
  visibility: "private",
  proposals: "open",
};

/**
 * Where it remembers each settings request it took, by request id: the hash of
 * the settings the request carried. An unchanged PUT commits no event to
 * replay by, so the request is remembered here as well.
 */
export const SETTINGS_REQUEST = "settings-request";

const SettingsRequest = Schema.Struct({ fingerprint: Schema.String });

/** Settings stored before `visibility` existed hold none, and read as `private`; before `proposals`, as `open`. */
const StoredSettings = Schema.Struct({
  protectedPaths: Schema.Array(Glob),
  maxBatchSize: Schema.Int,
  verification: Schema.Literals(["required", "off"]),
  visibility: Schema.optional(Schema.Literals(["private", "public"])),
  proposals: Schema.optional(Schema.Literals(["open", "closed"])),
});

/** The fields a PUT replaces, in the order ProjectSettingsChanged lists them. */
const FIELDS = [
  "protectedPaths",
  "maxBatchSize",
  "verification",
  "visibility",
  "proposals",
] as const;

export interface ChangeSettings {
  readonly projectId: ProjectId;
  readonly settings: PutProjectSettings;
  /** The id of whoever changes them: the event's `by`. */
  readonly by: string;
  /** The same actor as the envelope names it (`user:<id>`, `agent:<id>`): the commit's actor. */
  readonly actor: CommandActor;
  /** The run an agent changes them in, when its token named one: the run the event names. */
  readonly run?: RunRef | undefined;
  /** The request that carried the PUT. */
  readonly requestId: string;
}

type Store = Transaction["store"];

const decodeRequest = Schema.decodeUnknownSync(SettingsRequest);
const decodeSettings = Schema.decodeUnknownSync(StoredSettings);
const encodeSettings = Schema.encodeSync(StoredSettings);
const encodeChanged = Schema.encodeSync(ProjectSettingsChanged);
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));

const created = (store: Store, projectId: ProjectId): boolean =>
  store.get(PROJECT, projectId) !== undefined;

const held = (store: Store, projectId: ProjectId): ProjectSettings => {
  const value = store.get(PROJECT_SETTINGS, projectId);
  if (value === undefined) return DEFAULT_SETTINGS;
  const stored = decodeSettings(value);
  return {
    ...stored,
    visibility: stored.visibility ?? "private",
    proposals: stored.proposals ?? "open",
  };
};

/** Each field whose JSON value differs between the two, with both values. */
const changesBetween = (from: ProjectSettings, to: ProjectSettings) =>
  FIELDS.flatMap((field) => {
    const before = asJson(from[field]);
    const after = asJson(to[field]);
    return canonicalJson(before) === canonicalJson(after)
      ? []
      : [{ field, from: before, to: after }];
  });

/** The project's settings, the defaults until a PUT changes them; ProjectNotFound before the project is created. */
export const settingsOf: (
  projectId: ProjectId,
) => Effect.Effect<ProjectSettings, ProjectNotFound, EntityStore> = Effect.fn(
  "integration/settingsOf",
)(function* (projectId: ProjectId) {
  const store = yield* EntityStore;
  if (!created(store, projectId)) return yield* new ProjectNotFound({ projectId });
  return held(store, projectId);
});

/**
 * Replaces the project's settings as whoever governs it, a person or an agent
 * in a namespace of its own. An optional field the PUT leaves out
 * (`verification`, `visibility`, `proposals`) keeps what is stored, so a
 * client that does not know a field never changes it. One
 * ProjectSettingsChanged audits every field the PUT changes, from and to,
 * under the actor and the run the command names; an unchanged PUT commits
 * nothing, so a retry is a no-op by content. The cause is
 * `settings:<requestId>`: a replay of the request, as it was sent, answers the
 * settings as they stand, whatever moved since, and the same request id with
 * other settings is IdempotencyConflict.
 *
 * A change of visibility is written to the project's place before answering,
 * guarded by the event's seq, so the next list is narrowed by it and no later
 * write moves the row back; the Projector repeats the write on delivery, which
 * repairs a crash between the commit and the row. A replay writes again.
 */
export const changeSettings: (
  command: ChangeSettings,
) => Effect.Effect<
  ProjectSettings,
  ProjectNotFound | IdempotencyConflict,
  Clock | EntityStore | EventOutbox | ProjectNamespaces
> = Effect.fn("integration/changeSettings")(function* (command: ChangeSettings) {
  const { projectId, by, actor, run, requestId } = command;
  // The request as it was sent: what it leaves out is filled from what is stored, which may move.
  const fingerprint = contentHashOf(asJson(command.settings));
  const next = (store: Store): ProjectSettings => {
    const stored = held(store, projectId);
    return {
      protectedPaths: command.settings.protectedPaths,
      maxBatchSize: command.settings.maxBatchSize,
      verification: command.settings.verification ?? stored.verification,
      visibility: command.settings.visibility ?? stored.visibility,
      proposals: command.settings.proposals ?? stored.proposals,
    };
  };
  const conflict = new IdempotencyConflict({ idempotencyKey: requestId });
  const entity: EntityRef = { kind: "project", id: projectId };
  const committed = yield* commit(
    {
      entity,
      cause: `settings:${requestId}`,
      fingerprint,
      actor,
      ...(run === undefined ? {} : { run }),
      project: projectId,
    },
    (tx): Result.Result<Transition<ProjectSettings>, ProjectNotFound | IdempotencyConflict> => {
      if (!created(tx.store, projectId)) return Result.fail(new ProjectNotFound({ projectId }));
      const seen = tx.store.get(SETTINGS_REQUEST, requestId);
      if (seen !== undefined)
        return decodeRequest(seen).fingerprint === fingerprint
          ? Result.succeed({ value: held(tx.store, projectId), drafts: [] })
          : Result.fail(conflict);
      tx.store.put(SETTINGS_REQUEST, requestId, { fingerprint });
      const replaced = next(tx.store);
      const changes = changesBetween(held(tx.store, projectId), replaced);
      if (changes.length === 0) return Result.succeed({ value: replaced, drafts: [] });
      tx.store.put(PROJECT_SETTINGS, projectId, asStored(encodeSettings(replaced)));
      const changed = ProjectSettingsChanged.make({ projectId, changes, by });
      return Result.succeed({
        value: replaced,
        drafts: [{ payload: payloadOf(encodeChanged(changed)) }],
      });
    },
  );
  const places = yield* ProjectNamespaces;
  for (const event of committed.events) {
    const moved = visibilityOf(event);
    if (moved !== undefined) yield* places.visibility(moved.projectId, moved.visibility, moved.seq);
  }
  if (!committed.duplicate) return committed.value;
  return committed.sameCommand ? yield* settingsOf(projectId) : yield* conflict;
});
