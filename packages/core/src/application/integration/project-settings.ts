import { Effect, Result, Schema } from "effect";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import { ProjectNotFound, ProjectSettingsChanged } from "../../domain/integration/index.ts";
import {
  type Actor,
  canonicalJson,
  contentHashOf,
  type EntityRef,
  Glob,
  type Json,
  type ProjectId,
} from "../../domain/kernel/index.ts";
import {
  type Clock,
  commit,
  EntityStore,
  type EventDraft,
  type EventOutbox,
  type ProjectSettings,
  type PutProjectSettings,
  type Stored,
  type Transaction,
  type Transition,
} from "../ports/index.ts";
import { PROJECT } from "./create-project.ts";

/** Where the Project DO keeps its settings, keyed by the project id: absent until a PUT first changes one. */
export const PROJECT_SETTINGS = "project-settings";

/**
 * A project's settings before any PUT. `maxBatchSize` is 1 because the L1
 * lane forms batches of one, and the console must not show a setting the lane
 * does not honour; C4.1 sets the real default.
 */
export const DEFAULT_SETTINGS: ProjectSettings = {
  protectedPaths: [],
  maxBatchSize: 1,
  verification: "required",
  visibility: "private",
};

/**
 * Where it remembers each settings request it took, by request id: the hash of
 * the settings the request carried. An unchanged PUT commits no event to
 * replay by, so the request is remembered here as well.
 */
export const SETTINGS_REQUEST = "settings-request";

const SettingsRequest = Schema.Struct({ fingerprint: Schema.String });

/** Settings stored before `visibility` existed hold none, and read as `private`. */
const StoredSettings = Schema.Struct({
  protectedPaths: Schema.Array(Glob),
  maxBatchSize: Schema.Int,
  verification: Schema.Literals(["required", "off"]),
  visibility: Schema.optional(Schema.Literals(["private", "public"])),
});

/** The fields a PUT replaces, in the order ProjectSettingsChanged lists them. */
const FIELDS = ["protectedPaths", "maxBatchSize", "verification", "visibility"] as const;

export interface ChangeSettings {
  readonly projectId: ProjectId;
  readonly settings: PutProjectSettings;
  /** The id of whoever changes them: the event's `by`. */
  readonly by: string;
  /** The same actor as the envelope names it (`user:<id>`): the commit's actor. */
  readonly actor: Actor;
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
  return { ...stored, visibility: stored.visibility ?? "private" };
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
 * Replaces the project's settings under operator authority (an absent
 * `verification` is `required`, an absent `visibility` `private`). One ProjectSettingsChanged audits every field
 * the PUT changes, from and to; an unchanged PUT commits nothing, so a retry
 * is a no-op by content. The cause is `settings:<requestId>`: a replay of the
 * request answers the settings as they stand, and the same request id with
 * other settings is IdempotencyConflict.
 */
export const changeSettings: (
  command: ChangeSettings,
) => Effect.Effect<
  ProjectSettings,
  ProjectNotFound | IdempotencyConflict,
  Clock | EntityStore | EventOutbox
> = Effect.fn("integration/changeSettings")(function* (command: ChangeSettings) {
  const { projectId, by, actor, requestId } = command;
  const next: ProjectSettings = {
    protectedPaths: command.settings.protectedPaths,
    maxBatchSize: command.settings.maxBatchSize,
    verification: command.settings.verification ?? "required",
    visibility: command.settings.visibility ?? "private",
  };
  const fingerprint = contentHashOf(asJson(next));
  const conflict = new IdempotencyConflict({ idempotencyKey: requestId });
  const entity: EntityRef = { kind: "project", id: projectId };
  const committed = yield* commit(
    {
      entity,
      cause: `settings:${requestId}`,
      fingerprint,
      actor,
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
      const changes = changesBetween(held(tx.store, projectId), next);
      if (changes.length === 0) return Result.succeed({ value: next, drafts: [] });
      tx.store.put(PROJECT_SETTINGS, projectId, asStored(encodeSettings(next)));
      const changed = ProjectSettingsChanged.make({ projectId, changes, by });
      return Result.succeed({
        value: next,
        drafts: [{ payload: payloadOf(encodeChanged(changed)) }],
      });
    },
  );
  if (!committed.duplicate) return committed.value;
  return committed.sameCommand ? yield* settingsOf(projectId) : yield* conflict;
});
