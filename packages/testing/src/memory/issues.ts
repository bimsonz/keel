import { issuePage, issueThread, moveIssue, openIssue } from "@keeltown/core/application/issues";
import type { IssueNumber } from "@keeltown/core/domain/issues";
import type { ProjectId } from "@keeltown/core/kernel";
import {
  type Clock,
  EntityStore,
  type EventOutbox,
  type Ids,
  IssueNumbers,
  Issues,
} from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { makeEventOutboxMemory } from "./event-outbox.ts";
import { makeClockMemory, makeIdsMemory } from "./identity.ts";

/** What a request asked, as a fingerprint: a key replayed with another body is told apart from a retry. */
const fingerprint = (...asked: readonly unknown[]) => JSON.stringify(asked);

/** A project's `#n` sequence in memory: one counter a project, each issue given its number once. */
export function makeIssueNumbersMemory() {
  const counters = new Map<ProjectId, number>();
  const given = new Map<string, IssueNumber>();
  const service = IssueNumbers.of({
    give: (projectId, issueId) =>
      Effect.sync(() => {
        const key = `${projectId}/${issueId}`;
        const held = given.get(key);
        if (held !== undefined) return held;
        const number = (counters.get(projectId) ?? 0) + 1;
        counters.set(projectId, number);
        given.set(key, number);
        return number;
      }),
  });
  return { service, layer: Layer.succeed(IssueNumbers, service) };
}

/**
 * A project's issues in memory: each project its own store and outbox, and the
 * use-cases its object runs over them, so the memory decides as the object
 * does. `numbers` is the projects' `#n` sequence, which a test may also hand
 * out to changes.
 */
export function makeIssuesMemory(numbers = makeIssueNumbersMemory()) {
  const places = new Map<ProjectId, Layer.Layer<EntityStore | EventOutbox>>();
  const shared = Layer.mergeAll(numbers.layer, makeIdsMemory().layer, makeClockMemory().layer);
  const run = <A, E>(
    projectId: ProjectId,
    effect: Effect.Effect<A, E, EntityStore | EventOutbox | Clock | Ids | IssueNumbers>,
  ) => {
    let place = places.get(projectId);
    if (place === undefined) {
      place = makeEventOutboxMemory().layer;
      places.set(projectId, place);
    }
    return effect.pipe(Effect.provide(Layer.mergeAll(place, shared)));
  };
  const service = Issues.of({
    open: ({ projectId, title, body, author, idempotencyKey }) =>
      run(
        projectId,
        openIssue(projectId, {
          title,
          body,
          author,
          idempotencyKey,
          fingerprint: fingerprint(title, body, author),
        }),
      ),
    comment: ({ projectId, number, body, author, idempotencyKey }) =>
      run(
        projectId,
        moveIssue(projectId, {
          number,
          move: { _tag: "Comment", body },
          by: author,
          idempotencyKey,
          fingerprint: fingerprint(number, "comment", body, author),
        }),
      ).pipe(
        Effect.flatMap(({ comment }) =>
          comment === undefined
            ? Effect.die(`a comment on #${number} of ${projectId} answered no comment`)
            : Effect.succeed(comment),
        ),
      ),
    close: ({ projectId, number, reason, by, idempotencyKey }) =>
      run(
        projectId,
        moveIssue(projectId, {
          number,
          move: { _tag: "Close", reason },
          by,
          idempotencyKey,
          fingerprint: fingerprint(number, "close", reason, by),
        }),
      ).pipe(Effect.map(({ issue }) => issue)),
    reopen: ({ projectId, number, by, idempotencyKey }) =>
      run(
        projectId,
        moveIssue(projectId, {
          number,
          move: { _tag: "Reopen" },
          by,
          idempotencyKey,
          fingerprint: fingerprint(number, "reopen", by),
        }),
      ).pipe(Effect.map(({ issue }) => issue)),
    list: ({ projectId, ...query }) =>
      run(
        projectId,
        Effect.map(EntityStore, (store) => issuePage(store, query)),
      ),
    get: (projectId, number) =>
      run(
        projectId,
        Effect.flatMap(EntityStore, (store) =>
          Effect.fromResult(issueThread(store, projectId, number)),
        ),
      ),
  });
  return { service, layer: Layer.succeed(Issues, service), numbers };
}
