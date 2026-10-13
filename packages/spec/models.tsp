import "@typespec/http";
import "@bimsonz/mfp";
import "./common.tsp";

namespace Keel;

// Shapes shared by several resource groups. Propositions, anchors and
// footprints are MFP's own shapes, so what an agent declares here is already
// a valid MFP claim.

/** A coordination action Keel suggests or an agent takes. */
union Move {
  proceed: "proceed",
  coordinate: "coordinate",
  refine: "refine",
  sequence: "sequence",
  yield: "yield",
  merge: "merge",
  distinguish: "distinguish",
  escalate: "escalate",
}

union ChangeState {
  declared: "declared",
  working: "working",
  submitted: "submitted",
  deriving: "deriving",
  drifted: "drifted",
  verifying: "verifying",
  queued: "queued",
  integrating: "integrating",
  landed: "landed",
  bounced: "bounced",
  parked: "parked",
  withdrawn: "withdrawn",
  superseded: "superseded",
}

model Lease {
  id: LeaseId;
  renewedAt: utcDateTime;

  /** When the lease lapses unless the agent acts on the change again. */
  lapsesAt: utcDateTime;
}

/**
 * The throwaway repo a change is worked in, and how to push to it:
 * clone `remote`, commit, push `HEAD:refs/heads/main`, then submit the
 * commit's sha. A push alone lands nothing.
 */
model Workspace {
  id: WorkspaceId;

  /** The git remote to clone and push to, over HTTPS. */
  remote: string;

  /**
   * A write token for this workspace only. Shown once. Git presents it as a
   * bearer, for the clone and the push alike:
   * `git -c http.extraHeader="Authorization: Bearer <token>" clone <remote>`.
   */
  token?: string;

  expiresAt: utcDateTime;

  /**
   * The commit the workspace's `main` was at when it was granted: the first
   * `expectedHead` of a `commit`, and the change's base until it rebases.
   */
  baseSha: CommitSha;
}

model Change {
  id: ChangeId;
  agentId: AgentId;
  state: ChangeState;
  revision: int32;
  goal: string;
  footprint: MFP.FootprintEntry[];
  premises: MFP.Proposition[];

  /** Effects the agent declared it expects to cause. Advisory only: Keel derives effects from the diff. */
  declaredEffects?: MFP.Proposition[];

  /** The commit last submitted; it is the commit that lands. */
  commitSha?: CommitSha;

  /** The run of the agent that holds the change, when its token named one. */
  run?: RunRef;

  createdAt: utcDateTime;
}

/** Another change near this one: on the same subjects, or overlapping its footprint (exposure). */
model Neighbour {
  changeId: ChangeId;
  goal: string;
  subjects: SubjectKey[];
  overlap: "subject" | "footprint";
}

/** A premise and the proposition contradicting it: one change's premise (or a tenet) against another change's premise or effect. */
model Contradiction {
  premise: MFP.Proposition;
  with: MFP.Proposition;

  /** The change or tenet holding the premise. */
  holder: string;

  /** Whether `with` is a premise or an effect. Always set by Keel; absent (an answer replayed from an older event) reads as an effect. */
  withRole?: "premise" | "effect";
}

/** A move resting on one of the preflight's contradictions, by its index in that list. */
model ContradictionBasis {
  _tag: "contradiction";

  @minValue(0)
  index: integer;
}

/** A move resting on a precedent in scope. */
model PrecedentBasis {
  _tag: "precedent";
  decisionId: DecisionId;
}

/** What a suggested move rests on. */
union MoveBasis {
  contradiction: ContradictionBasis,
  precedent: PrecedentBasis,
}

model PrecedentRef {
  decisionId: DecisionId;
  summary: string;
  decidedAt: utcDateTime;
  scope?: string;
}

/** What Keel tells an agent as soon as it declares an intent. */
model Preflight {
  neighbours: Neighbour[];
  contradictions: Contradiction[];
  precedents: PrecedentRef[];
  suggestedMove: Move;

  /** What the move rests on: a contradiction above, by index, or a precedent. Absent when the move is `proceed`. */
  basis?: MoveBasis;

  /**
   * The live changes with the same intent (their declared effects make the same claims), in the
   * order the live index gave them, never ranked. Absent when there are none; the move never reads them.
   */
  alternatives?: ChangeId[];
}

union ConflictKind {
  textual: "textual",
  semantic: "semantic",
  precedent: "precedent",
  interaction: "interaction",
}

union ConflictState {
  suspected: "suspected",
  probing: "probing",
  proven: "proven",
  dismissed: "dismissed",
  escalated: "escalated",
  resolved: "resolved",
}

model ConflictView {
  id: ConflictId;
  kind: ConflictKind;
  state: ConflictState;
  parties: string[];
  subject?: SubjectKey;
  openedAt: utcDateTime;
}

union VerdictOutcome {
  land: "land",
  bounce: "bounce",
  park: "park",
  hold: "hold",
  supersede: "supersede",
}

model VerdictView {
  id: VerdictId;
  outcome: VerdictOutcome;
  reasons: MFP.Evidence[];
  issuedAt: utcDateTime;
}

/**
 * A decision as Keel remembers it: what a person's ruling chose, and what it
 * settled of the conflict it ruled. A guard that holds an active decision
 * bounces a change that breaks what it upheld, whatever the predicate's policy.
 */
model DecisionView {
  id: DecisionId;

  /** Its `D-n`, counted per project, as the feed labels it. */
  label: string;

  /** The option the ruling chose. */
  option: string;

  /** The chosen option's label. */
  summary: string;

  scope?: string;
  decidedAt: utcDateTime;
  state: "active" | "superseded" | "overruled";

  /** The escalation whose ruling recorded it. */
  escalationId: EscalationId;

  project: ProjectId;

  /** The conflict it ruled. */
  conflictId?: ConflictId;

  /** That conflict's subject. */
  subject?: SubjectKey;

  /** What the ruling upheld of the conflict's premise and effect: empty when it favoured neither. */
  holds: EventProposition[];

  /** The changes the ruling went against. */
  against?: ChangeId[];

  /** The guards that hold it while it is active. */
  guards: GuardId[];
}
