import { Effect, Result, Schema } from "effect";
import {
  decidePromotion,
  PromotionStateRefused,
  evolvePromotion,
  type PromotionCommand,
  Trunk,
  TrunkEvent,
} from "../../domain/integration/index.ts";
import type { CommitSha, ProjectId } from "../../domain/kernel/index.ts";
import { Clock, commit, EntityStore, type EventDraft, TrunkWriter } from "../ports/index.ts";
import { projectRepos } from "./project-repos.ts";

/** The EntityStore kind holding a trunk's folded state, keyed by its project. */
const TRUNK = "trunk";

// JSON codecs: the domain's optional fields encode as absent keys, which is what EntityStore and the outbox hold.
const decodeTrunk = Schema.decodeUnknownSync(Schema.toCodecJson(Trunk));
const encodeTrunk = Schema.encodeSync(Schema.toCodecJson(Trunk));
const encodeEvent = Schema.encodeSync(Schema.toCodecJson(TrunkEvent));

const isTagged = (json: Schema.Json): json is EventDraft["payload"] =>
  typeof json === "object" &&
  json !== null &&
  !Array.isArray(json) &&
  "_tag" in json &&
  typeof json["_tag"] === "string";

/** A trunk event as the outbox takes it. */
const draftOf = (event: TrunkEvent): EventDraft => {
  const payload = encodeEvent(event);
  if (!isTagged(payload)) throw new Error(`${event._tag} did not encode as a tagged object`);
  return { payload };
};

/** The trunk as its events left it, or undefined before TrunkInitialized. */
export const trunkOf = (
  store: (typeof EntityStore)["Service"],
  projectId: ProjectId,
): Trunk | undefined => {
  const stored = store.get(TRUNK, projectId);
  return stored === undefined ? undefined : decodeTrunk(stored);
};

/**
 * Runs one Promotion command in one transaction: decide on the folded trunk,
 * commit the events, and fold them into the stored trunk. A refusal writes
 * nothing. `cause` makes a retry a no-op, answering the trunk as it stands;
 * `fingerprint` tells a retry from a different command under the same cause.
 */
export const promote = Effect.fn("integration/promote")(function* (
  projectId: ProjectId,
  command: PromotionCommand,
  cause: string,
  fingerprint?: string,
) {
  const now = yield* (yield* Clock).now;
  return yield* commit(
    {
      entity: { kind: "trunk", id: projectId },
      cause,
      project: projectId,
      ...(fingerprint === undefined ? {} : { fingerprint }),
    },
    (tx) =>
      Result.map(
        decidePromotion(trunkOf(tx.store, projectId), command, { now, projectId }),
        (events) => {
          const after = events.reduce<Trunk | undefined>(
            (trunk, payload) => evolvePromotion(trunk, { at: now, payload }),
            trunkOf(tx.store, projectId),
          );
          if (after !== undefined) tx.store.put(TRUNK, projectId, encodeTrunk(after));
          return { value: after, drafts: events.map(draftOf) };
        },
      ),
  );
});

/**
 * Names trunk's first head; before it nothing is queued or promoted. A retry
 * with the same head answers the trunk; another head is refused, as is any
 * initialize once trunk has a head.
 */
export const initializeTrunk = Effect.fn("integration/initializeTrunk")(function* (
  projectId: ProjectId,
  head: CommitSha,
  by: string,
) {
  const committed = yield* promote(projectId, { _tag: "Initialize", head, by }, "initialize", head);
  const trunk = trunkOf(yield* EntityStore, projectId);
  if (trunk === undefined)
    return yield* Effect.die(
      new Error(`trunk ${projectId} committed Initialize but holds no state`),
    );
  if (committed.duplicate && !committed.sameCommand)
    return yield* new PromotionStateRefused({
      projectId,
      phase: trunk.phase,
      command: "Initialize",
    });
  return trunk;
});

/**
 * Copies trunk's head into the project's staging and mirror, off the
 * promotion path: a lagging mirror is safe (a change's base is its
 * workspace's head), and trunk never waits on or fails by it. Idempotent.
 */
export const syncTrunk = Effect.fn("integration/syncTrunk")(function* (projectId: ProjectId) {
  const repos = projectRepos(projectId);
  const { head, outcomes } = yield* (yield* TrunkWriter).sync([repos.staging, repos.mirror]);
  const [staging, mirror] = outcomes;
  if (staging === undefined || mirror === undefined)
    return yield* Effect.die(new Error(`trunk ${projectId} synced ${outcomes.length} of 2 repos`));
  return { head, staging, mirror };
});
