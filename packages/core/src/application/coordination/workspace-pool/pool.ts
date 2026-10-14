import { Effect, Exit, Result, Schema } from "effect";
import {
  PoolExhausted,
  WorkspaceCollected,
  WorkspaceForked,
  WorkspaceGranted,
  WorkspaceNotFound,
  WorkspacePushed,
} from "../../../domain/coordination/index.ts";
import {
  ChangeId,
  type CommitSha,
  Instant,
  type ProjectId,
  SketchId,
  type WorkspaceId,
} from "../../../domain/kernel/index.ts";
import {
  Clock,
  type CollectionReason,
  CodeHost,
  commit,
  EntityStore,
  type EventDraft,
  type Transaction,
  Ids,
  type ObservedPush,
  type PushObservation,
  Trunks,
  type WorkspaceGrant,
  WorkspaceRefresher,
} from "../../ports/index.ts";
import { workspaceRepoName } from "./repo-names.ts";
import {
  countIn,
  heldBy,
  holdFor,
  isDestroyed,
  isReady,
  oldestReady,
  oldestReadyAt,
  type PoolSettings,
  putSettings,
  putSlot,
  readyBehind,
  type RepoName,
  settingsOf,
  type Slot,
  slotOf,
  slots,
  unhold,
} from "./state.ts";

/** A grant's write token lives at most this long. */
export const GRANT_TTL_SECONDS = 2 * 60 * 60;
/** A slot still forking after this long belonged to a refill that died; it is collected. */
export const STUCK_FORK_MS = 120_000;
/** A slot still refreshing after this long belonged to a pass that died mid-relay; its main is read back. */
export const STUCK_REFRESH_MS = 120_000;
const MAIN = "refs/heads/main";
const GRANT_ATTEMPTS = 64;

const draft = <S extends Schema.Codec<unknown, EventDraft["payload"]>>(
  schema: S,
  event: S["Type"],
): EventDraft => ({
  payload: Schema.encodeSync(schema)(event),
});

/** A ready slot, or a granted one, carries what a grant hands out. */
const handout = (slot: Slot) =>
  slot.remote === undefined || slot.baseSha === undefined
    ? Effect.die(new Error(`workspace ${slot.id} is ${slot.state} without its remote and base`))
    : Effect.succeed({ remote: slot.remote, baseSha: slot.baseSha });

/**
 * Grants `holder` a ready workspace whose main is at trunk's head, or the one
 * it already holds: a retry re-mints the token for the same workspace, where
 * it stands (a held workspace's main is its agent's, and is never moved).
 *
 * Trunk's head is the Trunk DO's own (`Trunks.head`), read while the claim is
 * served: every landing recorded before the claim arrived is in the workspace
 * it is given. A ready workspace already at that head is taken as it stands,
 * the one that has waited longest first. With none there, the ready workspace
 * that has waited longest is brought to it first, as a refresh pass would
 * (`refreshOne`): the passes follow a landing a workspace at a time, and a
 * claim that arrives before them is not handed the base they have yet to
 * move. A workspace that could not be brought there is not tried again by
 * this grant, so each is relayed into once at most, and a claim that can
 * bring none answers PoolExhausted: it never answers a stale base. A pool
 * with no ready workspace does not ask trunk.
 *
 * The choice is re-checked inside the transaction, so concurrent grants never
 * share a workspace; the loser takes the next. A workspace being refreshed is
 * not ready: trunk is being written into it, by a pass or by another claim,
 * so it is never handed out mid-relay. The write token is minted after the
 * commit and never stored. Every pool commit is stamped with the pool's
 * `project`. A destroyed pool grants nothing, not even a holder's own
 * workspace again.
 *
 * A pass and a claim each read trunk's head. It only moves forward, so a
 * later read is never behind an earlier one; and should an answer ever be
 * delivered late enough to name a head a workspace is already past, the relay
 * refuses a move that is not forward and the workspace is left where it is.
 */
export const grantWorkspace = Effect.fn("coordination/grantWorkspace")(function* (
  project: ProjectId,
  holder: ChangeId | SketchId,
) {
  const store = yield* EntityStore;
  const host = yield* CodeHost;
  const trunks = yield* Trunks;
  /** The workspaces this grant could not bring to trunk's head. */
  const tried = new Set<WorkspaceId>();
  // Each pass grants, loses a ready slot to another grant, or tries one more: the loop ends. The bound catches a slot that can never be granted.
  for (let attempt = 0; attempt < GRANT_ATTEMPTS; attempt++) {
    if (isDestroyed(store)) return yield* new PoolExhausted({ retryAfterMs: 15_000 });
    const held = heldBy(store, holder);
    const slot = held === undefined ? undefined : slotOf(store, held);
    if (slot !== undefined) {
      const { remote, baseSha } = yield* handout(slot);
      const token = yield* host.mintToken(slot.repo, "write", GRANT_TTL_SECONDS).pipe(Effect.orDie);
      return {
        workspaceId: slot.id,
        remote,
        token: token.token,
        expiresAt: token.expiresAt,
        baseSha,
        repo: slot.repo,
      } satisfies WorkspaceGrant;
    }
    if (oldestReady(store, tried) === undefined) {
      // One being forked or refreshed is ready within seconds, and one a relay was refused for may take the next.
      const soonest =
        countIn(store, "forking") + countIn(store, "refreshing") + tried.size > 0 ? 5_000 : 15_000;
      const { readyAt } = settingsOf(store);
      const untilReady = readyAt === undefined ? 0 : readyAt - (yield* (yield* Clock).now);
      return yield* new PoolExhausted({ retryAfterMs: Math.max(soonest, untilReady) });
    }
    const head = yield* trunks.head(project);
    // Chosen after the read: what was ready before it may have been taken since.
    const candidate = oldestReadyAt(store, head) ?? oldestReady(store, tried);
    if (candidate === undefined) continue;
    if (candidate.baseSha !== head) {
      tried.add(candidate.id);
      if ((yield* refreshOne(project, candidate.id, head)) !== "advanced") continue;
    }
    const now = yield* (yield* Clock).now;
    yield* commit(
      { entity: { kind: "workspace", id: candidate.id }, cause: `grant:${holder}`, project },
      (tx) => {
        const chosen = slotOf(tx.store, candidate.id);
        if (
          !isReady(chosen) ||
          chosen.baseSha !== head ||
          heldBy(tx.store, holder) !== undefined ||
          isDestroyed(tx.store)
        ) {
          return Result.fail("taken" as const);
        }
        putSlot(tx.store, { ...chosen, state: "granted", since: now, holder });
        holdFor(tx.store, holder, chosen.id);
        const expiresAt = Instant(now + GRANT_TTL_SECONDS * 1000);
        return Result.succeed({
          value: chosen.id,
          drafts: [
            draft(WorkspaceGranted, {
              _tag: "WorkspaceGranted",
              workspaceId: chosen.id,
              holder,
              expiresAt,
              baseSha: head,
            }),
          ],
        });
      },
    ).pipe(Effect.catch(() => Effect.void));
  }
  return yield* Effect.die(
    new Error(`no grant settled for ${holder} in ${GRANT_ATTEMPTS} attempts`),
  );
});

/** What a refill did, so the Durable Object knows whether to try again. */
export interface RefillReport {
  readonly started: number;
  readonly ready: number;
  readonly failed: number;
  readonly abandoned: number;
}

/** Forks `source` into a fresh repo and reads what a grant hands out. */
const forkOne = (source: RepoName, repo: RepoName) =>
  Effect.gen(function* () {
    const host = yield* CodeHost;
    yield* host.fork(source, repo);
    const info = yield* host.info(repo);
    const baseSha: CommitSha = yield* host.head(repo, MAIN);
    return { remote: info.remote, baseSha };
  });

/** How many of the trunk commits relayed onto a workspace's main its slot remembers. */
export const RELAYS_KEPT = 8;

/**
 * Whether a push that left a workspace's main at `sha` was Keel's own write:
 * main is on the workspace's base (its fork's head, or where a refresh took
 * it), or on a trunk commit a refresh relayed on the way there. A push is
 * observed some time after it lands, so a refresh's push can be reported
 * once its workspace is already granted; nothing an agent made is on main
 * until it has moved past these.
 */
const keelsOwn = (slot: Slot, sha: CommitSha): boolean =>
  slot.baseSha === sha || (slot.relayed ?? []).includes(sha);

/**
 * Records an agent's push to the workspace it holds as WorkspacePushed, once
 * per push: `pushId` (the observing Workflow's instance) is the cause, so a
 * retried observation commits nothing new and answers the same. A push to a
 * workspace that is not granted (ready, forking, collecting) or that this
 * pool never forked was Keel's own write or nobody's, and so was one that
 * left a granted workspace's main where Keel itself put it (a refresh's
 * relay, reported late): each is ignored, since no agent is woken by Keel's
 * writes (ADR 0009, no self-loops).
 */
export const observePush = Effect.fn("coordination/observePush")(function* (
  project: ProjectId,
  pushId: string,
  push: ObservedPush,
) {
  const done = yield* commit(
    { entity: { kind: "workspace", id: push.workspaceId }, cause: `push:${pushId}`, project },
    (tx) => {
      const slot = slotOf(tx.store, push.workspaceId);
      return Result.succeed(
        slot?.state === "granted" && !keelsOwn(slot, push.sha)
          ? {
              value: "recorded" as const,
              drafts: [draft(WorkspacePushed, { _tag: "WorkspacePushed", ...push })],
            }
          : { value: "ignored" as const, drafts: [] },
      );
    },
  );
  return (
    done.duplicate ? (done.events.length > 0 ? "recorded" : "ignored") : done.value
  ) satisfies PushObservation;
});

/**
 * Tops the pool up to its target. Each new slot is committed as `forking`
 * before its fork starts; the forks run in parallel outside any transaction
 * (a fork is ready when the call resolves, spike S2); each that resolves
 * commits `ready` with `WorkspaceForked`, and each that fails is collected.
 * Names come from fresh workspace ids, so a name is never reused. A slot left
 * forking by a refill that died is collected. A slot given up while its fork
 * ran (the pool was destroyed) is collected again once the fork resolves, as
 * its repo exists from then. A slot being refreshed counts towards the
 * target, as it is ready again within seconds. A destroyed pool forks nothing.
 */
export const refillPool = Effect.fn("coordination/refillPool")(function* (project: ProjectId) {
  const store = yield* EntityStore;
  const ids = yield* Ids;
  const now = yield* (yield* Clock).now;
  const settings = settingsOf(store);
  const stuck = slots(store).filter((s) => s.state === "forking" && now - s.since > STUCK_FORK_MS);
  for (const slot of stuck) yield* markCollecting(project, slot.id, "fork-abandoned");
  const source = settings.source;
  const need =
    settings.target -
    countIn(store, "ready") -
    countIn(store, "forking") -
    countIn(store, "refreshing");
  if (source === null || need <= 0 || isDestroyed(store))
    return { started: 0, ready: 0, failed: 0, abandoned: stuck.length } satisfies RefillReport;

  const fresh: Slot[] = [];
  for (let i = 0; i < need; i++) {
    const id: WorkspaceId = yield* ids.next("wsp");
    const slot: Slot = {
      id,
      repo: { namespace: source.namespace, name: workspaceRepoName(project, id) },
      state: "forking",
      since: now,
    };
    yield* commit(
      { entity: { kind: "workspace", id }, cause: `fork-start:${id}`, project },
      (tx) => {
        putSlot(tx.store, slot);
        return Result.succeed({ value: undefined, drafts: [] });
      },
    );
    fresh.push(slot);
  }

  const outcomes = yield* Effect.forEach(fresh, (slot) => Effect.exit(forkOne(source, slot.repo)), {
    concurrency: "unbounded",
  });
  let ready = 0;
  for (const [i, outcome] of outcomes.entries()) {
    const slot = fresh[i];
    if (slot === undefined) continue;
    if (Exit.isFailure(outcome)) {
      yield* markCollecting(project, slot.id, "fork-failed");
      continue;
    }
    const at = yield* (yield* Clock).now;
    const forked = yield* commit(
      { entity: { kind: "workspace", id: slot.id }, cause: `forked:${slot.id}`, project },
      (tx) => {
        const current = slotOf(tx.store, slot.id);
        if (current?.state !== "forking") {
          // Given up while its fork ran, and perhaps deleted before the repo existed: it exists now.
          if (current !== undefined)
            putSlot(tx.store, { ...current, state: "collecting", since: at });
          return Result.succeed({ value: false, drafts: [] });
        }
        putSlot(tx.store, {
          ...current,
          state: "ready",
          since: at,
          remote: outcome.value.remote,
          baseSha: outcome.value.baseSha,
        });
        return Result.succeed({
          value: true,
          drafts: [
            draft(WorkspaceForked, {
              _tag: "WorkspaceForked",
              workspaceId: slot.id,
              repo: slot.repo.name,
              sourceRepo: source.name,
            }),
          ],
        });
      },
    );
    if (forked.duplicate || forked.value) ready += 1;
  }
  return {
    started: fresh.length,
    ready,
    failed: fresh.length - ready,
    abandoned: stuck.length,
  } satisfies RefillReport;
});

/** Moves a slot that never became a workspace (its fork failed or was abandoned) to collection; no event, as no workspace existed. */
const markCollecting = (project: ProjectId, id: WorkspaceId, why: string) =>
  Effect.gen(function* () {
    const now = yield* (yield* Clock).now;
    yield* commit({ entity: { kind: "workspace", id }, cause: `${why}:${id}`, project }, (tx) => {
      const slot = slotOf(tx.store, id);
      if (slot?.state === "forking")
        putSlot(tx.store, { ...slot, state: "collecting", since: now });
      return Result.succeed({ value: undefined, drafts: [] });
    });
  });

/**
 * Inside a transaction: moves a workspace to collection and drafts its
 * `WorkspaceCollected`. A workspace already being collected drafts nothing,
 * so a repeated release or a redelivered event is a no-op.
 */
const collectIn = (
  tx: Transaction,
  workspaceId: WorkspaceId,
  reason: CollectionReason,
  now: number,
): readonly EventDraft[] => {
  const slot = slotOf(tx.store, workspaceId);
  if (slot === undefined || slot.state === "collecting" || slot.state === "collected") return [];
  if (slot.holder !== undefined) unhold(tx.store, slot.holder);
  putSlot(tx.store, { ...slot, state: "collecting", since: now });
  return [draft(WorkspaceCollected, { _tag: "WorkspaceCollected", workspaceId, reason })];
};

/** Releases a workspace: it is collected (its repo deleted) for `reason`. Releasing it again is a no-op. */
export const releaseWorkspace = Effect.fn("coordination/releaseWorkspace")(function* (
  project: ProjectId,
  workspaceId: WorkspaceId,
  reason: CollectionReason,
) {
  const now = yield* (yield* Clock).now;
  yield* commit(
    { entity: { kind: "workspace", id: workspaceId }, cause: `release:${workspaceId}`, project },
    (tx) =>
      slotOf(tx.store, workspaceId) === undefined
        ? Result.fail(new WorkspaceNotFound({ workspaceId }))
        : Result.succeed({ value: undefined, drafts: collectIn(tx, workspaceId, reason, now) }),
  );
});

const decodeHolder = Schema.decodeUnknownSync(Schema.Union([ChangeId, SketchId]));

/**
 * The change or sketch that holds the workspace, while it is granted. A
 * ready, refreshing or collected workspace, or one this pool never forked,
 * has no holder.
 */
export const holderOf = Effect.fn("coordination/holderOf")(function* (workspaceId: WorkspaceId) {
  const slot = slotOf(yield* EntityStore, workspaceId);
  return slot?.state === "granted" && slot.holder !== undefined
    ? decodeHolder(slot.holder)
    : undefined;
});

/**
 * What a refresh pass did. `refreshed` workspaces now stand on trunk's head;
 * `failed` ones could not follow it and were given up for collection (the
 * refill forks their replacements); `pending` ones are still behind trunk or
 * not yet settled, so the pass must run again.
 */
export interface RefreshReport {
  readonly refreshed: number;
  readonly failed: number;
  readonly pending: number;
}

/** What became of one slot in a refresh pass. `left`: it was not this pass's to touch. `unsettled`: its main could not be read. */
type Refreshed = "advanced" | "kept" | "collected" | "left" | "unsettled";

const decided = (value: Refreshed, drafts: readonly EventDraft[] = []) =>
  Result.succeed({ value, drafts });

/** A slot whose main is known again: ready at `base`, with nothing of its refresh left on it but the commits it relayed. */
const settledAt = (slot: Slot, base: CommitSha, at: number): Slot => ({
  id: slot.id,
  repo: slot.repo,
  state: "ready",
  since: at,
  ...(slot.remote === undefined ? {} : { remote: slot.remote }),
  baseSha: base,
  ...(slot.relayed === undefined ? {} : { relayed: slot.relayed }),
});

/**
 * Settles a refreshing slot whose relay left no answer to trust (it was
 * refused, it failed part-way, or its pass died): reads the workspace's main
 * back. At the commit the relay was taking it to, or still where it was, the
 * slot is ready there. Anywhere else, or gone, it is not a workspace the pool
 * can vouch for, and it is collected. A read that fails leaves the slot
 * refreshing, for a later pass.
 */
const settleRefresh = (project: ProjectId, id: WorkspaceId) =>
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const host = yield* CodeHost;
    const slot = slotOf(store, id);
    if (slot?.state !== "refreshing") return "left" satisfies Refreshed;
    const read = yield* host.head(slot.repo, MAIN).pipe(
      Effect.map((sha): CommitSha | "gone" => sha),
      Effect.catchTags({
        RepoNotFound: () => Effect.succeed("gone" as const),
        RefNotFound: () => Effect.succeed("gone" as const),
      }),
      Effect.exit,
    );
    if (Exit.isFailure(read)) return "unsettled" satisfies Refreshed;
    const main = read.value;
    const done = yield* commit(
      { entity: { kind: "workspace", id }, cause: `refresh-settled:${id}`, project },
      (tx) => {
        const current = slotOf(tx.store, id);
        if (current?.state !== "refreshing") return decided("left");
        if (main !== "gone" && (main === current.advancingTo || main === current.baseSha)) {
          putSlot(tx.store, settledAt(current, main, tx.at));
          return decided(main === current.advancingTo ? "advanced" : "kept");
        }
        return decided("collected", collectIn(tx, id, "expired", tx.at));
      },
    );
    return done.duplicate ? ("left" satisfies Refreshed) : done.value;
  });

/**
 * Refreshes one slot, for a pass or for a claim. It is claimed first (`ready`
 * to `refreshing`, checked again inside the transaction, so one granted or
 * claimed by another relay meanwhile is left alone), then trunk is relayed
 * into its main, and only once the relay has answered is the new base
 * recorded: `baseSha` never names a commit the workspace's main was not seen
 * at. No event is committed, as a workspace nobody holds has nobody to tell,
 * and `WorkspaceGranted.baseSha` announces the base when it is handed out.
 */
const refreshOne = (project: ProjectId, id: WorkspaceId, head: CommitSha) =>
  Effect.gen(function* () {
    const refresher = yield* WorkspaceRefresher;
    const claimed = yield* commit(
      { entity: { kind: "workspace", id }, cause: `refresh-start:${id}`, project },
      (tx) => {
        const current = slotOf(tx.store, id);
        const from = current?.baseSha;
        if (!isReady(current) || from === undefined || from === head)
          return Result.succeed({ value: undefined, drafts: [] });
        // Remembered before the relay, so a push that landed with its answer lost is known as Keel's too.
        const relayed = [...(current.relayed ?? []), head].slice(-RELAYS_KEPT);
        putSlot(tx.store, {
          ...current,
          state: "refreshing",
          since: tx.at,
          advancingTo: head,
          relayed,
        });
        return Result.succeed({ value: { repo: current.repo, from }, drafts: [] });
      },
    );
    if (claimed.duplicate || claimed.value === undefined) return "left" satisfies Refreshed;
    const { repo, from } = claimed.value;
    const relayed = yield* refresher.advance(project, repo, from, head).pipe(
      Effect.as("landed" as const),
      // What lies past its base can never be relayed: a fresh fork replaces it.
      Effect.catchTag("PackTooLarge", () => Effect.succeed("too-large" as const)),
      Effect.exit,
    );
    // A refusal, a missing repo or a failure part-way says nothing of where main is: read it back.
    if (Exit.isFailure(relayed)) return yield* settleRefresh(project, id);
    const outcome = relayed.value;
    const done = yield* commit(
      { entity: { kind: "workspace", id }, cause: `refresh-end:${id}`, project },
      (tx) => {
        const current = slotOf(tx.store, id);
        // Given up while its relay ran (the pool was destroyed): it stays given up.
        if (current?.state !== "refreshing") return decided("left");
        if (outcome === "too-large")
          return decided("collected", collectIn(tx, id, "expired", tx.at));
        putSlot(tx.store, settledAt(current, head, tx.at));
        return decided("advanced");
      },
    );
    return done.duplicate ? ("left" satisfies Refreshed) : done.value;
  });

/**
 * Brings the pool's ready workspaces up to trunk's head, so the next change
 * starts from it and not from wherever trunk stood when its workspace was
 * forked. Trunk's head is the Trunk DO's own (`Trunks.head`). The ready
 * workspaces behind it are refreshed one at a time, the one that has waited
 * longest first: while one is mid-relay the others stay ready, and a claim
 * that comes for one before its turn brings it to trunk's head itself
 * (`grantWorkspace`). A granted workspace is never touched.
 *
 * A slot a dead pass left refreshing is settled first, once it has been so
 * for `STUCK_REFRESH_MS`, by reading its main back. A pool with no ready
 * workspace and nothing to settle does not ask trunk at all; a destroyed pool
 * is one, as it has given every workspace up.
 */
export const refreshSlots = Effect.fn("coordination/refreshSlots")(function* (project: ProjectId) {
  const store = yield* EntityStore;
  const now = yield* (yield* Clock).now;
  const stuck = slots(store).filter(
    (s) => s.state === "refreshing" && now - s.since > STUCK_REFRESH_MS,
  );
  if (stuck.length === 0 && countIn(store, "ready") === 0)
    return {
      refreshed: 0,
      failed: 0,
      pending: countIn(store, "refreshing"),
    } satisfies RefreshReport;
  const head = yield* (yield* Trunks).head(project);
  let refreshed = 0;
  let failed = 0;
  for (const slot of stuck) {
    const how = yield* settleRefresh(project, slot.id);
    if (how === "collected") failed += 1;
    // Its relay had landed; it counts once it stands on today's head, or it is refreshed again below.
    if (how === "advanced" && slotOf(store, slot.id)?.baseSha === head) refreshed += 1;
  }
  const outcomes = yield* Effect.forEach(
    readyBehind(store, head),
    (slot) => refreshOne(project, slot.id, head),
    { concurrency: 1 },
  );
  for (const how of outcomes) {
    if (how === "advanced") refreshed += 1;
    if (how === "collected") failed += 1;
  }
  return {
    refreshed,
    failed,
    pending: readyBehind(store, head).length + countIn(store, "refreshing"),
  } satisfies RefreshReport;
});

/**
 * How many ready workspaces are behind trunk's head. A refill forks from the
 * project's mirror, which can lag trunk, so what it leaves ready may already
 * want a refresh. A pool with no ready workspace does not ask trunk.
 */
export const countBehind = Effect.fn("coordination/countBehind")(function* (project: ProjectId) {
  const store = yield* EntityStore;
  if (countIn(store, "ready") === 0) return 0;
  const head = yield* (yield* Trunks).head(project);
  return readyBehind(store, head).length;
});

/**
 * Destroys the project's pool, for good: it forks and grants nothing from
 * here on, and every workspace it holds (ready, granted or still forking) is
 * given up for collection, which deletes its repo. A ready or granted one
 * commits `WorkspaceCollected` as a release does. Destroying again is a no-op.
 */
export const destroyPool = Effect.fn("coordination/destroyPool")(function* (project: ProjectId) {
  const store = yield* EntityStore;
  yield* commit(
    { entity: { kind: "project", id: project }, cause: "destroy-pool", project },
    (tx) => {
      putSettings(tx.store, { ...settingsOf(tx.store), target: 0, destroyed: true });
      return Result.succeed({ value: undefined, drafts: [] });
    },
  );
  for (const slot of slots(store)) {
    if (slot.state === "collecting" || slot.state === "collected") continue;
    const now = yield* (yield* Clock).now;
    yield* commit(
      { entity: { kind: "workspace", id: slot.id }, cause: `destroy:${slot.id}`, project },
      (tx) => {
        const current = slotOf(tx.store, slot.id);
        if (current?.state !== "forking")
          return Result.succeed({
            value: undefined,
            drafts: collectIn(tx, slot.id, "withdrawn", now),
          });
        putSlot(tx.store, { ...current, state: "collecting", since: now });
        return Result.succeed({ value: undefined, drafts: [] });
      },
    );
  }
});

/** How a change's end collects its workspace: superseded counts as withdrawn. */
export const COLLECTED_ON: Readonly<Record<string, CollectionReason>> = {
  ChangeLanded: "landed",
  ChangeWithdrawn: "withdrawn",
  ChangeSuperseded: "withdrawn",
};

/**
 * A delivered event, inside the transaction that records it: when it ends a
 * change, collect the workspace that change holds. Undefined when the event
 * is not one of those, or the change holds no workspace (it never did, or a
 * redelivery finds it already collected).
 */
export function collectOnChangeEnd(
  tx: Transaction,
  event: { readonly type: string; readonly payload: unknown },
  now: number,
): { readonly workspaceId: WorkspaceId; readonly drafts: readonly EventDraft[] } | undefined {
  const reason = COLLECTED_ON[event.type];
  const changeId =
    typeof event.payload === "object" && event.payload !== null && "changeId" in event.payload
      ? event.payload.changeId
      : undefined;
  if (reason === undefined || typeof changeId !== "string") return undefined;
  const workspaceId = heldBy(tx.store, changeId);
  if (workspaceId === undefined) return undefined;
  const drafts = collectIn(tx, workspaceId, reason, now);
  return drafts.length === 0 ? undefined : { workspaceId, drafts };
}

/** What a collection pass did; `pending` repos still await deletion. */
export interface CollectReport {
  readonly deleted: number;
  readonly pending: number;
}

/** Deletes the repo of every slot being collected. A failed deletion stays pending for the next pass. */
export const collectWorkspaces = Effect.fn("coordination/collectWorkspaces")(function* (
  project: ProjectId,
) {
  const store = yield* EntityStore;
  const host = yield* CodeHost;
  const due = slots(store).filter((s) => s.state === "collecting");
  const outcomes = yield* Effect.forEach(due, (slot) => Effect.exit(host.delete(slot.repo)), {
    concurrency: "unbounded",
  });
  let deleted = 0;
  for (const [i, outcome] of outcomes.entries()) {
    const slot = due[i];
    if (slot === undefined) continue;
    const now = yield* (yield* Clock).now;
    const done = Exit.isSuccess(outcome);
    yield* commit(
      {
        entity: { kind: "workspace", id: slot.id },
        cause: `collect:${slot.id}:${slot.attempts ?? 0}`,
        project,
      },
      (tx) => {
        const current = slotOf(tx.store, slot.id);
        if (current?.state === "collecting") {
          putSlot(
            tx.store,
            done
              ? { ...current, state: "collected", since: now }
              : { ...current, attempts: (current.attempts ?? 0) + 1 },
          );
        }
        return Result.succeed({ value: undefined, drafts: [] });
      },
    );
    if (done) deleted += 1;
  }
  return { deleted, pending: due.length - deleted } satisfies CollectReport;
});

/** Workspaces by state, and what the pool forks from. */
export interface PoolStatus {
  readonly source: RepoName | null;
  readonly target: number;
  readonly ready: number;
  readonly forking: number;
  /** Ready ones trunk has moved past, while trunk is relayed into them; not grantable until it is. */
  readonly refreshing: number;
  readonly granted: number;
  readonly collecting: number;
  /** The project was destroyed: once `collecting` is 0, none of its workspace repos is left. */
  readonly destroyed: boolean;
}

export const poolStatus = Effect.fn("coordination/poolStatus")(function* () {
  const store = yield* EntityStore;
  const settings = settingsOf(store);
  return {
    source: settings.source,
    target: settings.target,
    ready: countIn(store, "ready"),
    forking: countIn(store, "forking"),
    refreshing: countIn(store, "refreshing"),
    granted: countIn(store, "granted"),
    collecting: countIn(store, "collecting"),
    destroyed: isDestroyed(store),
  } satisfies PoolStatus;
});

/** Sets what the pool forks from and how many ready workspaces it keeps; a destroyed pool stays destroyed. `project` is the pool's project, the entity the change is recorded on. */
export const configurePool = Effect.fn("coordination/configurePool")(function* (
  project: ProjectId,
  settings: PoolSettings,
) {
  const now = yield* (yield* Clock).now;
  yield* commit(
    { entity: { kind: "project", id: project }, cause: `configure-pool@${now}`, project },
    (tx) => {
      putSettings(tx.store, { ...settings, destroyed: isDestroyed(tx.store) });
      return Result.succeed({ value: undefined, drafts: [] });
    },
  );
  return yield* poolStatus();
});
