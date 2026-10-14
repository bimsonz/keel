import {
  namespaceKey,
  readStoredPlan,
  storedPlanText,
} from "@keeltown/core/application/verification";
import { BundleMissing } from "@keeltown/core/domain/verification";
import type { ContentHash, EventEnvelope, NamespaceId, SessionId } from "@keeltown/core/kernel";
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
  type SessionMessage,
  SessionStore,
  type Stored,
  WorkQueue,
} from "@keeltown/core/ports";
import { SessionNotFound } from "@keeltown/core/domain/memory";
import { Effect, Layer, Result, Schema } from "effect";

/**
 * A Durable Object's storage, in a Map. `transaction` snapshots the map and
 * restores it if the body throws, so a failed decision commits nothing. A
 * list answers in id order, as SQLite's `ORDER BY id` does, and a prefix keeps
 * the ids that start with it.
 */
const key = (kind: string, id: string) => `${kind}\u0000${id}`;

/** A UTF-16 unit, moved so that comparing units compares code points: surrogates sort above U+E000–U+FFFF. */
const unitRank = (unit: number): number =>
  unit >= 0xd800 && unit < 0xe000 ? unit + 0x2000 : unit >= 0xe000 ? unit - 0x800 : unit;

/** Two ids in code point order, SQLite's order for text. */
const byCodePoint = (a: string, b: string): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a.charCodeAt(i), b.charCodeAt(i)];
    if (x !== y) return unitRank(x) - unitRank(y);
  }
  return a.length - b.length;
};

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
    list: (kind, idPrefix = "") =>
      [...rows.entries()]
        .filter(([k]) => k.startsWith(key(kind, idPrefix)))
        .map(([k, value]) => ({ id: k.slice(kind.length + 1), value: structuredClone(value) }))
        .toSorted((a, b) => byCodePoint(a.id, b.id)),
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

/** The hex of a content hash: what a namespace's key ends with. */
const hexOf = (hash: ContentHash): string => hash.slice("sha256:".length);

/** Where each memory store keeps a namespace's object: the key its R2 adapter builds. */
const bundleKeyOf = (namespace: NamespaceId, hash: ContentHash) =>
  namespaceKey(namespace, "bundles", hexOf(hash));
const evidenceKeyOf = (namespace: NamespaceId, hash: ContentHash) =>
  namespaceKey(namespace, "evidence", hexOf(hash));
const planKeyOf = (namespace: NamespaceId, hash: ContentHash) =>
  namespaceKey(namespace, "plans", hexOf(hash));

/** Bundles in a Map, under the key the R2 adapter keeps them at: a namespace's bundles, by hash. */
export function makeBundleStoreMemory() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    layer: Layer.succeed(
      BundleStore,
      BundleStore.of({
        put: (namespace, bytes) =>
          Effect.promise(async () => {
            const hash = Schema.decodeUnknownSync(ContentHashSchema)(
              `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes.slice()))}`,
            );
            objects.set(bundleKeyOf(namespace, hash), bytes.slice());
            return hash;
          }),
        get: (namespace, hash) => {
          const bytes = objects.get(bundleKeyOf(namespace, hash));
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

/**
 * Evidence documents in a Map, under the key the R2 adapter keeps them at: a
 * namespace's evidence, by the hash of the document's canonical JSON. Each
 * read is a fresh copy.
 */
export function makeEvidenceStoreMemory() {
  const documents = new Map<string, string>();
  return {
    documents,
    layer: Layer.succeed(
      EvidenceStore,
      EvidenceStore.of({
        put: (namespace, document) =>
          Effect.sync(() => {
            const hash = contentHashOf(document);
            documents.set(evidenceKeyOf(namespace, hash), canonicalJson(document));
            return hash;
          }),
        get: (namespace, hash) => {
          const stored = documents.get(evidenceKeyOf(namespace, hash));
          return stored === undefined
            ? Effect.fail(new EvidenceMissing({ hash }))
            : Effect.sync((): Json => JSON.parse(stored));
        },
      }),
    ),
  };
}

/**
 * Plans in a Map, as the text a store keeps under a namespace's key, so a
 * test can plant what storage at rest might hold. Every read is verified
 * exactly as the R2 adapter's is.
 */
export function makePlanStoreMemory() {
  const plans = new Map<string, string>();
  return {
    plans,
    plant: (namespace: NamespaceId, hash: ContentHash, text: string) =>
      Effect.sync(() => void plans.set(planKeyOf(namespace, hash), text)),
    layer: Layer.succeed(
      PlanStore,
      PlanStore.of({
        put: (namespace, plan) => {
          const text = storedPlanText(plan);
          if (Result.isFailure(text)) return Effect.die(new Error(text.failure));
          return Effect.sync(() => {
            plans.set(planKeyOf(namespace, plan.planHash), text.success);
            return plan.planHash;
          });
        },
        get: (namespace, hash) => {
          const stored = plans.get(planKeyOf(namespace, hash));
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
