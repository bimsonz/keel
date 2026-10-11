import { type Agent, IdempotencyConflict, type Principal } from "@keeltown/core/domain/identity";
import { ProjectNotFound } from "@keeltown/core/domain/integration";
import { type AgentId, Instant, makeId, type ProjectId } from "@keeltown/core/kernel";
import {
  AgentDirectory,
  type Enrolment,
  Enrolments,
  type ProjectRecord,
  Projects,
  type ProjectSettings,
  RepoNotFound,
} from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { hashSecret } from "./identity.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID body for a counter: zero-padded Crockford base32, so ids stay valid and distinct. */
function ulidOf(n: number): string {
  let body = "";
  for (let rest = n; rest > 0; rest = Math.floor(rest / 32)) body = CROCKFORD[rest % 32] + body;
  return body.padStart(26, "0");
}

/** What an idempotent operator call remembers per key: what it made, and the body that made it. */
interface Keyed<T> {
  readonly made: T;
  readonly fingerprint: string;
}

const keyOf = (principal: Principal, idempotencyKey: string) =>
  `${principal.agentId}\u0000${idempotencyKey}`;

/**
 * Projects in a map. `create` keys each project by its operator and
 * Idempotency-Key, as the real adapter derives the project id from both, and
 * forks only from a source registered with `addSource`. `setSettings` gives a
 * project its settings; `settings` of any other project is ProjectNotFound.
 */
export function makeProjectsMemory(options: { readonly sources?: Iterable<string> } = {}) {
  const sources = new Set(options.sources ?? []);
  const byKey = new Map<string, Keyed<ProjectRecord>>();
  const settings = new Map<ProjectId, ProjectSettings>();
  let count = 0;
  return {
    sources,
    addSource: (name: string) => void sources.add(name),
    setSettings: (projectId: ProjectId, value: ProjectSettings) =>
      void settings.set(projectId, value),
    projects: () => [...byKey.values()].map((keyed) => keyed.made),
    layer: Layer.succeed(
      Projects,
      Projects.of({
        create: (principal, input) =>
          Effect.suspend((): Effect.Effect<ProjectRecord, IdempotencyConflict | RepoNotFound> => {
            const key = keyOf(principal, input.idempotencyKey);
            const fingerprint = JSON.stringify([input.name, input.source]);
            const known = byKey.get(key);
            if (known !== undefined) {
              return known.fingerprint === fingerprint
                ? Effect.succeed(known.made)
                : Effect.fail(new IdempotencyConflict({ idempotencyKey: input.idempotencyKey }));
            }
            if (!sources.has(input.source))
              return Effect.fail(
                new RepoNotFound({ repo: { namespace: "keel-core", name: input.source } }),
              );
            count += 1;
            const made: ProjectRecord = {
              id: makeId("prj", ulidOf(count)),
              name: input.name,
              createdAt: Instant(Date.now()),
            };
            byKey.set(key, { made, fingerprint });
            return Effect.succeed(made);
          }),
        settings: (projectId) =>
          Effect.suspend(() => {
            const found = settings.get(projectId);
            return found === undefined
              ? Effect.fail(new ProjectNotFound({ projectId }))
              : Effect.succeed(found);
          }),
      }),
    ),
  };
}

/**
 * Enrolments over an AgentDirectory: each one writes the agent and its
 * credential's hash into the directory before answering, as the AgentSession DO
 * writes the D1 projection. A replay re-issues the secret and retires the old one.
 */
export function makeEnrolmentsMemory() {
  const byKey = new Map<string, Keyed<{ readonly agent: Agent; readonly clientId: string }>>();
  let count = 0;
  return {
    layer: Layer.effect(
      Enrolments,
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        const issue = (agent: Agent, clientId: string) =>
          Effect.gen(function* () {
            const clientSecret = crypto.randomUUID() + crypto.randomUUID();
            const secretHash = yield* Effect.promise(() => hashSecret(clientSecret));
            yield* directory.upsert(agent, { clientId, agentId: agent.id, secretHash });
            return { agent, clientId, clientSecret };
          });
        return Enrolments.of({
          enrol: (principal, input) =>
            Effect.suspend((): Effect.Effect<Enrolment, IdempotencyConflict> => {
              const key = keyOf(principal, input.idempotencyKey);
              const projectId: ProjectId = input.projectId ?? principal.projectId;
              const fingerprint = JSON.stringify([
                input.name,
                input.kind,
                input.scopes,
                projectId,
                ...(input.onBehalfOf === undefined ? [] : [input.onBehalfOf]),
              ]);
              const known = byKey.get(key);
              if (known !== undefined) {
                return known.fingerprint === fingerprint
                  ? issue(known.made.agent, known.made.clientId)
                  : Effect.fail(new IdempotencyConflict({ idempotencyKey: input.idempotencyKey }));
              }
              count += 1;
              const agentId: AgentId = makeId("agt", ulidOf(count));
              const agent: Agent = {
                id: agentId,
                projectId,
                name: input.name,
                kind: input.kind,
                scopes: [...input.scopes],
                ...(input.onBehalfOf === undefined ? {} : { onBehalfOf: input.onBehalfOf }),
                state: "active",
                revocationEpoch: 0,
                createdAt: Instant(Date.now()),
              };
              const clientId = `client-${agentId.toLowerCase()}`;
              byKey.set(key, { made: { agent, clientId }, fingerprint });
              return issue(agent, clientId);
            }),
        });
      }),
    ),
  };
}
