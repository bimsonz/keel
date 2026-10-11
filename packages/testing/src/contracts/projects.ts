import { describe, expect, it } from "@effect/vitest";
import type { Principal } from "@keeltown/core/domain/identity";
import { AgentId, Glob, ProjectId } from "@keeltown/core/kernel";
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
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

const operator = (): Principal => ({
  agentId: Schema.decodeUnknownSync(AgentId)(`agt_${ulid()}`),
  projectId: Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`),
  scopes: ["operator"],
  revocationEpoch: 0,
});

const key = () => `key-${crypto.randomUUID()}`;

export function describeProjectsContract(adapter: string, make: () => ProjectsHarness) {
  describe(`Projects contract: ${adapter}`, () => {
    it.live("creates a project named as asked", () => {
      const harness = make();
      return Effect.gen(function* () {
        const project = yield* (yield* Projects).create(operator(), {
          name: "forge",
          source: harness.source,
          idempotencyKey: key(),
        });
        expect(project.name).toBe("forge");
        expect(Schema.is(ProjectId)(project.id)).toBe(true);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("replays a retry with the same key and body: the same project", () => {
      const harness = make();
      return Effect.gen(function* () {
        const projects = yield* Projects;
        const by = operator();
        const input = { name: "forge", source: harness.source, idempotencyKey: key() };
        const first = yield* projects.create(by, input);
        expect(yield* projects.create(by, input)).toEqual(first);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("refuses another body under a used key with IdempotencyConflict", () => {
      const harness = make();
      return Effect.gen(function* () {
        const projects = yield* Projects;
        const by = operator();
        const idempotencyKey = key();
        yield* projects.create(by, { name: "forge", source: harness.source, idempotencyKey });
        const reused = yield* Effect.flip(
          projects.create(by, { name: "other", source: harness.source, idempotencyKey }),
        );
        expect(reused._tag).toBe("IdempotencyConflict");
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("keeps two operators' projects apart even under the same key", () => {
      const harness = make();
      return Effect.gen(function* () {
        const projects = yield* Projects;
        const input = { name: "forge", source: harness.source, idempotencyKey: key() };
        const a = yield* projects.create(operator(), input);
        const b = yield* projects.create(operator(), input);
        expect(a.id).not.toBe(b.id);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("fails RepoNotFound, naming the repo, for a source that does not exist", () => {
      const harness = make();
      return Effect.gen(function* () {
        const missing = `missing-${ulid().toLowerCase()}`;
        const error = yield* Effect.flip(
          (yield* Projects).create(operator(), {
            name: "forge",
            source: missing,
            idempotencyKey: key(),
          }),
        );
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
        };
        const projectId = yield* harness.withSettings(settings);
        expect(yield* (yield* Projects).settings(projectId)).toEqual(settings);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("holds the defaults until a PUT: no protected paths, batches of one, verified", () => {
      const harness = make();
      return Effect.gen(function* () {
        const projects = yield* Projects;
        const project = yield* projects.create(operator(), {
          name: "forge",
          source: harness.source,
          idempotencyKey: key(),
        });
        expect(yield* projects.settings(project.id)).toEqual({
          protectedPaths: [],
          maxBatchSize: 1,
          verification: "required",
        });
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("replaces the settings a PUT names, an absent verification meaning required", () => {
      const harness = make();
      return Effect.gen(function* () {
        const projects = yield* Projects;
        const by = operator();
        const project = yield* projects.create(by, {
          name: "forge",
          source: harness.source,
          idempotencyKey: key(),
        });
        const off = { protectedPaths: [Glob.make("infra/**")], maxBatchSize: 1 } as const;
        const turnedOff = yield* projects.putSettings(
          by,
          project.id,
          { ...off, verification: "off" },
          "req-1",
        );
        const readOff = yield* projects.settings(project.id);
        const turnedOn = yield* projects.putSettings(by, project.id, off, "req-2");

        expect(turnedOff).toEqual({ ...off, verification: "off" });
        expect(readOff).toEqual(turnedOff);
        expect(turnedOn).toEqual({ ...off, verification: "required" });
        expect(yield* projects.settings(project.id)).toEqual(turnedOn);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("refuses other settings under a used request id with IdempotencyConflict", () => {
      const harness = make();
      return Effect.gen(function* () {
        const projects = yield* Projects;
        const by = operator();
        const project = yield* projects.create(by, {
          name: "forge",
          source: harness.source,
          idempotencyKey: key(),
        });
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
            operator(),
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
  });
}
