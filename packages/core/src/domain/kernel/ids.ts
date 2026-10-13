import { Brand, Schema } from "effect";

/**
 * Every Keel identifier is a type prefix followed by a ULID (26 characters of
 * Crockford base32). The prefix makes an id self-describing in logs, URLs and
 * events, and lets a check refuse an id of the wrong kind.
 */
export const ID_PREFIXES = {
  agent: "agt",
  session: "ses",
  run: "run",
  change: "chg",
  workspace: "wsp",
  sketch: "sk",
  subject: "sub",
  candidate: "cnd",
  verdict: "vrd",
  conflict: "cfl",
  decision: "dec",
  probe: "prb",
  event: "evt",
  batch: "bat",
  guard: "grd",
  tenet: "tnt",
  lease: "lse",
  escalation: "esc",
  deployment: "dpl",
  project: "prj",
  user: "usr",
  org: "org",
  credential: "crd",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_${ULID}$`);
}

function prefixed(prefix: IdPrefix) {
  return Schema.String.check(Schema.isPattern(idPattern(prefix)));
}

export const AgentId = prefixed("agt").pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentId.Type;
export const SessionId = prefixed("ses").pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;
/** One stream of an agent's work. An agent may have any number at once. */
export const RunId = prefixed("run").pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

/**
 * What an agent calls one of its runs: one word of lower-case
 * letters and digits, joined by `-`, `_` or `.`, at most 64 characters. It is
 * the agent's own claim; Keel proves only that the run is the agent's.
 */
export const RunLabel = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/)).pipe(
  Schema.brand("RunLabel"),
);
export type RunLabel = typeof RunLabel.Type;

/** A run as an event, a change and a session name it: its id, and its label when the agent gave one. */
export const RunRef = Schema.Struct({ id: RunId, label: Schema.optional(RunLabel) });
export type RunRef = typeof RunRef.Type;
export const ChangeId = prefixed("chg").pipe(Schema.brand("ChangeId"));
export type ChangeId = typeof ChangeId.Type;
export const WorkspaceId = prefixed("wsp").pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;
export const SketchId = prefixed("sk").pipe(Schema.brand("SketchId"));
export type SketchId = typeof SketchId.Type;
export const SubjectId = prefixed("sub").pipe(Schema.brand("SubjectId"));
export type SubjectId = typeof SubjectId.Type;
export const CandidateId = prefixed("cnd").pipe(Schema.brand("CandidateId"));
export type CandidateId = typeof CandidateId.Type;
export const VerdictId = prefixed("vrd").pipe(Schema.brand("VerdictId"));
export type VerdictId = typeof VerdictId.Type;
export const ConflictId = prefixed("cfl").pipe(Schema.brand("ConflictId"));
export type ConflictId = typeof ConflictId.Type;
export const DecisionId = prefixed("dec").pipe(Schema.brand("DecisionId"));
export type DecisionId = typeof DecisionId.Type;
export const ProbeId = prefixed("prb").pipe(Schema.brand("ProbeId"));
export type ProbeId = typeof ProbeId.Type;
export const EventId = prefixed("evt").pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;
export const BatchId = prefixed("bat").pipe(Schema.brand("BatchId"));
export type BatchId = typeof BatchId.Type;
export const GuardId = prefixed("grd").pipe(Schema.brand("GuardId"));
export type GuardId = typeof GuardId.Type;
export const TenetId = prefixed("tnt").pipe(Schema.brand("TenetId"));
export type TenetId = typeof TenetId.Type;
export const LeaseId = prefixed("lse").pipe(Schema.brand("LeaseId"));
export type LeaseId = typeof LeaseId.Type;
export const EscalationId = prefixed("esc").pipe(Schema.brand("EscalationId"));
export type EscalationId = typeof EscalationId.Type;
export const DeploymentId = prefixed("dpl").pipe(Schema.brand("DeploymentId"));
export type DeploymentId = typeof DeploymentId.Type;
export const ProjectId = prefixed("prj").pipe(Schema.brand("ProjectId"));
export type ProjectId = typeof ProjectId.Type;
/** A user, minted by Better Auth's `generateId`. */
export const UserId = prefixed("usr").pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;
/** An org: a tenant owning projects, agents and members. */
export const OrgId = prefixed("org").pipe(Schema.brand("OrgId"));
export type OrgId = typeof OrgId.Type;
/**
 * A namespace: a handle that owns projects. Its id is its account's
 * id, a user's, an agent's or an org's, so there is no id space of its own.
 */
export const NamespaceId = Schema.Union([UserId, AgentId, OrgId]);
export type NamespaceId = typeof NamespaceId.Type;
/** What a namespace is: a person's own, an agent's own, or an org with members and roles. */
export const NamespaceKind = Schema.Literals(["user", "agent", "org"]);
export type NamespaceKind = typeof NamespaceKind.Type;

/**
 * A credential in an org's store, named and never held: the id is minted when
 * the secret is stored, so a record that carries one carries no secret.
 */
export const CredentialId = prefixed("crd").pipe(Schema.brand("CredentialId"));
export type CredentialId = typeof CredentialId.Type;

/** The branded id type for each prefix, so `Ids.next("chg")` returns a `ChangeId`. */
export interface IdOf {
  agt: AgentId;
  ses: SessionId;
  run: RunId;
  chg: ChangeId;
  wsp: WorkspaceId;
  sk: SketchId;
  sub: SubjectId;
  cnd: CandidateId;
  vrd: VerdictId;
  cfl: ConflictId;
  dec: DecisionId;
  prb: ProbeId;
  evt: EventId;
  bat: BatchId;
  grd: GuardId;
  tnt: TenetId;
  lse: LeaseId;
  esc: EscalationId;
  dpl: DeploymentId;
  prj: ProjectId;
  usr: UserId;
  org: OrgId;
  crd: CredentialId;
}

/** A point in time, as milliseconds since the Unix epoch. Time reaches the domain only as a value. */
export type Instant = number & Brand.Brand<"Instant">;
export const Instant = Brand.nominal<Instant>();
export const InstantSchema = Schema.Finite.pipe(Schema.brand("Instant"));

/** Thrown when a string handed to `makeId` is not a ULID. A defect: ids come from `Ids`, never from input. */
export class MalformedId extends Error {
  readonly _tag = "MalformedId";
}

/**
 * Builds the branded id for a prefix from a ULID. The one place a string
 * becomes a branded id without decoding: the pattern is checked here instead.
 */
export function makeId<P extends IdPrefix>(prefix: P, ulid: string): IdOf[P] {
  const id = `${prefix}_${ulid}`;
  if (!isId(prefix, id)) throw new MalformedId(`not a ${prefix} id: ${id}`);
  return id;
}

/** Whether `value` is an id of the given prefix. */
export function isId<P extends IdPrefix>(prefix: P, value: string): value is IdOf[P] {
  return idPattern(prefix).test(value);
}

/** A namespace's kind, read from its id: the id is its account's, so its prefix says which. */
export function namespaceKind(id: NamespaceId): NamespaceKind {
  if (isId("usr", id)) return "user";
  if (isId("agt", id)) return "agent";
  return "org";
}
