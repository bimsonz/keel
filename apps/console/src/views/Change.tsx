import { Empty, Table, buttonVariants } from "@cloudflare/kumo";
import { BooksIcon, HandPalmIcon, WarningOctagonIcon, XCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { CodeDiff } from "./later.tsx";
import type { DerivedEffect, Proposition } from "../contract/mfp.ts";
import type {
  ChangePageState,
  DiffAnnotation,
  IntentRow,
  PlanStepRow,
  RulingBounce,
  ChangeBounce,
} from "../domain/state.ts";
import { noneDerived, unjudged } from "../engine/judged.ts";
import type { ChangeTab } from "../route.ts";
import { Link, useWhere } from "../router.tsx";
import type { Mode } from "../theme/mode.ts";
import { Detail, Head, Split, SubTabs, Tied } from "./Detail.tsx";
import { CHANGE_TONE, CONFLICT_TONE } from "./List.tsx";
import {
  ChangeLink,
  ConflictLink,
  DecisionLink,
  EscalationLink,
  HolderLink,
  RunLink,
  Said,
  SubjectLink,
} from "./links.tsx";
import {
  AgentTag,
  ClassTag,
  EvidenceList,
  Panel,
  PropositionLine,
  RELATION_WORD,
  Unverified,
  clockTime,
  dateTime,
} from "./parts.tsx";

/** A claim in full: what makes two declared effects the same one. A bound's unit and the scope are part of it. */
function ClaimLine({ proposition }: { proposition: Proposition }) {
  return (
    <p className="text-base leading-snug text-kumo-strong">
      <span className="a-mono text-kumo-default">{proposition.subject}</span>
      <span className="mx-1.5 text-kumo-inactive">/</span>
      <span className="font-semibold">
        {proposition.predicate} {RELATION_WORD[proposition.relation] ?? proposition.relation}{" "}
        {String(proposition.value)}
        {proposition.unit !== undefined && ` ${proposition.unit}`}
      </span>
      {proposition.scope !== undefined && (
        <span className="text-kumo-subtle">, {proposition.scope}</span>
      )}
    </p>
  );
}

const METHOD_WORD: Record<DerivedEffect["method"], string> = {
  extractor: "Extractor",
  clef: "Clef",
  "code-model": "Code model",
};

function DerivedRow({ effect }: { effect: ChangePageState["derived"][number] }) {
  const contradicts = effect.against !== undefined;
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <PropositionLine proposition={effect.proposition} />
      {effect.proposition.gloss !== undefined && (
        <p className="text-sm text-kumo-default">{effect.proposition.gloss}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <ClassTag evidenceClass={effect.evidenceClass} />
        <span className="text-kumo-default">
          {METHOD_WORD[effect.method]}
          {"p" in effect && effect.p !== undefined ? `, p = ${effect.p.toFixed(2)}` : ""}
        </span>
        {!effect.declared && <span className="a-chip">not declared</span>}
        {contradicts && (
          <span className="a-chip" data-tone="proven">
            <XCircleIcon size={13} weight="fill" />
            contradicts {effect.against}
          </span>
        )}
      </div>
    </li>
  );
}

const NOTE_KIND: Record<DiffAnnotation["kind"], string> = {
  anchor: "Anchor",
  effect: "Derived effect",
  premise: "Premise",
  precedent: "Precedent",
};

function Note({ annotation }: { annotation: DiffAnnotation }) {
  return (
    <div className="a-note">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="a-chip" data-tone={annotation.kind === "effect" ? "proven" : undefined}>
          {NOTE_KIND[annotation.kind]}
        </span>
        <span className="a-mono text-kumo-default">{annotation.subjectKey}</span>
        {annotation.evidenceClass !== undefined && (
          <ClassTag evidenceClass={annotation.evidenceClass} />
        )}
      </div>
      <p className="mt-1.5 text-base font-semibold text-kumo-strong">{annotation.title}</p>
      <p className="text-kumo-default">{annotation.body}</p>
    </div>
  );
}

function renderNote(annotation: DiffAnnotation): ReactNode {
  return <Note annotation={annotation} />;
}

/** Why Artifacts would not take a push, as a clause. */
const REFUSED = {
  "pack-too-large": "this change's pack is too large to push",
  "repo-bytes-quota": "the repository is at its size quota",
} as const;

const OUTCOME_WORD = {
  land: "Land",
  bounce: "Bounced",
  park: "Parked",
  hold: "Held",
  supersede: "Superseded",
} as const;

/** One change among those with the same intent: a row of the table that sets them side by side. */
function IntentRowLine({ row, self }: { row: IntentRow; self: boolean }) {
  return (
    <Table.Row data-self={self}>
      <Table.Cell>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            {self ? (
              <b className="a-mono font-semibold text-kumo-strong">{row.label}</b>
            ) : (
              <ChangeLink id={row.id} className="a-mono a-link font-semibold">
                {row.label}
              </ChangeLink>
            )}
            {self && (
              <span className="a-chip" data-tone="quiet">
                this change
              </span>
            )}
          </span>
          <span className="truncate text-sm text-kumo-subtle">“{row.goal}”</span>
        </span>
      </Table.Cell>
      <Table.Cell>
        <AgentTag
          label={row.agent.label}
          agentClass={row.agent.class}
          harness={row.agent.harness}
        />
      </Table.Cell>
      <Table.Cell>
        <span className="a-chip" data-tone={CHANGE_TONE[row.state] ?? "quiet"}>
          {row.state}
        </span>
      </Table.Cell>
      <Table.Cell>
        {row.verdict === undefined ? (
          <span className="text-kumo-subtle">none yet</span>
        ) : (
          <>
            {OUTCOME_WORD[row.verdict.outcome]}
            <span className="text-kumo-subtle">
              , on {row.verdict.evidence} {row.verdict.evidence === 1 ? "piece" : "pieces"} of
              evidence
            </span>
          </>
        )}
      </Table.Cell>
      <Table.Cell className="a-num">{row.conflicts}</Table.Cell>
      <Table.Cell>
        <time className="a-num">{clockTime(row.declaredAt)}</time>
        <span className="text-kumo-subtle">, revision {row.revision}</span>
      </Table.Cell>
    </Table.Row>
  );
}

/**
 * What a ruling did to this change, in a sentence: the decision by Keel's name for it and what it chose, and the
 * conflict it settled, each said only where the log names it.
 */
function RuledAgainst({ ruling }: { ruling: RulingBounce }) {
  return (
    <>
      A ruling went against this change
      {ruling.decision !== undefined &&
        `: decision ${ruling.decision.label} chose “${ruling.decision.chosen}”`}
      {ruling.conflict !== undefined && (
        <>
          , on{" "}
          <ConflictLink id={ruling.conflict.id} className="a-link">
            conflict {ruling.conflict.label}
          </ConflictLink>
        </>
      )}
      . It bounced on the ruling: no verdict was issued.
    </>
  );
}

/** Whether Keel named the bounce's cause as something other than a verdict: a ruling, a conflict, a refused push. */
function causeNamed(bounce: ChangeBounce): boolean {
  return (
    bounce.ruling !== undefined || bounce.conflict !== undefined || bounce.refused !== undefined
  );
}

/** The cause Keel named for a bounce, where it is not a verdict. */
function BounceCause({ bounce }: { bounce: ChangeBounce }) {
  return bounce.ruling !== undefined ? (
    <RuledAgainst ruling={bounce.ruling} />
  ) : bounce.conflict !== undefined ? (
    <>
      Keel proved{" "}
      <ConflictLink id={bounce.conflict.id} className="a-link">
        conflict {bounce.conflict.label}
      </ConflictLink>{" "}
      against this change, and its plan blocks on{" "}
      {bounce.conflict.predicate ?? "that conflict's predicate"}. It bounced on the conflict itself:
      no verdict was issued.
    </>
  ) : bounce.refused !== undefined ? (
    `Its batch was verified, and the push to trunk was refused: ${REFUSED[bounce.refused]}. Nothing landed, and no verdict was issued for the bounce.`
  ) : null;
}

/** What Keel said with a bounce besides its cause: a ruling's reasons, the ways on, the decision it cites. */
function BounceSaid({ bounce }: { bounce: ChangeBounce }) {
  return (
    <>
      {bounce.ruling !== undefined && bounce.ruling.reasons.length > 0 && (
        <p className="text-base text-kumo-default" data-part="ruling-reasons">
          <span className="text-sm text-kumo-subtle">Keel gave this reason: </span>
          <Said text={bounce.ruling.reasons.join(" ")} />
        </p>
      )}
      {bounce.next.length > 0 && (
        <div className="mt-2 border-t border-kumo-line pt-3 text-base text-kumo-default">
          <p className="text-sm text-kumo-subtle">Keel told its agent how to go on:</p>
          <ul className="mt-1 list-disc pl-5" aria-label="Ways forward Keel gave its agent">
            {bounce.next.map((title) => (
              <li key={title}>
                <Said text={title} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {bounce.cites !== undefined && (
        // The decision is the one Keel's next action names, by its id: no sentence is read for it.
        <p className="mt-2 text-base text-kumo-default" data-part="cited-decision">
          This bounce cites{" "}
          <DecisionLink id={bounce.cites.id} className="a-link font-semibold">
            decision {bounce.cites.label}
          </DecisionLink>
          .
        </p>
      )}
    </>
  );
}

/** What became of a change after a bounce it moved on from. */
const AFTER_BOUNCE = {
  withdrawn: " and was withdrawn after.",
  landed: " and landed on a later try.",
  "taken-on": ", and has been taken on again since.",
} as const;

/** A bounce the change has moved on from, as Keel recorded it: a withdrawal or another try does not undo it. */
function Bounced({ bounce }: { bounce: NonNullable<ChangePageState["bounced"]> }) {
  return (
    <div className="mt-2 border-t border-kumo-line pt-3" data-part="past-bounce">
      <p className="text-base text-kumo-default">
        It bounced at <time className="a-num">{dateTime(bounce.at)}</time>
        {AFTER_BOUNCE[bounce.after]}{" "}
        {causeNamed(bounce) ? (
          <BounceCause bounce={bounce} />
        ) : bounce.verdict === undefined ? (
          "It bounced on the verdict above."
        ) : (
          `It bounced on a verdict issued at ${dateTime(bounce.verdict.issuedAt)}: ${bounce.verdict.said}`
        )}
      </p>
      <BounceSaid bounce={bounce} />
    </div>
  );
}

/** The one line that says where the change stands. */
function standing(state: ChangePageState): string {
  const { change, verdict, escalation } = state;
  if (change.state === "landed") return "Landed on trunk";
  if (change.state === "withdrawn") return "Withdrawn";
  if (escalation?.state === "open") return `Parked: waiting for a ruling on ${escalation.label}`;
  if (state.bounce?.ruling !== undefined)
    return state.bounce.ruling.decision === undefined
      ? "Bounced on a ruling"
      : `Bounced on decision ${state.bounce.ruling.decision.label}`;
  if (state.bounce?.conflict !== undefined)
    return `Bounced on conflict ${state.bounce.conflict.label}`;
  if (state.bounce?.refused !== undefined) return "Bounced: its push was refused";
  if (verdict === undefined) return "No verdict yet";
  if (verdict.outcome === "land") return "Verified: cleared to land";
  return OUTCOME_WORD[verdict.outcome];
}

/**
 * What a verdict's own event recorded as its evidence, as Keel wrote it. It is all there is to show where Keel
 * serves no view of the verdict, and it is listed under no class: the event names none.
 */
function Recorded({ lines }: { lines: readonly string[] }) {
  return lines.length === 0 ? (
    <p className="text-base text-kumo-subtle">Keel recorded no evidence with this verdict.</p>
  ) : (
    <ul className="flex flex-col gap-1.5" aria-label="Evidence Keel recorded with the verdict">
      {lines.map((line) => (
        <li
          key={line}
          className="rounded-lg bg-kumo-tint px-3 py-1.5 text-base leading-snug text-kumo-default [overflow-wrap:anywhere]"
        >
          {line}
        </li>
      ))}
    </ul>
  );
}

/** Where a step runs, as Keel names its tiers. */
const TIER_WHERE: Record<PlanStepRow["tier"], string> = {
  0: "the Worker",
  1: "a fresh isolate",
  2: "a container",
};

/**
 * The plan a verdict was issued under, as Keel's view of the verdict gives it: its steps in Keel's order, as a CI run
 * lists its steps. Under a step are the lines of the verdict's evidence that name it. A step no line names says
 * nothing of how it went: Keel's evidence says only what it says.
 */
function PlanSteps({ steps }: { steps: PlanStepRow[] }) {
  return (
    <ol className="flex flex-col" aria-label="The plan's steps, in Keel's order">
      {steps.map((step, index) => (
        <li
          key={step.id}
          className="flex flex-col gap-1 border-t border-kumo-line px-4 py-3 first:border-t-0"
          data-step={step.id}
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="a-num text-sm text-kumo-subtle">{index + 1}</span>
            <span className="a-mono font-semibold text-kumo-strong [overflow-wrap:anywhere]">
              {step.id}
            </span>
            <span className="text-sm text-kumo-subtle">{step.kind}</span>
            <span className="ml-auto">
              <ClassTag evidenceClass={step.evidenceCeiling} />
            </span>
          </div>
          <p className="text-sm text-kumo-default">
            Tier {step.tier}, in {TIER_WHERE[step.tier]}{" "}
            <span className="text-kumo-subtle">· {step.tierReason}</span>
          </p>
          <p className="text-sm text-kumo-subtle [overflow-wrap:anywhere]">
            <span className="text-kumo-default">Why it runs:</span> {step.because}
          </p>
          {step.guards !== undefined && (
            <p className="text-sm text-kumo-default [overflow-wrap:anywhere]">
              Guards {step.guards.predicate}, policy {step.guards.policy}
              {step.guards.decision !== undefined && (
                <>
                  , holding{" "}
                  <DecisionLink id={step.guards.decision.id} className="a-link font-semibold">
                    decision {step.decisionLabel ?? step.guards.decision.id}
                  </DecisionLink>
                  : {step.guards.decision.summary}
                </>
              )}
            </p>
          )}
          {step.lines.length > 0 && (
            <ul
              className="mt-1 flex flex-col gap-1"
              aria-label={`What the verdict says of ${step.id}`}
            >
              {step.lines.map((line) => (
                <li
                  key={line}
                  className="rounded-lg bg-kumo-tint px-3 py-1.5 text-sm leading-snug text-kumo-default [overflow-wrap:anywhere]"
                >
                  {line}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

export function Change({
  state,
  mode,
  tab,
}: {
  state: ChangePageState;
  mode: Mode;
  tab: ChangeTab;
}) {
  const { change, intent, verdict, escalation, conflict, plan, diff } = state;
  const { route } = useWhere();
  const name = route.at === "change" ? route.name : change.id;
  const waiting = escalation?.state === "open";
  const headline = state.drift.find((item) => item.class === "silent-retraction");
  const quieter = state.drift.filter((item) => item.class !== "silent-retraction");
  const subjects = [
    ...new Set([
      ...intent.premises.map((premise) => premise.subject),
      ...state.derived.map((effect) => effect.proposition.subject),
    ]),
  ];
  return (
    <Detail>
      <Head
        title={intent.goal}
        label={change.label}
        state={
          <>
            <span className="a-chip" data-tone={CHANGE_TONE[change.state] ?? "quiet"}>
              {waiting && <HandPalmIcon size={13} weight="fill" />}
              {change.state}
            </span>
            {change.unverified && <Unverified />}
          </>
        }
        meta={
          <>
            <HolderLink held={state.held} className="a-link-quiet">
              <AgentTag
                label={state.agent.label}
                agentClass={state.agent.class}
                harness={state.agent.harness}
              />
            </HolderLink>
            <RunLink held={state.held} className="a-link-quiet" />
            <span>
              declared{" "}
              <time className="a-num text-kumo-default">{dateTime(change.declaredAt)}</time>
              {change.submittedAt !== undefined && (
                <>
                  , submitted{" "}
                  <time className="a-num text-kumo-default">{clockTime(change.submittedAt)}</time>
                </>
              )}
            </span>
            <span>revision {change.revision}</span>
          </>
        }
      />
      <SubTabs
        label="Change"
        active={tab}
        tabs={[
          { id: "overview", label: "Overview", to: { at: "change", name, tab: "overview" } },
          {
            id: "verification",
            label: "Verification",
            to: { at: "change", name, tab: "verification" },
            ...(plan.stepCount === undefined ? {} : { count: plan.stepCount }),
          },
          // How many is not known until Keel has answered with them.
          {
            id: "files",
            label: "Files changed",
            to: { at: "change", name, tab: "files" },
            ...(diff.state === "read" ? { count: diff.files.length } : {}),
          },
          // A place of its own only when Keel has named some.
          ...(state.sameIntent === undefined
            ? []
            : [
                {
                  id: "alternatives" as const,
                  label: "Alternatives",
                  to: { at: "change" as const, name, tab: "alternatives" as const },
                  count: state.sameIntent.others.length,
                },
              ]),
        ]}
      />

      {tab === "overview" && (
        <Split
          main={
            <>
              <section
                className="a-verdict flex flex-col gap-1 px-5 py-4"
                data-tone={waiting ? "person" : "plain"}
                aria-label="Verdict"
              >
                <h2 className="flex items-center gap-2.5 text-2xl font-semibold leading-tight text-kumo-strong">
                  {waiting && (
                    <HandPalmIcon size={26} weight="fill" style={{ color: "var(--a-person)" }} />
                  )}
                  {standing(state)}
                </h2>
                <p className="text-lg text-kumo-default">
                  {state.bounce !== undefined && causeNamed(state.bounce) ? (
                    <BounceCause bounce={state.bounce} />
                  ) : verdict === undefined ? (
                    unjudged(change.state)
                  ) : (
                    verdict.said
                  )}
                </p>
                {verdict !== undefined && (
                  <p className="text-sm text-kumo-subtle">
                    Issued <time className="a-num">{clockTime(verdict.issuedAt)}</time>
                    {verdict.planHash !== undefined && verdict.planHash !== "" && (
                      <>
                        {" "}
                        · plan <span className="a-mono">{verdict.planHash}</span>
                      </>
                    )}
                  </p>
                )}
                {state.bounce !== undefined && <BounceSaid bounce={state.bounce} />}
                {state.bounced !== undefined && <Bounced bounce={state.bounced} />}
                {escalation !== undefined && waiting && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-kumo-line pt-3">
                    <p className="min-w-0 flex-1 text-base text-kumo-default">
                      {escalation.label} asks:{" "}
                      <b className="font-semibold text-kumo-strong">{escalation.question}</b>
                    </p>
                    <EscalationLink
                      id={escalation.id}
                      className={buttonVariants({ variant: "primary" })}
                    >
                      Answer {escalation.label}
                    </EscalationLink>
                  </div>
                )}
              </section>

              <Panel
                title="Intent"
                aside={`declared before any code, revision ${change.revision}`}
                bodyClassName="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] divide-x divide-kumo-hairline"
              >
                <div className="flex flex-col gap-1 px-4 py-3">
                  <span className="text-sm text-kumo-subtle">Goal</span>
                  <p className="text-lg font-medium text-kumo-strong">“{intent.goal}”</p>
                </div>
                <div className="flex flex-col gap-1.5 px-4 py-3">
                  <span className="text-sm text-kumo-subtle">Footprint</span>
                  <ul className="flex flex-col gap-1">
                    {intent.footprint.map((entry) => (
                      <li key={entry.path} className="flex items-center gap-2 text-sm">
                        <span className="a-chip w-[58px] justify-center">{entry.op}</span>
                        <span className="a-mono text-kumo-strong">{entry.path}</span>
                        {entry.symbol !== undefined && (
                          <span className="a-mono text-kumo-subtle">{entry.symbol}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </Panel>

              <Panel
                title="Declared and derived"
                aside="Premises are declared. Effects are derived from the diff."
                bodyClassName="flex flex-col"
              >
                {headline !== undefined && (
                  <div className="a-drift-high m-4 mb-0 flex items-start gap-3 px-4 py-3">
                    <WarningOctagonIcon
                      size={22}
                      weight="fill"
                      className="mt-0.5 shrink-0"
                      style={{ color: "var(--a-fail)" }}
                    />
                    <div>
                      <p className="text-lg font-semibold text-kumo-strong">
                        Drift: silent retraction
                      </p>
                      <p className="text-base text-kumo-default">{headline.detail}</p>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] divide-x divide-kumo-hairline">
                  <div className="flex flex-col">
                    <header className="flex items-center justify-between px-4 pb-1 pt-3.5">
                      <h3 className="text-base font-semibold text-kumo-strong">
                        Declared by {state.agent.label}
                      </h3>
                      <ClassTag evidenceClass="testimony" />
                    </header>
                    <p className="px-4 pt-1 text-sm text-kumo-subtle">
                      Premises, {intent.premises.length}
                    </p>
                    <ul>
                      {intent.premises.map((premise) => (
                        <li
                          key={premise.subject + premise.predicate}
                          className="flex flex-col gap-1 px-4 py-2"
                        >
                          <PropositionLine proposition={premise} />
                          {premise.gloss !== undefined && (
                            <p className="text-sm text-kumo-default">“{premise.gloss}”</p>
                          )}
                          <p className="text-sm text-kumo-subtle">
                            strength: {premise.strength ?? "must"}
                          </p>
                        </li>
                      ))}
                    </ul>
                    <p className="px-4 pt-2 text-sm text-kumo-subtle">
                      Effects, {intent.declaredEffects.length}
                    </p>
                    {intent.declaredEffects.length === 0 ? (
                      <p className="mx-4 mb-4 mt-1.5 rounded-lg border border-dashed border-kumo-line px-3 py-2.5 text-base text-kumo-default">
                        None declared. Declaring an effect is advisory: Keel derives them either
                        way.
                      </p>
                    ) : (
                      <ul>
                        {intent.declaredEffects.map((effect) => {
                          // A declared effect is only a claim. Whether Keel found it in the diff is said beside it.
                          const found = state.derived.some(
                            (item) =>
                              item.proposition.subject === effect.subject &&
                              item.proposition.predicate === effect.predicate,
                          );
                          return (
                            <li
                              key={effect.subject + effect.predicate}
                              className="flex flex-col gap-1 px-4 py-2"
                            >
                              <PropositionLine proposition={effect} />
                              {effect.gloss !== undefined && (
                                <p className="text-sm text-kumo-default">“{effect.gloss}”</p>
                              )}
                              <p className="text-sm text-kumo-subtle">
                                {found
                                  ? "Keel derived an effect here too."
                                  : "Declared, and not derived from the diff."}
                              </p>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                  <div className="flex flex-col">
                    <header className="flex items-center justify-between px-4 pb-1 pt-3.5">
                      <h3 className="text-base font-semibold text-kumo-strong">Derived by Keel</h3>
                      {/* Keel derives from the commit a change pushed: one that pushed none has none to name. */}
                      {change.commit !== "" && (
                        <span className="text-sm text-kumo-subtle">
                          from commit <span className="a-mono">{change.commit}</span>
                        </span>
                      )}
                    </header>
                    {state.derived.length === 0 && (
                      <p
                        className="px-4 pb-3.5 text-base text-kumo-subtle"
                        data-part="none-derived"
                      >
                        {noneDerived(change)}
                      </p>
                    )}
                    <ul className="divide-y divide-kumo-hairline">
                      {state.derived.map((effect) => (
                        <DerivedRow
                          key={
                            effect.method + effect.proposition.subject + effect.proposition.relation
                          }
                          effect={effect}
                        />
                      ))}
                    </ul>
                  </div>
                </div>
                {quieter.map((item) => (
                  <p
                    key={item.class}
                    className="border-t border-kumo-hairline px-4 py-2.5 text-sm text-kumo-default"
                  >
                    <span className="font-medium text-kumo-strong">
                      Drift, {item.severity}: {item.class.replace("-", " ")}.
                    </span>{" "}
                    {item.detail}
                  </p>
                ))}
              </Panel>

              <Panel title="Precedents" aside="decisions this change met" bodyClassName="p-2">
                {state.precedents.length === 0 ? (
                  <Empty
                    size="sm"
                    icon={<BooksIcon size={32} className="text-kumo-inactive" />}
                    title="Keel surfaced no precedent to this change"
                    description={`${escalation === undefined ? "" : `When ${escalation.label} is ruled, its decision is recorded, and later changes meet it as precedent. `}A decision Keel surfaces to this change is listed here, with its date and its scope.`}
                  />
                ) : (
                  <ul>
                    {state.precedents.map((precedent) => (
                      <li
                        key={precedent.decisionLabel}
                        className="flex flex-col gap-0.5 px-3 py-2 text-base"
                      >
                        <span>
                          <DecisionLink
                            id={precedent.decisionId}
                            className="font-semibold text-kumo-strong"
                          >
                            {precedent.decisionLabel}
                          </DecisionLink>{" "}
                          {precedent.summary}
                        </span>
                        <span className="text-sm text-kumo-subtle">
                          Decided <time className="a-num">{dateTime(precedent.decidedAt)}</time> ·
                          scope <span className="a-mono">{precedent.scope}</span> · evidence, not an
                          instruction
                          {precedent.stance !== undefined && (
                            <>
                              {" "}
                              · stance:{" "}
                              <b className="font-semibold text-kumo-strong">{precedent.stance}</b>
                            </>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </>
          }
          side={
            <>
              <Tied title="Agent">
                <AgentTag
                  label={state.agent.label}
                  agentClass={state.agent.class}
                  harness={state.agent.harness}
                />
                {state.session.messages > 0 && (
                  <span className="text-kumo-subtle">
                    Session of {state.session.messages.toLocaleString("en-US")} messages
                  </span>
                )}
              </Tied>
              {subjects.length > 0 && (
                <Tied title={subjects.length === 1 ? "Subject" : "Subjects"}>
                  {subjects.map((subject) => (
                    <SubjectLink
                      key={subject}
                      subject={subject}
                      className="a-mono a-link break-all"
                    >
                      {subject}
                    </SubjectLink>
                  ))}
                </Tied>
              )}
              {conflict !== undefined && (
                <Tied title="Conflict">
                  <span className="flex flex-wrap items-center gap-2">
                    <ConflictLink id={conflict.id} className="a-link font-semibold">
                      {conflict.label}
                    </ConflictLink>
                    <span className="a-chip" data-tone={CONFLICT_TONE[conflict.state] ?? "quiet"}>
                      {conflict.state === "escalated" ? "proven" : conflict.state}
                    </span>
                    {conflict.with !== "" && (
                      <span className="text-kumo-subtle">with {conflict.with}</span>
                    )}
                  </span>
                  {conflict.summary !== "" && (
                    <span className="leading-snug">{conflict.summary}</span>
                  )}
                </Tied>
              )}
              {state.noted.length > 0 && (
                <Tied title="Noted">
                  {state.noted.map((note) => (
                    <span key={note.conflict.id} className="flex flex-wrap items-center gap-2">
                      <ConflictLink id={note.conflict.id} className="a-link font-semibold">
                        {note.conflict.label}
                      </ConflictLink>
                      <span className="a-chip" data-tone="quiet">
                        {note.policy}
                      </span>
                      <span className="text-kumo-subtle">on {note.predicate}</span>
                    </span>
                  ))}
                  <span className="leading-snug">
                    Proven against this change, which went on: its plan does not block on{" "}
                    {state.noted.length === 1 ? "that predicate" : "those predicates"}.{" "}
                    {state.noted.some((note) => note.next.length > 0)
                      ? "Keel told its agent, and held nothing."
                      : "Nobody was told."}
                  </span>
                </Tied>
              )}
              {state.sameIntent !== undefined && (
                <Tied title="Same intent">
                  {state.sameIntent.others.map((other) => (
                    <span key={other.id} className="flex min-w-0 flex-wrap items-center gap-2">
                      <ChangeLink id={other.id} className="a-mono a-link font-semibold">
                        {other.label}
                      </ChangeLink>
                      <span className="a-chip" data-tone={CHANGE_TONE[other.state] ?? "quiet"}>
                        {other.state}
                      </span>
                      <span className="min-w-0 truncate text-kumo-subtle">“{other.goal}”</span>
                    </span>
                  ))}
                  <span className="leading-snug">
                    Declared to do the same thing as this change. Keel shows them to each other and
                    picks none.{" "}
                    <ChangeLink id={change.id} tab="alternatives" className="a-link">
                      Set them side by side
                    </ChangeLink>
                  </span>
                </Tied>
              )}
              {escalation !== undefined && (
                <Tied title="Escalation">
                  <span className="flex flex-wrap items-center gap-2">
                    <EscalationLink id={escalation.id} className="a-link font-semibold">
                      {escalation.label}
                    </EscalationLink>
                    <span className="a-chip" data-tone={waiting ? "person" : "quiet"}>
                      {waiting && <HandPalmIcon size={12} weight="fill" />}
                      {escalation.state}
                    </span>
                  </span>
                  <span className="leading-snug">{escalation.question}</span>
                  {escalation.ruling !== undefined && (
                    <span className="leading-snug">
                      Ruled: <b className="font-semibold text-kumo-strong">{escalation.ruling}</b>
                    </span>
                  )}
                </Tied>
              )}
              <Tied title="Where it is">
                {/* A change lands as a commit of Keel's on trunk, which is not the one its workspace pushed. */}
                {change.landedAs !== undefined && (
                  <span data-part="landed-as">
                    landed on trunk as commit{" "}
                    <Link to={{ at: "commit", sha: change.landedAs }} className="a-mono a-link">
                      {change.landedAs.slice(0, 7)}
                    </Link>
                  </span>
                )}
                {/* Keel previews a candidate on the project's own Cloudflare account, and tells the change where. */}
                {change.preview !== undefined && (
                  <span data-part="preview">
                    previewed at{" "}
                    {/* An address Keel wrote is linked only where it is a web page's, and only while it answers. */}
                    {change.preview.down || !change.preview.url.startsWith("https://") ? (
                      <span className="a-mono">{change.preview.url}</span>
                    ) : (
                      <a href={change.preview.url} className="a-mono a-link" rel="noreferrer">
                        {change.preview.url}
                      </a>
                    )}
                    {change.preview.down && ", taken down since"}
                  </span>
                )}
                {change.commit !== "" && (
                  <span>
                    {/* Beside the commit it landed as, the change's own is said to be the one it pushed. */}
                    {change.landedAs === undefined ? "commit" : "pushed as commit"}{" "}
                    <span className="a-mono text-kumo-strong">{change.commit}</span>
                  </span>
                )}
                {change.workspace !== "" && (
                  <span>
                    workspace <span className="a-mono text-kumo-strong">{change.workspace}</span>
                  </span>
                )}
                {change.lane !== undefined && (
                  <span data-part="lane">
                    lane <span className="a-mono text-kumo-strong">{change.lane}</span>
                  </span>
                )}
                {change.commit === "" && change.workspace === "" && change.lane === undefined && (
                  <span className="text-kumo-subtle">
                    Declared, and not yet forked into a workspace.
                  </span>
                )}
              </Tied>
            </>
          }
        />
      )}

      {tab === "alternatives" &&
        (state.sameIntent === undefined ? (
          <Panel title="Alternatives">
            <p className="text-base text-kumo-default">
              Keel has named no other change with this one's intent.
            </p>
          </Panel>
        ) : (
          <>
            <Panel
              title="The same intent"
              aside="in the order Keel named them, never ranked"
              bodyClassName=""
            >
              <div className="flex flex-col gap-2 border-b border-kumo-line px-4 py-3.5">
                <p className="text-base text-kumo-default">
                  Each of these changes declared the same{" "}
                  {intent.declaredEffects.length === 1 ? "effect" : "effects"}, so Keel shows them
                  to each other. It does not rank them and does not pick one: each is verified on
                  its own.
                </p>
                <ul aria-label="What each of them declares" className="flex flex-col gap-1">
                  {intent.declaredEffects.map((effect) => (
                    <li key={effect.subject + effect.predicate + String(effect.value)}>
                      <ClaimLine proposition={effect} />
                    </li>
                  ))}
                </ul>
              </div>
              <Table layout="fixed" aria-label="This change and its alternatives">
                <colgroup>
                  <col />
                  <col style={{ width: 190 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 250 }} />
                  <col style={{ width: 96 }} />
                  <col style={{ width: 190 }} />
                </colgroup>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Change</Table.Head>
                    <Table.Head>Agent</Table.Head>
                    <Table.Head>State</Table.Head>
                    <Table.Head>Verdict</Table.Head>
                    <Table.Head>Conflicts</Table.Head>
                    <Table.Head>Declared</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  <IntentRowLine row={state.sameIntent.self} self />
                  {state.sameIntent.others.map((other) => (
                    <IntentRowLine key={other.id} row={other} self={false} />
                  ))}
                </Table.Body>
              </Table>
            </Panel>
            {state.sameIntent.others.some((other) => other.next.length > 0) && (
              <Panel title="What Keel told this change's agent" aside="in Keel's words">
                <ul className="flex flex-col gap-3" aria-label="What Keel told this change's agent">
                  {state.sameIntent.others
                    .filter((other) => other.next.length > 0)
                    .map((other) => (
                      <li key={other.id} className="flex flex-col gap-1 text-base">
                        <p className="text-kumo-strong">
                          <ChangeLink id={other.id} className="a-mono a-link font-semibold">
                            {other.label}
                          </ChangeLink>{" "}
                          {other.landed === undefined
                            ? "was declared with the same intent."
                            : "has the same intent, and landed."}
                        </p>
                        <ul className="list-disc pl-5 text-kumo-default">
                          {other.next.map((title) => (
                            <li key={title}>
                              <Said text={title} />
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                </ul>
              </Panel>
            )}
          </>
        ))}

      {tab === "verification" && (
        <Split
          main={
            <Panel
              title="Verification Plan"
              aside={
                <>
                  <span className="a-mono">{plan.hash}</span> · estimated $
                  {plan.costEstimateUsd.toFixed(3)}
                </>
              }
              bodyClassName=""
            >
              {plan.stepCount === undefined ? (
                <p className="px-4 py-3 text-base text-kumo-subtle">
                  Keel has not compiled a Verification Plan for this change yet.
                </p>
              ) : verdict?.plan === undefined ? (
                <p className="px-4 py-3 text-base text-kumo-default">
                  Keel compiled a plan of {plan.stepCount} {plan.stepCount === 1 ? "step" : "steps"}{" "}
                  for this change. Keel lists a plan&apos;s steps with a verdict issued under it
                  {verdict === undefined
                    ? ", and has issued none yet"
                    : ", and has listed none for this one"}
                  .
                </p>
              ) : (
                <>
                  {!verdict.plan.own && (
                    <p className="px-4 pt-3 text-base text-kumo-default [overflow-wrap:anywhere]">
                      Keel issued the verdict under its batch&apos;s plan,{" "}
                      <span className="a-mono">{verdict.plan.hash}</span>, not the one it compiled
                      for this change.
                    </p>
                  )}
                  <PlanSteps steps={verdict.plan.steps} />
                </>
              )}
            </Panel>
          }
          side={
            <Panel
              title="Evidence behind the verdict"
              aside={verdict?.recorded === undefined ? "by class" : "as Keel recorded it"}
              bodyClassName="p-3.5"
            >
              {verdict === undefined ? (
                <p className="text-base text-kumo-subtle">
                  Evidence is listed here once Keel issues a verdict.
                </p>
              ) : verdict.recorded === undefined &&
                verdict.plan !== undefined &&
                verdict.evidence.length === 0 ? (
                <p className="text-base text-kumo-subtle">
                  Each line of the verdict&apos;s evidence names a step of its plan, and is listed
                  under that step.
                </p>
              ) : verdict.recorded === undefined ? (
                <EvidenceList items={verdict.evidence} />
              ) : (
                <Recorded lines={verdict.recorded} />
              )}
            </Panel>
          }
        />
      )}

      {tab === "files" &&
        (diff.files.length === 0 ? (
          <p className="a-panel px-5 py-6 text-base text-kumo-subtle">
            {change.commit === ""
              ? "The change has not submitted a commit yet, so there is no diff to read."
              : diff.state === "reading"
                ? "Reading this change's diff from Keel."
                : diff.state === "refused"
                  ? "Keel does not serve this change's diff. Nothing is shown in its place."
                  : "This change's commit alters no file Keel can show."}
            {/* What landed is a commit on trunk, and Keel serves that: the way to it is offered. */}
            {change.commit !== "" && diff.state === "refused" && change.landedAs !== undefined && (
              <>
                {" "}
                It landed on trunk as commit{" "}
                <span className="a-mono text-kumo-strong">{change.landedAs.slice(0, 7)}</span>.{" "}
                <Link to={{ at: "commit", sha: change.landedAs }} className="a-link">
                  See what that commit changed
                </Link>
              </>
            )}
          </p>
        ) : (
          <>
            <p className="a-num text-sm text-kumo-subtle">
              {diff.files.length} {diff.files.length === 1 ? "file" : "files"} ·{" "}
              <span style={{ color: "var(--a-pass-ink)" }}>+{diff.additions}</span>{" "}
              <span style={{ color: "var(--a-fail-ink)" }}>−{diff.deletions}</span> · notes are
              pinned to the lines they are about
            </p>
            {diff.files.map((file) => (
              <section key={file.path} className="a-panel overflow-hidden" aria-label={file.path}>
                <CodeDiff
                  file={file}
                  annotations={diff.annotations}
                  mode={mode}
                  renderAnnotation={renderNote}
                  className="a-code"
                />
              </section>
            ))}
          </>
        ))}
    </Detail>
  );
}
