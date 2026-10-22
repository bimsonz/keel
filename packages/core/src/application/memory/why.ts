import { Effect, Result, Schema } from "effect";
import {
  type Change,
  type MfpCitation,
  type Proposition,
  effectToMfp,
  premiseToMfp,
} from "../../domain/coordination/index.ts";
import { ChangeId, type ProjectId } from "../../domain/kernel/index.ts";
import {
  KEEL_MFP_PROFILE,
  type KeelRecord,
  NothingToExplain,
  type RecordAuthor,
  type WhyLink,
} from "../../domain/memory/index.ts";
import {
  type ChangeView,
  Decisions,
  EntityStore,
  type IndexedDecision,
  type WhySource,
  type WhyTarget,
} from "../ports/index.ts";
import { changeViewOf } from "./change-views.ts";
import { conflictRecordOf } from "./conflict-views.ts";
import { pathDecisionsOf, subjectDecisionsOf } from "./decision-index.ts";

/** Keel, as the author of what it observed and concluded. */
export const KEEL_AUTHOR: RecordAuthor = { kind: "platform", id: "keel" };

/** The members every message Keel states carries: MFP 0.2, under Keel's profile. */
const stated = <K extends string>(kind: K) =>
  ({ mfp: "0.2", kind, profile: KEEL_MFP_PROFILE }) as const;

type Store = (typeof EntityStore)["Service"];

const iso = (ms: number) => new Date(ms).toISOString();
const isChangeId = Schema.is(ChangeId);

/** A proposition as a person reads it: `authz.session freshness at-most per-request`. */
const said = (p: Proposition): string =>
  `${p.subject} ${p.predicate} ${p.relation} ${String(p.value)}${p.unit === undefined ? "" : ` ${p.unit}`}`;

/** What told in MFP 0.2: a stored proposition with no 0.2 form is left out, never repaired. */
const told = <A, E>(result: Result.Result<A, E>): A[] =>
  Result.isSuccess(result) ? [result.success] : [];

const cite = (record: KeelRecord): MfpCitation => ({ kind: "record", ref: record.id });

/**
 * An agent's change is its agent's claim, and a proposal its proposer's, a
 * person's or an agent's; one an auditor or an operator opened is Keel's.
 */
const authorOf = (change: Change): RecordAuthor => {
  if (change.origin === "agent" && change.agentId !== undefined)
    return { kind: "agent", id: change.agentId };
  if (change.proposal === undefined) return KEEL_AUTHOR;
  const [kind, id = ""] = change.proposal.proposer.split(":");
  return { kind: kind === "user" ? "human" : "agent", id };
};

/** The intent a change holds now, as its agent declared it, as Keel's record states it. */
function intentRecord(change: Change): KeelRecord {
  const { intent } = change;
  return {
    id: `${change.id}.intent.${intent.revision}`,
    change: change.id,
    author: authorOf(change),
    // The view keeps no time per revision: the change's own is when it was declared.
    at: iso(change.createdAt),
    message: {
      ...stated("intent"),
      goal: intent.goal,
      footprint: intent.footprint.map((entry) => ({
        path: entry.path,
        ...(entry.symbol === undefined ? {} : { symbol: entry.symbol }),
        op: entry.op,
      })),
      premises: intent.premises.flatMap((p) => told(premiseToMfp(p))),
      ...(intent.declaredEffects === undefined
        ? {}
        : { declaredEffects: intent.declaredEffects.flatMap((p) => told(effectToMfp(p))) }),
    },
  };
}

/** The intent of the change whose effect met a decision's premise. */
function intentLink(change: Change, proposition: Proposition): WhyLink {
  return {
    summary: `${change.id} intends "${change.intent.goal}", which makes ${said(proposition)}`,
    record: intentRecord(change),
  };
}

/**
 * One active decision's chain, each link Keel's record of an MFP 0.2 message:
 * the decision, the premise its conflict was about, the intent of the change
 * whose effect met it, each guard that holds it, then, once its resolution is
 * heard, each party the ruling did not go against that landed at or after the
 * ruling. The decision cites the records after it but the landings, which cite
 * the decision. A decision with nothing to cite cannot be stated as MFP has a
 * decision, so it explains nothing; a premise with no 0.2 form is not stated.
 */
export function whyChain({
  decision: indexed,
  conflict: record,
  changes: views,
}: WhySource): WhyLink[] {
  const { decision, label } = indexed;
  const changes = new Map<string, ChangeView>(views.map((view) => [view.change.id, view]));
  const conflict = record?.conflict;
  const grounds: WhyLink[] = [];
  const premise = conflict?.premise;
  const premiseTold = premise === undefined ? [] : told(premiseToMfp(premise.proposition));
  if (conflict !== undefined && premise !== undefined && premiseTold[0] !== undefined) {
    const holder = changes.get(premise.holder)?.change;
    grounds.push({
      summary: `${premise.holder} relies on ${said(premise.proposition)}`,
      record: {
        id: `${conflict.id}.premise`,
        ...(isChangeId(premise.holder) ? { change: premise.holder } : {}),
        author: holder === undefined ? KEEL_AUTHOR : authorOf(holder),
        // The premise as its conflict put it at stake.
        at: iso(conflict.openedAt),
        message: { ...stated("premise"), premise: premiseTold[0] },
      },
    });
  }
  const effect = conflict?.effect;
  const maker = effect === undefined ? undefined : changes.get(effect.changeId)?.change;
  if (effect !== undefined && maker !== undefined)
    grounds.push(intentLink(maker, effect.proposition));
  const guard = record?.guard;
  if (guard !== undefined && indexed.guards.includes(guard.id)) {
    const premiseRecord = grounds.find((link) => link.record.message.kind === "premise")?.record;
    grounds.push({
      summary: `${record?.labels.guard ?? guard.id} holds ${label}: probe ${guard.probeId} told the worlds apart in ${guard.runs} runs`,
      record: {
        id: guard.id,
        author: KEEL_AUTHOR,
        at: iso(guard.admittedAt),
        evidenceClass: "proof",
        message: {
          ...stated("observation"),
          category: "guard",
          importance: "high",
          summary: `Guard ${guard.id} asserts the premise ${label} upheld, from probe ${guard.probeId}`,
          // What it rests on: the premise it asserts, and the probe that proved it.
          cites: [
            ...(premiseRecord === undefined ? [] : [cite(premiseRecord)]),
            { kind: "record", ref: guard.probeId },
          ],
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
      id: decision.id,
      author: ruler === undefined || ruler === "" ? KEEL_AUTHOR : { kind: "human", id: ruler },
      at: iso(decision.decidedAt),
      evidenceClass: "ruling",
      ...(decision.scope === undefined ? {} : { scope: decision.scope }),
      message: {
        ...stated("decision"),
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
        cites: grounds.map((link) => cite(link.record)),
      },
    },
  };
  // Who the ruling went against is known once its resolution is heard; until then nothing landed under it.
  const resolved = conflict?.decisionId === decision.id ? conflict : undefined;
  const against: ReadonlySet<string> = new Set(indexed.against ?? []);
  const landed = (resolved?.parties ?? []).flatMap((party): WhyLink[] => {
    const view = against.has(party) ? undefined : changes.get(party);
    const commit = view?.change.landedCommit;
    const landedAt = view?.landedAt;
    // A party that landed before the ruling did not land under it.
    if (view === undefined || commit === undefined || landedAt === undefined) return [];
    if (landedAt < decision.decidedAt) return [];
    return [
      {
        summary: `${party} landed as ${commit} under ${label}`,
        record: {
          // A party favoured by two decisions landed under each: one record apiece.
          id: `${party}.landed.${decision.id}`,
          change: view.change.id,
          author: KEEL_AUTHOR,
          at: iso(landedAt),
          evidenceClass: "proof",
          message: {
            ...stated("verdict"),
            outcome: "land",
            reasons: [
              { summary: `Landed as ${commit} under ${label}`, cites: [cite(decided.record)] },
            ],
          },
        },
      },
    ];
  });
  return [decided, ...grounds, ...landed];
}

/** One decision's conflict and the changes it names, as the Projector folded them, read in the caller's transaction; what it has not folded is left out. */
function sourceOf(store: Store, project: ProjectId, decision: IndexedDecision): WhySource {
  const conflict =
    decision.conflictId === undefined
      ? undefined
      : conflictRecordOf(store, project, decision.conflictId);
  const named = new Set(
    [
      conflict?.conflict.premise?.holder,
      conflict?.conflict.effect?.changeId,
      ...(conflict?.conflict.parties ?? []),
    ].filter(isChangeId),
  );
  return {
    decision,
    ...(conflict === undefined ? {} : { conflict }),
    changes: [...named].flatMap((changeId) => changeViewOf(store, project, changeId) ?? []),
  };
}

/**
 * The project's active decisions on what was asked, newest first, each with
 * its conflict and the changes it names, read in one transaction: what
 * `Decisions.explaining` answers.
 */
export const explaining: (
  project: ProjectId,
  target: WhyTarget,
) => Effect.Effect<readonly WhySource[], never, EntityStore> = Effect.fn("memory/explaining")(
  function* (project: ProjectId, target: WhyTarget) {
    const store = yield* EntityStore;
    return store.transaction(() => {
      const found =
        target.kind === "subject"
          ? subjectDecisionsOf(store, project, [target.subject])
          : pathDecisionsOf(store, project, target.path);
      return found
        .filter((d) => d.decision.state === "active")
        .map((decision) => sourceOf(store, project, decision));
    });
  },
);

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
) => Effect.Effect<readonly WhyLink[], NothingToExplain, Decisions> = Effect.fn("memory/why")(
  function* (project: ProjectId, target: WhyTarget) {
    // One read of the Projector: every active decision, with all its chain is built from.
    const chain = (yield* (yield* Decisions).explaining(project, target)).flatMap(whyChain);
    if (chain.length === 0) return yield* new NothingToExplain({ target: whyAsked(target) });
    return chain;
  },
);

/** How many of a path's landings `why` names when no decision explains the path. */
export const WHY_LANDINGS = 3;

/**
 * What `why` answers: the active decisions that explain what was asked, or,
 * on a path no decision explains, the changes that landed there most
 * recently, each a change and not a decision.
 */
export interface WhyAnswer {
  readonly basis: "decisions" | "landings";
  readonly chain: readonly WhyLink[];
}

/** A change that landed on the path, as the explanation of last resort: its intent, saying no decision is recorded there. */
const landingLink = (path: string, { change }: ChangeView): WhyLink => ({
  summary: `No decision is recorded on ${path}: ${change.id} landed it${change.landedCommit === undefined ? "" : ` as ${change.landedCommit.slice(0, 12)}`}, intending "${change.intent.goal}"`,
  record: intentRecord(change),
});

/**
 * `why`, with a path's landings when no active decision explains the path:
 * the WHY_LANDINGS changes that landed on it most recently, newest first.
 * NothingToExplain for a subject no decision explains, and for a path where
 * neither a decision nor a landing Keel indexed does.
 */
export const explainWhy: (
  project: ProjectId,
  target: WhyTarget,
) => Effect.Effect<WhyAnswer, NothingToExplain, Decisions> = Effect.fn("memory/explainWhy")(
  function* (project: ProjectId, target: WhyTarget) {
    const decided = yield* Effect.result(why(project, target));
    if (Result.isSuccess(decided)) return { basis: "decisions", chain: decided.success };
    if (target.kind !== "path") return yield* decided.failure;
    const landed = yield* (yield* Decisions).landedOn(project, target.path);
    if (landed.length === 0) return yield* decided.failure;
    return {
      basis: "landings",
      chain: landed.slice(0, WHY_LANDINGS).map((view) => landingLink(target.path, view)),
    };
  },
);
