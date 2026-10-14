import { Effect, Option, Schema } from "effect";
import type { Change, Proposition, SubjectKey } from "../../domain/coordination/index.ts";
import { type Anchor, ChangeId, type Citation, type ProjectId } from "../../domain/kernel/index.ts";
import {
  type MfpAnchor,
  type MfpAuthor,
  type MfpCitation,
  type MfpProposition,
  type MfpRecord,
  NothingToExplain,
  type WhyLink,
} from "../../domain/memory/index.ts";
import {
  type ChangeView,
  type ConflictRecord,
  Decisions,
  type IndexedDecision,
  ProjectViews,
} from "../ports/index.ts";

/**
 * What `why` is asked about: a subject, or a file. A subject's anchors name a
 * file and no lines, so a line in the file narrows nothing; it is kept only to
 * say what was asked.
 */
export type WhyTarget =
  | { readonly kind: "subject"; readonly subject: SubjectKey }
  | { readonly kind: "path"; readonly path: string; readonly line?: number | undefined };

/** Keel, as the author of what it observed and concluded. */
export const KEEL_AUTHOR: MfpAuthor = { kind: "platform", id: "keel" };

/** What one decision's chain is read from: the decision, its conflict as folded, and each change the conflict names, by id, as folded. */
export interface WhySources {
  readonly decision: IndexedDecision;
  readonly conflict?: ConflictRecord | undefined;
  readonly changes: ReadonlyMap<string, ChangeView>;
}

const iso = (ms: number) => new Date(ms).toISOString();
const isChangeId = Schema.is(ChangeId);

/** A proposition as a person reads it: `authz.session freshness at-most per-request`. */
const said = (p: Proposition): string =>
  `${p.subject} ${p.predicate} ${p.relation} ${String(p.value)}${p.unit === undefined ? "" : ` ${p.unit}`}`;

const anchorOf = (anchor: Anchor): MfpAnchor => ({
  path: anchor.path,
  ...(anchor.symbol === undefined ? {} : { symbol: anchor.symbol }),
  commit: anchor.commit,
});

/** The domain tags a citation by `_tag`; MFP by `kind`. */
function citationOf(citation: Citation): MfpCitation {
  switch (citation._tag) {
    case "message":
      return { kind: "message", session: citation.session, seq: citation.seq };
    case "anchor":
      return { kind: "anchor", anchor: anchorOf(citation.anchor) };
    case "record":
      return { kind: "record", id: citation.id };
    default: {
      const unmapped: never = citation;
      return unmapped;
    }
  }
}

/** A proposition as MFP writes it: `strength` always, `must` where the holder gave none. */
export const mfpProposition = (p: Proposition): MfpProposition => ({
  subject: p.subject,
  predicate: p.predicate,
  relation: p.relation,
  value: p.value,
  ...(p.unit === undefined ? {} : { unit: p.unit }),
  ...(p.scope === undefined ? {} : { scope: p.scope }),
  ...(p.anchors === undefined ? {} : { anchors: p.anchors.map(anchorOf) }),
  ...(p.gloss === undefined ? {} : { gloss: p.gloss }),
  strength: p.strength ?? "must",
  ...(p.cites === undefined ? {} : { cites: p.cites.map(citationOf) }),
});

const cite = (record: MfpRecord): MfpCitation => ({ kind: "record", id: record.id });

/** An agent's change is its agent's claim; one an auditor or an operator opened is Keel's. */
const authorOf = (change: Change): MfpAuthor =>
  change.origin === "agent" ? { kind: "agent", id: change.agentId } : KEEL_AUTHOR;

/** The intent a change holds now, as its agent declared it. */
function intentLink(change: Change, proposition: Proposition): WhyLink {
  const { intent } = change;
  return {
    summary: `${change.id} intends "${intent.goal}", which makes ${said(proposition)}`,
    record: {
      mfp: "0.1",
      kind: "intent",
      id: `${change.id}.intent.${intent.revision}`,
      change: change.id,
      author: authorOf(change),
      // The view keeps no time per revision: the change's own is when it was declared.
      at: iso(change.createdAt),
      cites: [],
      payload: {
        revision: intent.revision,
        goal: intent.goal,
        footprint: intent.footprint.map((entry) => ({
          path: entry.path,
          ...(entry.symbol === undefined ? {} : { symbol: entry.symbol }),
          op: entry.op,
        })),
        premises: intent.premises.map(mfpProposition),
        ...(intent.declaredEffects === undefined
          ? {}
          : { declaredEffects: intent.declaredEffects.map(mfpProposition) }),
      },
    },
  };
}

/**
 * One active decision's chain, each link an MFP 0.1 record: the decision,
 * the premise its conflict was about, the intent of the change whose effect
 * met it, each guard that holds it, then each party the ruling did not go
 * against that has landed since its resolution was heard. The decision cites
 * the records after it but the landings, which cite the decision. A decision
 * with nothing to cite cannot be stated as MFP has a decision, so it explains
 * nothing.
 */
export function whyChain({ decision: indexed, conflict: record, changes }: WhySources): WhyLink[] {
  const { decision, label } = indexed;
  const conflict = record?.conflict;
  const grounds: WhyLink[] = [];
  const premise = conflict?.premise;
  if (conflict !== undefined && premise !== undefined) {
    const holder = changes.get(premise.holder)?.change;
    grounds.push({
      summary: `${premise.holder} relies on ${said(premise.proposition)}`,
      record: {
        mfp: "0.1",
        kind: "premise",
        id: `${conflict.id}.premise`,
        change: premise.holder,
        author: holder === undefined ? KEEL_AUTHOR : authorOf(holder),
        // The premise as its conflict put it at stake.
        at: iso(conflict.openedAt),
        cites: [],
        payload: { proposition: mfpProposition(premise.proposition) },
      },
    });
  }
  const effect = conflict?.effect;
  const maker = effect === undefined ? undefined : changes.get(effect.changeId)?.change;
  if (effect !== undefined && maker !== undefined)
    grounds.push(intentLink(maker, effect.proposition));
  const guard = record?.guard;
  if (guard !== undefined && indexed.guards.includes(guard.id)) {
    const premiseRecord = grounds.find((link) => link.record.kind === "premise")?.record;
    const admittedAt = iso(guard.admittedAt);
    grounds.push({
      summary: `${record?.labels.guard ?? guard.id} holds ${label}: probe ${guard.probeId} told the worlds apart in ${guard.runs} runs`,
      record: {
        mfp: "0.1",
        kind: "observation",
        id: guard.id,
        author: KEEL_AUTHOR,
        at: admittedAt,
        evidenceClass: "proof",
        cites: premiseRecord === undefined ? [] : [cite(premiseRecord)],
        payload: {
          category: "guard",
          importance: "high",
          summary: `Guard ${guard.id} asserts the premise ${label} upheld, from probe ${guard.probeId}`,
          evidence: [{ class: "proof", ref: guard.probeId, at: admittedAt }],
        },
      },
    });
  }
  if (grounds.length === 0) return [];
  const escalation =
    record?.escalation?.id === decision.escalationId ? record.escalation : undefined;
  const ruler = escalation?.ruling?.by;
  const decided: WhyLink = {
    summary: `${label} ruled ${decision.option}: ${decision.summary}`,
    record: {
      mfp: "0.1",
      kind: "decision",
      id: decision.id,
      author: ruler === undefined || ruler === "" ? KEEL_AUTHOR : { kind: "human", id: ruler },
      at: iso(decision.decidedAt),
      evidenceClass: "ruling",
      ...(decision.scope === undefined ? {} : { scope: decision.scope }),
      cites: grounds.map((link) => cite(link.record)),
      payload: {
        ...(escalation === undefined ? {} : { question: escalation.question }),
        chosen: decision.option,
        rationale: decision.summary === "" ? decision.option : decision.summary,
        alternatives: decision.alternatives
          .filter((alternative) => alternative.option !== "")
          .map((alternative) => ({
            option: alternative.option,
            reasonRejected:
              alternative.reasonRejected === ""
                ? `Ruled for ${decision.option} instead`
                : alternative.reasonRejected,
          })),
        reversible: true,
      },
    },
  };
  // Who the ruling went against is known once its resolution is heard; until then nothing landed under it.
  const resolved = conflict?.decisionId === decision.id ? conflict : undefined;
  const against: ReadonlySet<string> = new Set(indexed.against ?? []);
  const landed = (resolved?.parties ?? []).flatMap((party): WhyLink[] => {
    const view = against.has(party) ? undefined : changes.get(party);
    const commit = view?.change.landedCommit;
    if (view === undefined || commit === undefined) return [];
    const at = iso(view.updatedAt);
    return [
      {
        summary: `${party} landed as ${commit} under ${label}`,
        record: {
          mfp: "0.1",
          kind: "verdict",
          id: `${party}.landed`,
          change: party,
          author: KEEL_AUTHOR,
          at,
          cites: [cite(decided.record)],
          payload: { outcome: "land", reasons: [{ class: "proof", ref: commit, at }] },
        },
      },
    ];
  });
  return [decided, ...grounds, ...landed];
}

/** The decision's conflict and the changes it names, as the Projector folded them; what it has not folded is left out. */
export const whySources = Effect.fn("memory/whySources")(function* (
  project: ProjectId,
  decision: IndexedDecision,
) {
  const views = yield* ProjectViews;
  const conflict =
    decision.conflictId === undefined
      ? undefined
      : Option.getOrUndefined(yield* Effect.option(views.conflict(project, decision.conflictId)));
  const named = new Set(
    [
      conflict?.conflict.premise?.holder,
      conflict?.conflict.effect?.changeId,
      ...(conflict?.conflict.parties ?? []),
    ].filter(isChangeId),
  );
  const read = yield* Effect.forEach(
    named,
    (changeId) => Effect.option(views.change(project, changeId)),
    { concurrency: "unbounded" },
  );
  const changes = new Map<string, ChangeView>();
  for (const view of read) if (Option.isSome(view)) changes.set(view.value.change.id, view.value);
  return { decision, conflict, changes } satisfies WhySources;
});

/** What was asked, as an answer names it: the subject, or the path with its line. */
export const whyAsked = (target: WhyTarget): string =>
  target.kind === "subject"
    ? target.subject
    : target.line === undefined
      ? target.path
      : `${target.path}:${target.line}`;

/**
 * Why a subject, or a file, is the way it is, in a project: each active
 * decision on the subject or on a subject anchored in the file, newest first,
 * with its chain. NothingToExplain where no active decision explains it.
 */
export const why: (
  project: ProjectId,
  target: WhyTarget,
) => Effect.Effect<readonly WhyLink[], NothingToExplain, Decisions | ProjectViews> = Effect.fn(
  "memory/why",
)(function* (project: ProjectId, target: WhyTarget) {
  const decisions = yield* Decisions;
  const found =
    target.kind === "subject"
      ? yield* decisions.onSubjects(project, [target.subject])
      : yield* decisions.atPath(project, target.path);
  const active = found.filter((d) => d.decision.state === "active");
  const sources = yield* Effect.forEach(active, (decision) => whySources(project, decision), {
    concurrency: "unbounded",
  });
  const chain = sources.flatMap((read) => whyChain(read));
  if (chain.length === 0) return yield* new NothingToExplain({ target: whyAsked(target) });
  return chain;
});
