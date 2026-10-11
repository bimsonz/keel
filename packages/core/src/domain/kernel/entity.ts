import { Schema } from "effect";

/** The kinds of entity a Durable Object owns (docs/domain/state-machines.md § Ownership). */
export const EntityKind = Schema.Literals([
  "agent",
  "session",
  "change",
  "subject",
  "sketch",
  "workspace",
  "conflict",
  "probe",
  "guard",
  "verdict",
  "batch",
  "candidate",
  "project",
  /** The Trunk DO's promotion state, keyed by project (`trunk:<projectId>`), with its own seq. */
  "trunk",
  "decision",
  "tenet",
  "escalation",
  "deployment",
  /** A user's tenancy events (`user:<userId>`), committed from Better Auth's after-hooks. */
  "user",
  /** An org's tenancy events (`org:<orgId>`), committed from Better Auth's after-hooks. */
  "org",
]);
export type EntityKind = typeof EntityKind.Type;

export const EntityRef = Schema.Struct({ kind: EntityKind, id: Schema.String });
export type EntityRef = typeof EntityRef.Type;
