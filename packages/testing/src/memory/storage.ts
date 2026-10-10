import { BundleMissing } from "@keeltown/core/domain/verification";
import { SecretMissing } from "@keeltown/core/domain/delivery";
import type { ContentHash, EventEnvelope, SessionId } from "@keeltown/core/kernel";
import { ContentHash as ContentHashSchema } from "@keeltown/core/kernel";
import {
  Background,
  BundleStore,
  EntityStore,
  EventLog,
  EventOutbox,
  type Job,
  Metrics,
  type MfpRecord,
  MfpWriter,
  SecretsProvider,
  type SessionMessage,
  SessionStore,
  type Stored,
  WorkQueue,
} from "@keeltown/core/ports";
import { SessionNotFound } from "@keeltown/core/domain/memory";
import { Effect, Layer, Schema } from "effect";

/**
 * A Durable Object's storage, in a Map. `transaction` snapshots the map and
 * restores it if the body throws, so a failed decision commits nothing.
 */
const key = (kind: string, id: string) => `${kind}\u0000${id}`;

export function makeEntityStoreMemory() {
  let rows = new Map<string, Stored>();
  return {
    rows: () => rows,
    layer: Layer.succeed(
      EntityStore,
      EntityStore.of({
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
      }),
    ),
  };
}

export function makeEventOutboxMemory() {
  const pending: EventEnvelope[] = [];
  return {
    pending,
    layer: Layer.succeed(
      EventOutbox,
      EventOutbox.of({
        append: (events) => {
          pending.push(...events);
        },
        pending: (limit) => pending.slice(0, limit),
        acknowledge: (eventIds) =>
          Effect.sync(() => {
            for (let i = pending.length - 1; i >= 0; i -= 1) {
              const event = pending[i];
              if (event !== undefined && eventIds.includes(event.eventId)) pending.splice(i, 1);
            }
          }),
      }),
    ),
  };
}

export function makeEventLogMemory() {
  const published: EventEnvelope[] = [];
  return {
    published,
    layer: Layer.succeed(EventLog, EventLog.of({ publish: (events) => Effect.sync(() => void published.push(...events)) })),
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

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function makeBundleStoreMemory() {
  const objects = new Map<ContentHash, Uint8Array>();
  return {
    objects,
    layer: Layer.succeed(
      BundleStore,
      BundleStore.of({
        put: (bytes) =>
          Effect.promise(async () => {
            const hash = Schema.decodeUnknownSync(ContentHashSchema)(`sha256:${hex(await crypto.subtle.digest("SHA-256", bytes.slice()))}`);
            objects.set(hash, bytes.slice());
            return hash;
          }),
        get: (hash) => {
          const bytes = objects.get(hash);
          return bytes === undefined ? Effect.fail(new BundleMissing({ hash })) : Effect.succeed(bytes.slice());
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
        note: (commit, batch) => Effect.sync(() => void notes.set(commit, [...(notes.get(commit) ?? []), ...batch])),
      }),
    ),
  };
}

/** Optional work runs inline, so tests see its effects deterministically. */
export function makeBackgroundMemory() {
  return { layer: Layer.succeed(Background, Background.of({ run: (work) => work })) };
}

export function makeMetricsMemory() {
  const samples: { readonly name: string; readonly value: number; readonly kind: "count" | "observe" }[] = [];
  return {
    samples,
    layer: Layer.succeed(
      Metrics,
      Metrics.of({
        count: (name, value) => Effect.sync(() => void samples.push({ name, value, kind: "count" })),
        observe: (name, value) => Effect.sync(() => void samples.push({ name, value, kind: "observe" })),
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
          return value === undefined ? Effect.fail(new SecretMissing({ name })) : Effect.succeed(value);
        },
      }),
    ),
  };
}
