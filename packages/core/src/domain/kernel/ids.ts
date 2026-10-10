import { Brand, Schema } from "effect";

/**
 * Every Keel identifier is a type prefix followed by a ULID (26 characters of
 * Crockford base32). The prefix makes an id self-describing in logs, URLs and
 * events, and lets a check refuse an id of the wrong kind.
 */
export const ID_PREFIXES = {
  agent: "agt",
  session: "ses",
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

/** The branded id type for each prefix, so `Ids.next("chg")` returns a `ChangeId`. */
export interface IdOf {
  agt: AgentId;
  ses: SessionId;
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
}

/** A point in time, as milliseconds since the Unix epoch. Time reaches the domain only as a value. */
export type Instant = number & Brand.Brand<"Instant">;
export const Instant = Brand.nominal<Instant>();
export const InstantSchema = Schema.Number.pipe(Schema.brand("Instant"));

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
