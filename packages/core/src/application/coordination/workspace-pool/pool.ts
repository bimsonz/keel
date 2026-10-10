import { Effect, Exit, Result, Schema } from "effect";
import {
  PoolExhausted,
  WorkspaceCollected,
  WorkspaceForked,
  WorkspaceGranted,
  WorkspaceNotFound,
} from "../../../domain/coordination/index.ts";
import {
  type ChangeId,
  type CommitSha,
  Instant,
  type SketchId,
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
  type WorkspaceGrant,
} from "../../ports/index.ts";
import {
  countIn,
  heldBy,
  holdFor,
  oldestReady,
  type PoolSettings,
  putSettings,
  putSlot,
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
 * Grants a ready workspace to `holder`, or the one it already holds: a retry
 * re-mints the token for the same workspace. The choice is re-checked inside
 * the transaction, so concurrent grants never share a workspace; the loser
 * takes the next ready one. The write token is minted after the commit and
 * never stored.
 */
export const grantWorkspace = Effect.fn("coordination/grantWorkspace")(function* (
  holder: ChangeId | SketchId,
) {
  const store = yield* EntityStore;
  const host = yield* CodeHost;
  // Each lost race leaves one ready slot fewer, so the loop ends; the bound catches a slot that can never be granted.
  for (let attempt = 0; attempt < GRANT_ATTEMPTS; attempt++) {
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
    const candidate = oldestReady(store);
    if (candidate === undefined) {
      return yield* new PoolExhausted({
        retryAfterMs: countIn(store, "forking") > 0 ? 5_000 : 15_000,
      });
    }
    const now = yield* (yield* Clock).now;
    yield* commit(
      { entity: { kind: "workspace", id: candidate.id }, cause: `grant:${holder}` },
      (tx) => {
        const chosen = slotOf(tx.store, candidate.id);
        if (
          chosen?.state !== "ready" ||
          chosen.baseSha === undefined ||
          heldBy(tx.store, holder) !== undefined
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
              baseSha: chosen.baseSha,
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

/**
 * Tops the pool up to its target. Each new slot is committed as `forking`
 * before its fork starts; the forks run in parallel outside any transaction
 * (a fork is ready when the call resolves, spike S2); each that resolves
 * commits `ready` with `WorkspaceForked`, and each that fails is collected.
 * Names come from fresh workspace ids, so a name is never reused. A slot left
 * forking by a refill that died is collected.
 */
export const refillPool = Effect.fn("coordination/refillPool")(function* () {
  const store = yield* EntityStore;
  const ids = yield* Ids;
  const now = yield* (yield* Clock).now;
  const settings = settingsOf(store);
  const stuck = slots(store).filter((s) => s.state === "forking" && now - s.since > STUCK_FORK_MS);
  for (const slot of stuck) yield* markCollecting(slot.id, "fork-abandoned");
  const source = settings.source;
  const need = settings.target - countIn(store, "ready") - countIn(store, "forking");
  if (source === null || need <= 0)
    return { started: 0, ready: 0, failed: 0, abandoned: stuck.length } satisfies RefillReport;

  const fresh: Slot[] = [];
  for (let i = 0; i < need; i++) {
    const id: WorkspaceId = yield* ids.next("wsp");
    const slot: Slot = {
      id,
      repo: { namespace: source.namespace, name: `ws-${id.slice(4).toLowerCase()}` },
      state: "forking",
      since: now,
    };
    yield* commit({ entity: { kind: "workspace", id }, cause: `fork-start:${id}` }, (tx) => {
      putSlot(tx.store, slot);
      return Result.succeed({ value: undefined, drafts: [] });
    });
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
      yield* markCollecting(slot.id, "fork-failed");
      continue;
    }
    const at = yield* (yield* Clock).now;
    yield* commit(
      { entity: { kind: "workspace", id: slot.id }, cause: `forked:${slot.id}` },
      (tx) => {
        const current = slotOf(tx.store, slot.id);
        if (current?.state !== "forking") return Result.succeed({ value: undefined, drafts: [] });
        putSlot(tx.store, {
          ...current,
          state: "ready",
          since: at,
          remote: outcome.value.remote,
          baseSha: outcome.value.baseSha,
        });
        return Result.succeed({
          value: undefined,
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
    ready += 1;
  }
  return {
    started: fresh.length,
    ready,
    failed: fresh.length - ready,
    abandoned: stuck.length,
  } satisfies RefillReport;
});

/** Moves a slot that never became a workspace (its fork failed or was abandoned) to collection; no event, as no workspace existed. */
const markCollecting = (id: WorkspaceId, why: string) =>
  Effect.gen(function* () {
    const now = yield* (yield* Clock).now;
    yield* commit({ entity: { kind: "workspace", id }, cause: `${why}:${id}` }, (tx) => {
      const slot = slotOf(tx.store, id);
      if (slot?.state === "forking")
        putSlot(tx.store, { ...slot, state: "collecting", since: now });
      return Result.succeed({ value: undefined, drafts: [] });
    });
  });

/** Releases a workspace: it is collected (its repo deleted) for `reason`. Releasing it again is a no-op. */
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
  workspaceId: WorkspaceId,
  reason: CollectionReason,
) {
  const now = yield* (yield* Clock).now;
  yield* commit(
    { entity: { kind: "workspace", id: workspaceId }, cause: `release:${workspaceId}` },
    (tx) =>
      slotOf(tx.store, workspaceId) === undefined
        ? Result.fail(new WorkspaceNotFound({ workspaceId }))
        : Result.succeed({ value: undefined, drafts: collectIn(tx, workspaceId, reason, now) }),
  );
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
export const collectWorkspaces = Effect.fn("coordination/collectWorkspaces")(function* () {
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
  readonly granted: number;
  readonly collecting: number;
}

export const poolStatus = Effect.fn("coordination/poolStatus")(function* () {
  const store = yield* EntityStore;
  const settings = settingsOf(store);
  return {
    source: settings.source,
    target: settings.target,
    ready: countIn(store, "ready"),
    forking: countIn(store, "forking"),
    granted: countIn(store, "granted"),
    collecting: countIn(store, "collecting"),
  } satisfies PoolStatus;
});

/** Sets what the pool forks from and how many ready workspaces it keeps. `project` is the pool's project, the entity the change is recorded on. */
export const configurePool = Effect.fn("coordination/configurePool")(function* (
  project: string,
  settings: PoolSettings,
) {
  const now = yield* (yield* Clock).now;
  yield* commit(
    { entity: { kind: "project", id: project }, cause: `configure-pool@${now}` },
    (tx) => {
      putSettings(tx.store, settings);
      return Result.succeed({ value: undefined, drafts: [] });
    },
  );
  return yield* poolStatus();
});
