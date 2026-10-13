import { describe, expect, it } from "@effect/vitest";
import type { Actor } from "@keeltown/core/domain/identity";
import {
  type ChangeId,
  EventEnvelope,
  Glob,
  makeId,
  ProjectId,
  UserId,
} from "@keeltown/core/kernel";
import { Projects, type ProjectSettings } from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

/**
 * What the `Projects` suite needs beside the port: the name of a repo in the
 * core namespace that a project can fork its trunk from.
 */
export interface ProjectsHarness {
  readonly layer: Layer.Layer<Projects>;
  readonly source: string;
  /** A project that holds these settings. */
  readonly withSettings: (settings: ProjectSettings) => Effect.Effect<ProjectId>;
  /** Feeds the project's live index an event of one of its changes, as the fan-out would. */
  readonly hear: (projectId: ProjectId, event: EventEnvelope) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

/** A user the doorway let create the project. */
const creator = (): Actor => ({
  _tag: "User",
  userId: Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`),
});

const key = () => `key-${crypto.randomUUID()}`;

/** A project to create, under a fresh id and key: a real adapter's DOs outlive one case. */
const creating = (source: string, name = "forge") => ({
  projectId: Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`),
  name,
  source: { _tag: "Template" as const, repo: source },
  idempotencyKey: key(),
});

/** An event of `changeId` at `seq` on its log, encoded as the fan-out delivers it. */
const eventOf = (
  changeId: ChangeId,
  seq: number,
  payload: { readonly _tag: string } & Record<string, unknown>,
) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulid()),
    type: payload._tag,
    entity: { kind: "change", id: changeId },
    seq,
    at: Date.now(),
    dedupeKey: `change:${changeId}/cause-${seq}/${payload._tag}#1`,
    affected: [],
    notified: [],
    payload,
  });

const COMMIT = "c".repeat(40);
const anchor = (path: string, symbol?: string) => ({
  path,
  ...(symbol === undefined ? {} : { symbol }),
  commit: COMMIT,
});
const fresh = (subject: string, anchors?: readonly ReturnType<typeof anchor>[]) => ({
  subject,
  predicate: "freshness",
  relation: "is",
  value: "per-session",
  ...(anchors === undefined ? {} : { anchors }),
});
const declaring = (
  changeId: ChangeId,
  intent: { readonly premises: readonly unknown[]; readonly declaredEffects?: readonly unknown[] },
) =>
  eventOf(changeId, 1, {
    _tag: "IntentDeclared",
    changeId,
    agentId: makeId("agt", ulid()),
    origin: "agent",
    revision: 1,
    goal: "cache the sessions",
    footprint: [],
    leaseId: makeId("lse", ulid()),
    ...intent,
  });

export function describeProjectsContract(adapter: string, make: () => ProjectsHarness) {
  describe(`Projects contract: ${adapter}`, () => {
    it.live("creates the project it is given the id of, named as asked", () => {
      const harness = make();
      return Effect.gen(function* () {
        const input = creating(harness.source);
        const project = yield* (yield* Projects).create(creator(), input);
        expect(project.name).toBe("forge");
        expect(project.id).toBe(input.projectId);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("replays a retry with the same key and body: the same project", () => {
      const harness = make();
      return Effect.gen(function* () {
        const projects = yield* Projects;
        const by = creator();
        const input = creating(harness.source);
        const first = yield* projects.create(by, input);
        expect(yield* projects.create(by, input)).toEqual(first);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("refuses another body under a used key with IdempotencyConflict", () => {
      const harness = make();
      return Effect.gen(function* () {
        const projects = yield* Projects;
        const by = creator();
        const input = creating(harness.source);
        yield* projects.create(by, input);
        const reused = yield* Effect.flip(projects.create(by, { ...input, name: "other" }));
        expect(reused._tag).toBe("IdempotencyConflict");
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("fails RepoNotFound, naming the repo, for a source that does not exist", () => {
      const harness = make();
      return Effect.gen(function* () {
        const missing = `missing-${ulid().toLowerCase()}`;
        const error = yield* Effect.flip((yield* Projects).create(creator(), creating(missing)));
        expect(error._tag).toBe("RepoNotFound");
        if (error._tag === "RepoNotFound") expect(error.repo.name).toBe(missing);
      }).pipe(Effect.provide(harness.layer));
    });
    it.live("answers a project's settings as they were put", () => {
      const harness = make();
      return Effect.gen(function* () {
        const settings: ProjectSettings = {
          protectedPaths: [Glob.make("infra/**"), Glob.make(".github/workflows/*")],
          maxBatchSize: 4,
          verification: "required",
          visibility: "public",
        };
        const projectId = yield* harness.withSettings(settings);
        expect(yield* (yield* Projects).settings(projectId)).toEqual(settings);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "holds the defaults until a PUT: no protected paths, batches of one, verified, private",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const projects = yield* Projects;
          const project = yield* projects.create(creator(), creating(harness.source));
          expect(yield* projects.settings(project.id)).toEqual({
            protectedPaths: [],
            maxBatchSize: 1,
            verification: "required",
            visibility: "private",
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("replaces the settings a PUT names, an absent verification meaning required", () => {
      const harness = make();
      return Effect.gen(function* () {
        const projects = yield* Projects;
        const by = creator();
        const project = yield* projects.create(by, creating(harness.source));
        const off = { protectedPaths: [Glob.make("infra/**")], maxBatchSize: 1 } as const;
        const turnedOff = yield* projects.putSettings(
          by,
          project.id,
          { ...off, verification: "off" },
          "req-1",
        );
        const readOff = yield* projects.settings(project.id);
        const turnedOn = yield* projects.putSettings(by, project.id, off, "req-2");

        expect(turnedOff).toEqual({ ...off, verification: "off", visibility: "private" });
        expect(readOff).toEqual(turnedOff);
        expect(turnedOn).toEqual({ ...off, verification: "required", visibility: "private" });
        expect(yield* projects.settings(project.id)).toEqual(turnedOn);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "[b12.settings-visibility] keeps the visibility a PUT names, an absent one meaning private",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const projects = yield* Projects;
          const by = creator();
          const project = yield* projects.create(by, creating(harness.source));
          const put = { protectedPaths: [], maxBatchSize: 1 } as const;
          const published = yield* projects.putSettings(
            by,
            project.id,
            { ...put, visibility: "public" },
            "req-1",
          );
          const readPublic = yield* projects.settings(project.id);
          const hidden = yield* projects.putSettings(by, project.id, put, "req-2");

          expect(published.visibility).toBe("public");
          expect(readPublic.visibility).toBe("public");
          expect(hidden.visibility).toBe("private");
          expect((yield* projects.settings(project.id)).visibility).toBe("private");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("refuses other settings under a used request id with IdempotencyConflict", () => {
      const harness = make();
      return Effect.gen(function* () {
        const projects = yield* Projects;
        const by = creator();
        const project = yield* projects.create(by, creating(harness.source));
        const off = { protectedPaths: [], maxBatchSize: 1, verification: "off" } as const;
        const first = yield* projects.putSettings(by, project.id, off, "req-1");
        const replayed = yield* projects.putSettings(by, project.id, off, "req-1");
        const reused = yield* Effect.flip(
          projects.putSettings(by, project.id, { protectedPaths: [], maxBatchSize: 2 }, "req-1"),
        );

        expect(replayed).toEqual(first);
        expect(reused._tag).toBe("IdempotencyConflict");
        expect(yield* projects.settings(project.id)).toEqual(first);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("is ProjectNotFound for a PUT to a project that was never created", () => {
      const harness = make();
      return Effect.gen(function* () {
        const missing = Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
        const error = yield* Effect.flip(
          (yield* Projects).putSettings(
            creator(),
            missing,
            { protectedPaths: [], maxBatchSize: 1 },
            "req-1",
          ),
        );
        expect(error._tag).toBe("ProjectNotFound");
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("is ProjectNotFound for the settings of a project that was never created", () => {
      const harness = make();
      return Effect.gen(function* () {
        const missing = Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
        const error = yield* Effect.flip((yield* Projects).settings(missing));
        expect(error._tag).toBe("ProjectNotFound");
      }).pipe(Effect.provide(harness.layer));
    });
    it.live(
      "[b21.live-anchors] answers where the project's live changes anchor their subjects: declared and derived, each anchor once, gone with the change",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const projects = yield* Projects;
          const projectId = Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
          const other = Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
          const first = makeId("chg", ulid());
          const second = makeId("chg", ulid());
          const evaluate = anchor("src/authz/evaluate.ts", "evaluate");
          const sessions = anchor("src/authz/sessions.ts");
          const cache = anchor("src/cache/store.ts", "SessionCache.read");
          expect(yield* projects.liveAnchors(projectId)).toEqual([]);

          yield* harness.hear(
            projectId,
            declaring(first, {
              premises: [fresh("authz.permission-evaluation", [evaluate])],
              // Named, and anchored nowhere: derivation could never attribute it.
              declaredEffects: [fresh("billing.invoice-total")],
            }),
          );
          yield* harness.hear(
            projectId,
            declaring(second, {
              premises: [fresh("authz.permission-evaluation", [sessions, evaluate])],
            }),
          );
          yield* harness.hear(
            projectId,
            eventOf(first, 5, {
              _tag: "EffectsDerived",
              changeId: first,
              revision: 1,
              effects: [
                {
                  proposition: fresh("sessions.cache", [cache]),
                  anchors: [cache],
                  declared: false,
                  method: "extractor",
                  evidenceClass: "ruling",
                },
              ],
              derivationRef: "derivation-1",
            }),
          );
          yield* harness.hear(
            other,
            declaring(makeId("chg", ulid()), {
              premises: [fresh("authz.tokens", [anchor("src/authz/tokens.ts")])],
            }),
          );
          expect(yield* projects.liveAnchors(projectId)).toEqual([
            { subject: "authz.permission-evaluation", anchors: [evaluate, sessions] },
            { subject: "sessions.cache", anchors: [cache] },
          ]);

          yield* harness.hear(
            projectId,
            eventOf(second, 2, { _tag: "ChangeWithdrawn", changeId: second, by: "agent" }),
          );
          expect(yield* projects.liveAnchors(projectId)).toEqual([
            { subject: "authz.permission-evaluation", anchors: [evaluate] },
            { subject: "sessions.cache", anchors: [cache] },
          ]);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
