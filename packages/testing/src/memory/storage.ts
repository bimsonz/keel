import { readStoredPlan, storedPlanText } from "@keeltown/core/application/verification";
import { BundleMissing } from "@keeltown/core/domain/verification";
import { SecretMissing } from "@keeltown/core/domain/delivery";
import type { ContentHash, EventEnvelope, SessionId } from "@keeltown/core/kernel";
import {
  canonicalJson,
  ContentHash as ContentHashSchema,
  contentHashOf,
  type Json,
} from "@keeltown/core/kernel";
import {
  Background,
  BundleStore,
  EntityStore,
  EventLog,
  EvidenceMissing,
  EvidenceStore,
  type Job,
  Metrics,
  type MfpRecord,
  MfpWriter,
  PlanCorrupt,
  PlanMissing,
  PlanStore,
  SecretsProvider,
  type SessionMessage,
  SessionStore,
  type Stored,
  WorkQueue,
} from "@keeltown/core/ports";
import { SessionNotFound } from "@keeltown/core/domain/memory";
import { Effect, Layer, Result, Schema } from "effect";

/**
 * A Durable Object's storage, in a Map. `transaction` snapshots the map and
 * restores it if the body throws, so a failed decision commits nothing.
 */
const key = (kind: string, id: string) => `${kind}\u0000${id}`;

export function makeEntityStoreMemory() {
  let rows = new Map<string, Stored>();
  const service = EntityStore.of({
    get: (kind, id) => {
      const value = rows.get(key(kind, id));
      return value === undefined ? undefined : structuredClone(value);
    },
    put: (kind, id, value) => {
      rows.set(key(kind, id), structuredClone(value));
    },
    remove: (kind, id) => {
      rows.delete(key(kind, id));
    },
    list: (kind) =>
      [...rows.entries()]
        .filter(([k]) => k.startsWith(`${kind}\u0000`))
        .map(([k, value]) => ({ id: k.slice(kind.length + 1), value: structuredClone(value) })),
    transaction: (body) => {
      const snapshot = new Map(rows);
      try {
        return body();
      } catch (error) {
        rows = snapshot;
        throw error;
      }
    },
  });
  return { rows: () => rows, service, layer: Layer.succeed(EntityStore, service) };
}

export function makeEventLogMemory() {
  const published: EventEnvelope[] = [];
  return {
    published,
    layer: Layer.succeed(
      EventLog,
      EventLog.of({ publish: (events) => Effect.sync(() => void published.push(...events)) }),
    ),
  };
}

/** At-least-once delivery would redeliver; this records each job once per dedupe key. */
export function makeWorkQueueMemory() {
  const jobs = new Map<string, Job>();
  return {
    jobs,
    layer: Layer.succeed(
      WorkQueue,
      WorkQueue.of({
        enqueue: (batch) =>
          Effect.sync(() => {
            for (const job of batch) if (!jobs.has(job.dedupeKey)) jobs.set(job.dedupeKey, job);
          }),
      }),
    ),
  };
}

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function makeBundleStoreMemory() {
  const objects = new Map<ContentHash, Uint8Array>();
  return {
    objects,
    layer: Layer.succeed(
      BundleStore,
      BundleStore.of({
        put: (bytes) =>
          Effect.promise(async () => {
            const hash = Schema.decodeUnknownSync(ContentHashSchema)(
              `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes.slice()))}`,
            );
            objects.set(hash, bytes.slice());
            return hash;
          }),
        get: (hash) => {
          const bytes = objects.get(hash);
          return bytes === undefined
            ? Effect.fail(new BundleMissing({ hash }))
            : Effect.succeed(bytes.slice());
        },
      }),
    ),
  };
}

export function makeSessionStoreMemory() {
  const sessions = new Map<SessionId, SessionMessage[]>();
  return {
    sessions,
    layer: Layer.succeed(
      SessionStore,
      SessionStore.of({
        append: (sessionId, messages) =>
          Effect.sync(() => {
            const existing = sessions.get(sessionId) ?? [];
            sessions.set(sessionId, [...existing, ...messages]);
          }),
        read: (sessionId, fromSeq, toSeq) => {
          const messages = sessions.get(sessionId);
          return messages === undefined
            ? Effect.fail(new SessionNotFound({ sessionId }))
            : Effect.succeed(messages.filter((m) => m.seq >= fromSeq && m.seq <= toSeq));
        },
      }),
    ),
  };
}

export function makeMfpWriterMemory() {
  const records: MfpRecord[] = [];
  const notes = new Map<string, MfpRecord[]>();
  return {
    records,
    notes,
    layer: Layer.succeed(
      MfpWriter,
      MfpWriter.of({
        write: (batch) => Effect.sync(() => void records.push(...batch)),
        note: (commit, batch) =>
          Effect.sync(() => void notes.set(commit, [...(notes.get(commit) ?? []), ...batch])),
      }),
    ),
  };
}

/** Optional work runs inline, so tests see its effects deterministically. */
export function makeBackgroundMemory() {
  return { layer: Layer.succeed(Background, Background.of({ run: (work) => work })) };
}

export function makeMetricsMemory() {
  const samples: {
    readonly name: string;
    readonly value: number;
    readonly kind: "count" | "observe";
  }[] = [];
  return {
    samples,
    layer: Layer.succeed(
      Metrics,
      Metrics.of({
        count: (name, value) =>
          Effect.sync(() => void samples.push({ name, value, kind: "count" })),
        observe: (name, value) =>
          Effect.sync(() => void samples.push({ name, value, kind: "observe" })),
      }),
    ),
  };
}

export function makeSecretsProviderMemory(secrets: Readonly<Record<string, string>> = {}) {
  return {
    layer: Layer.succeed(
      SecretsProvider,
      SecretsProvider.of({
        get: (name) => {
          const value = secrets[name];
          return value === undefined
            ? Effect.fail(new SecretMissing({ name }))
            : Effect.succeed(value);
        },
      }),
    ),
  };
}

/** Evidence documents in a Map, keyed by the hash of their canonical JSON; each read is a fresh copy. */
export function makeEvidenceStoreMemory() {
  const documents = new Map<ContentHash, string>();
  return {
    documents,
    layer: Layer.succeed(
      EvidenceStore,
      EvidenceStore.of({
        put: (document) =>
          Effect.sync(() => {
            const hash = contentHashOf(document);
            documents.set(hash, canonicalJson(document));
            return hash;
          }),
        get: (hash) => {
          const stored = documents.get(hash);
          return stored === undefined
            ? Effect.fail(new EvidenceMissing({ hash }))
            : Effect.sync((): Json => JSON.parse(stored));
        },
      }),
    ),
  };
}

/**
 * Plans in a Map, as the text a store keeps, so a test can plant what storage
 * at rest might hold. Every read is verified exactly as the R2 adapter's is.
 */
export function makePlanStoreMemory() {
  const plans = new Map<ContentHash, string>();
  return {
    plans,
    plant: (hash: ContentHash, text: string) => Effect.sync(() => void plans.set(hash, text)),
    layer: Layer.succeed(
      PlanStore,
      PlanStore.of({
        put: (plan) => {
          const text = storedPlanText(plan);
          if (Result.isFailure(text)) return Effect.die(new Error(text.failure));
          return Effect.sync(() => {
            plans.set(plan.planHash, text.success);
            return plan.planHash;
          });
        },
        get: (hash) => {
          const stored = plans.get(hash);
          if (stored === undefined) return Effect.fail(new PlanMissing({ hash }));
          const read = readStoredPlan(hash, stored);
          return Result.isFailure(read)
            ? Effect.fail(new PlanCorrupt({ hash, reason: read.failure }))
            : Effect.succeed(read.success);
        },
      }),
    ),
  };
}
