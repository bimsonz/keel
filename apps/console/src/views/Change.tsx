import { Empty, Table, buttonVariants } from "@cloudflare/kumo";
import {
  BooksIcon,
  HandPalmIcon,
  NotePencilIcon,
  WarningOctagonIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { CodeDiff } from "../code/CodeDiff.tsx";
import type { DerivedEffect, Proposition } from "../contract/mfp.ts";
import type { ChangePageState, DiffAnnotation, PlanStep } from "../domain/state.ts";
import type { ChangeTab } from "../route.ts";
import { useWhere } from "../router.tsx";
import type { Mode } from "../theme/mode.ts";
import { Detail, Head, Split, SubTabs, Tied } from "./Detail.tsx";
import { CHANGE_TONE, CONFLICT_TONE } from "./List.tsx";
import { PlanGraph } from "./PlanGraph.tsx";
import { ConflictLink, EscalationLink, SubjectLink } from "./links.tsx";
import {
  AgentTag,
  ClassTag,
  EvidenceList,
  OutcomeWord,
  Panel,
  TierBadge,
  Unverified,
  clockTime,
  dateTime,
} from "./parts.tsx";

const RELATION_WORD: Record<string, string> = {
  is: "is",
  "at-most": "at most",
  "at-least": "at least",
  not: "is not",
  before: "before",
  after: "after",
};

function PropositionLine({ proposition }: { proposition: Proposition }) {
  return (
    <p className="text-base leading-snug text-kumo-strong">
      <span className="a-mono text-kumo-default">{proposition.subject}</span>
      <span className="mx-1.5 text-kumo-inactive">/</span>
      <span className="font-semibold">
        {proposition.predicate} {RELATION_WORD[proposition.relation] ?? proposition.relation}{" "}
        {String(proposition.value)}
      </span>
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

function ms(value: number | undefined): string {
  if (value === undefined) return "";
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

function StepOutcome({ step }: { step: PlanStep }) {
  if (step.outcome === "pass" || step.outcome === "fail" || step.outcome === "n/a") {
    return <OutcomeWord outcome={step.outcome} />;
  }
  if (step.outcome === "running" || step.outcome === "pending")
    return <OutcomeWord outcome={step.outcome} />;
  if (step.outcome === "waiting") {
    return (
      <span className="a-chip" data-tone="person">
        <HandPalmIcon size={13} weight="fill" />
        waiting for a person
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-kumo-default">
      <NotePencilIcon size={16} />
      {step.outcome === "annotate" ? "annotated" : "abstained"}
    </span>
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

/** The one line that says where the change stands. */
function standing(state: ChangePageState): string {
  const { change, verdict, escalation } = state;
  if (change.state === "landed") return "Landed on trunk";
  if (change.state === "withdrawn") return "Withdrawn";
  if (escalation?.state === "open") return `Parked: waiting for a ruling on ${escalation.label}`;
  if (state.bounce?.conflict !== undefined)
    return `Bounced on conflict ${state.bounce.conflict.label}`;
  if (state.bounce?.refused !== undefined) return "Bounced: its push was refused";
  if (verdict === undefined) return "No verdict yet";
  if (verdict.outcome === "land") return "Verified: cleared to land";
  return OUTCOME_WORD[verdict.outcome];
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
  const steps = plan.steps.length > 0 ? plan.steps.length : plan.stepCount;
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
            <AgentTag
              label={state.agent.label}
              agentClass={state.agent.class}
              harness={state.agent.harness}
            />
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
            ...(steps === undefined ? {} : { count: steps }),
          },
          // How many is not known until Keel has answered with them.
          {
            id: "files",
            label: "Files changed",
            to: { at: "change", name, tab: "files" },
            ...(diff.state === "read" ? { count: diff.files.length } : {}),
          },
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
                  {state.bounce?.conflict !== undefined ? (
                    <>
                      Keel proved{" "}
                      <ConflictLink id={state.bounce.conflict.id} className="a-link">
                        conflict {state.bounce.conflict.label}
                      </ConflictLink>{" "}
                      against this change, and its plan blocks on{" "}
                      {state.bounce.conflict.predicate ?? "that conflict's predicate"}. It bounced
                      on the conflict itself: no verdict was issued.
                    </>
                  ) : state.bounce?.refused !== undefined ? (
                    `Its batch was verified, and the push to trunk was refused: ${REFUSED[state.bounce.refused]}. Nothing landed, and no verdict was issued for the bounce.`
                  ) : verdict === undefined ? (
                    `The change is ${change.state}. Keel has not issued a verdict yet.`
                  ) : (
                    `${verdict.summary}.`
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
                {state.bounce !== undefined && state.bounce.next.length > 0 && (
                  <div className="mt-2 border-t border-kumo-line pt-3 text-base text-kumo-default">
                    <p className="text-sm text-kumo-subtle">Keel told its agent how to go on:</p>
                    <ul
                      className="mt-1 list-disc pl-5"
                      aria-label="Ways forward Keel gave its agent"
                    >
                      {state.bounce.next.map((title) => (
                        <li key={title}>{title}</li>
                      ))}
                    </ul>
                  </div>
                )}
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
                      <span className="text-sm text-kumo-subtle">
                        from commit <span className="a-mono">{change.commit}</span>
                      </span>
                    </header>
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
                    title="No decision covers this subject yet"
                    description={`${escalation === undefined ? "When a person rules on a question here" : `When ${escalation.label} is ruled`}, the decision is recorded with its date, its scope and the alternatives it rejected. Later changes meet it as precedent.`}
                  />
                ) : (
                  <ul>
                    {state.precedents.map((precedent) => (
                      <li
                        key={precedent.decisionLabel}
                        className="flex flex-col gap-0.5 px-3 py-2 text-base"
                      >
                        <span>
                          <b className="font-semibold text-kumo-strong">
                            {precedent.decisionLabel}
                          </b>{" "}
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
                {change.commit !== "" && (
                  <span>
                    commit <span className="a-mono text-kumo-strong">{change.commit}</span>
                  </span>
                )}
                {change.workspace !== "" && (
                  <span>
                    workspace <span className="a-mono text-kumo-strong">{change.workspace}</span>
                  </span>
                )}
                {change.laneLabel !== undefined && <span>{change.laneLabel}</span>}
                {change.commit === "" &&
                  change.workspace === "" &&
                  change.laneLabel === undefined && (
                    <span className="text-kumo-subtle">
                      Declared, and not yet forked into a workspace.
                    </span>
                  )}
              </Tied>
            </>
          }
        />
      )}

      {tab === "verification" && (
        <>
          {plan.spec !== undefined && (
            <Panel
              title="Verification Plan"
              aside="compiled for this change alone: each step says where it runs and why it exists"
              bodyClassName=""
            >
              <PlanGraph spec={plan.spec} steps={plan.steps} mode={mode} />
            </Panel>
          )}
          <Split
            main={
              <Panel
                title="Steps"
                aside={
                  <>
                    <span className="a-mono">{plan.hash}</span> · estimated $
                    {plan.costEstimateUsd.toFixed(3)}
                  </>
                }
                bodyClassName=""
              >
                <Table layout="fixed">
                  <colgroup>
                    <col style={{ width: "25%" }} />
                    <col style={{ width: 112 }} />
                    <col />
                    <col style={{ width: 150 }} />
                    <col style={{ width: 112 }} />
                    <col style={{ width: 124 }} />
                  </colgroup>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Step</Table.Head>
                      <Table.Head>Tier</Table.Head>
                      <Table.Head>This step exists because</Table.Head>
                      <Table.Head>Outcome</Table.Head>
                      <Table.Head>Class</Table.Head>
                      <Table.Head>Time, cost</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {plan.steps.map((step) => (
                      <Table.Row key={step.id}>
                        <Table.Cell>
                          <span className="font-medium text-kumo-strong">{step.title}</span>
                        </Table.Cell>
                        <Table.Cell>
                          <TierBadge tier={step.tier} />
                        </Table.Cell>
                        <Table.Cell>
                          <span className="text-kumo-default">{step.because}</span>
                        </Table.Cell>
                        <Table.Cell>
                          <StepOutcome step={step} />
                        </Table.Cell>
                        <Table.Cell>
                          <ClassTag evidenceClass={step.evidenceClass} />
                        </Table.Cell>
                        <Table.Cell>
                          <span className="a-num text-kumo-default">
                            {ms(step.ms)}
                            {step.usd === undefined ? "" : ` · $${step.usd.toFixed(4)}`}
                          </span>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
                {plan.steps.length === 0 && plan.stepCount === undefined && (
                  <p className="px-4 py-3 text-base text-kumo-subtle">
                    Keel has not compiled a Verification Plan for this change yet.
                  </p>
                )}
                {plan.spec === undefined && plan.stepCount !== undefined && (
                  <p className="border-t border-kumo-hairline px-4 py-3 text-base text-kumo-default">
                    Keel compiled a plan of {plan.stepCount}{" "}
                    {plan.stepCount === 1 ? "step" : "steps"} for this change. It does not publish
                    what the steps are yet, so none is listed here.
                  </p>
                )}
              </Panel>
            }
            side={
              <Panel title="Evidence behind the verdict" aside="by class" bodyClassName="p-3.5">
                {verdict === undefined ? (
                  <p className="text-base text-kumo-subtle">
                    Evidence is listed here once Keel issues a verdict.
                  </p>
                ) : (
                  <EvidenceList items={verdict.evidence} />
                )}
              </Panel>
            }
          />
        </>
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
