import { SkeletonLine, Table, buttonVariants } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  CircleNotchIcon,
  ClockIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  HandPalmIcon,
  MinusCircleIcon,
  ScalesIcon,
  WarningOctagonIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { FilesChanged } from "./FilesChanged.tsx";
import type { ChangeSummary } from "../contract/keel/index.ts";
import type { DerivedEffect, Proposition } from "../contract/mfp.ts";
import type {
  ChangePageState,
  ChangeState,
  DiffAnnotation,
  IntentRow,
  PlanStepRow,
  RulingBounce,
  ChangeBounce,
  ShownClass,
} from "../domain/state.ts";
import {
  type Checks,
  type ChecksState,
  type StepResult,
  checksOf,
  pillOf,
  stepResultOf,
} from "../engine/checks.ts";
import { noneDerived } from "../engine/judged.ts";
import type { RulingWords } from "../engine/ruling.ts";
import { RulingActions, RulingLines } from "./Ruling.tsx";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "./pull.css";

/** A question the change waits on, in words, whether this reader may rule on it, and the way to. */
export interface ChangeRuling {
  words: RulingWords;
  answerable: boolean;
  onRule: (option: string, rationale?: string) => Promise<void>;
}
import type { ChangeTab } from "../route.ts";
import { Link, useWhere } from "../router.tsx";
import type { Mode } from "../theme/mode.ts";
import { Detail, Head, Split, SubTabs, Tied } from "./Detail.tsx";
import { DoubtSaid, doubtKey } from "./Doubt.tsx";
import { CHANGE_STATE, CHANGE_TONE } from "./List.tsx";
import {
  ChangeLink,
  ConflictLink,
  DecisionLink,
  EscalationLink,
  HolderLink,
  HeldRun,
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
  "pack-too-large": "pack too large",
  "repo-bytes-quota": "repository size quota reached",
} as const;

const OUTCOME_WORD = {
  land: "Passed",
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
          {CHANGE_STATE[row.state]}
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
      Ruled against
      {ruling.decision !== undefined &&
        ` · ${ruling.decision.label} chose “${ruling.decision.chosen}”`}
      {ruling.conflict !== undefined && (
        <>
          {" · "}
          <ConflictLink id={ruling.conflict.id} className="a-link">
            {ruling.conflict.label}
          </ConflictLink>
        </>
      )}
      {" · no verdict"}
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
      <ConflictLink id={bounce.conflict.id} className="a-link">
        {bounce.conflict.label}
      </ConflictLink>{" "}
      proven · plan blocks on {bounce.conflict.predicate ?? "its predicate"} · no verdict
    </>
  ) : bounce.refused !== undefined ? (
    `Batch passed · push to trunk refused: ${REFUSED[bounce.refused]} · no verdict`
  ) : null;
}

/** What Keel said with a bounce besides its cause: a ruling's reasons, the ways on, the decision it cites. */
function BounceSaid({ bounce }: { bounce: ChangeBounce }) {
  return (
    <>
      {bounce.ruling !== undefined && bounce.ruling.reasons.length > 0 && (
        <p className="text-base text-kumo-default" data-part="ruling-reasons">
          <span className="text-sm text-kumo-subtle">Reason: </span>
          <Said text={bounce.ruling.reasons.join(" ")} />
        </p>
      )}
      {bounce.next.length > 0 && (
        <div className="mt-2 border-t border-kumo-line pt-3 text-base text-kumo-default">
          <p className="text-sm text-kumo-subtle">Next steps for its agent:</p>
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
          Cites{" "}
          <DecisionLink id={bounce.cites.id} className="a-link font-semibold">
            {bounce.cites.label}
          </DecisionLink>
        </p>
      )}
    </>
  );
}

/** What became of a change after a bounce it moved on from. */
const AFTER_BOUNCE = {
  withdrawn: "withdrawn after",
  landed: "landed on a later try",
  "taken-on": "taken on again",
} as const;

/** A bounce the change has moved on from, as Keel recorded it: a withdrawal or another try does not undo it. */
function Bounced({
  bounce,
  failed,
}: {
  bounce: NonNullable<ChangePageState["bounced"]>;
  /** The steps that failed, by the page's names for them, where the verdict's evidence says. */
  failed: readonly string[];
}) {
  return (
    <div className="flex flex-col gap-1" data-part="past-bounce">
      <p className="text-sm text-kumo-subtle">
        <time className="a-num">{dateTime(bounce.at)}</time> · {AFTER_BOUNCE[bounce.after]}
      </p>
      <p className="text-base text-kumo-default">
        {causeNamed(bounce) ? (
          <BounceCause bounce={bounce} />
        ) : failed.length > 0 ? (
          `Failed: ${failed.join(", ")}`
        ) : bounce.verdict === undefined ? (
          "Verdict: bounce"
        ) : (
          `Verdict ${dateTime(bounce.verdict.issuedAt)}: bounce`
        )}
      </p>
      <BounceSaid bounce={bounce} />
    </div>
  );
}

/** Open, landed or closed, as a code host marks a pull request beside its title. */
const PILL = {
  open: { label: "Open", Icon: GitPullRequestIcon },
  landed: { label: "Landed", Icon: GitMergeIcon },
  closed: { label: "Closed", Icon: GitPullRequestIcon },
} as const;

export function StatePill({ state }: { state: ChangeState }) {
  const pill = pillOf(state);
  const { label, Icon } = PILL[pill];
  return (
    <span className="a-pill" data-pill={pill}>
      <Icon size={16} weight="bold" />
      {label}
    </span>
  );
}

/** Where a change stands while Keel has issued no verdict on it, in a few words and a sentence. */
const WAITING_ON: Record<ChangeState, { title: string; said: string }> = {
  declared: { title: "Not pushed", said: "No commit yet" },
  working: { title: "Not pushed", said: "Agent working · no commit yet" },
  submitted: { title: "Deriving effects", said: "Reading the pushed commit" },
  deriving: { title: "Deriving effects", said: "Reading the pushed commit" },
  drifted: { title: "Drifted", said: "Commit differs from its intent" },
  queued: { title: "Queued", said: "Waiting for a batch" },
  verifying: { title: "Checks running", said: "Verifying a candidate with this change" },
  integrating: { title: "Landing", said: "Checks passed · going onto trunk" },
  parked: { title: "Waiting for a member's ruling", said: "Parked until a person rules" },
  bounced: { title: "Bounced", said: "Returned to its agent" },
  landed: { title: "Landed on trunk", said: "" },
  withdrawn: { title: "Withdrawn", said: "Closed by its agent" },
  superseded: { title: "Superseded", said: "Replaced by another change" },
};

/** Why Keel put a change back in its queue, as it gives the reason. */
const REQUEUED: Record<NonNullable<ChangePageState["requeued"]>["reason"], string> = {
  "infra-failure": "infra failure",
  bisection: "bisecting its batch",
  invalidated: "candidate invalidated",
  "co-member-failed": "co-member failed",
  textual: "textual conflict in batch",
  interaction: "fails with a co-member",
  shrink: "fewer tests than trunk",
};

/** The title of a bounce: what it bounced on, where Keel named something other than a verdict. */
function bouncedOn(bounce: ChangeBounce | undefined): string {
  if (bounce?.ruling !== undefined)
    return bounce.ruling.decision === undefined
      ? "Bounced on a ruling"
      : `Bounced on decision ${bounce.ruling.decision.label}`;
  if (bounce?.conflict !== undefined) return `Bounced on conflict ${bounce.conflict.label}`;
  if (bounce?.refused !== undefined) return "Bounced: its push was refused";
  return "Bounced";
}

/** One row of the merge box: an icon, what it says, and at most one thing to do about it. */
function Row({
  tone,
  icon,
  title,
  action,
  children,
  lead = false,
}: {
  tone: string;
  icon: ReactNode;
  title: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  /** The row that says where the change stands: the box's own heading. */
  lead?: boolean;
}) {
  const Heading = lead ? "h2" : "h3";
  return (
    <div className="a-merge-row" data-tone={tone}>
      <span className="a-merge-icon">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Heading className="text-base font-semibold text-kumo-strong">{title}</Heading>
        {children}
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Where the change stands, and the one thing a person may do about it, where there is one. */
function Status({
  state,
  checks,
  ruling,
}: {
  state: ChangePageState;
  checks: Checks;
  ruling?: ChangeRuling;
}) {
  const { change, verdict, escalation } = state;
  if (change.state === "landed")
    return (
      <Row
        lead
        tone="landed"
        icon={<GitMergeIcon size={20} weight="bold" />}
        title="Landed on trunk"
        {...(change.landedAs === undefined
          ? {}
          : {
              action: (
                <Link
                  to={{ at: "commit", sha: change.landedAs }}
                  className={buttonVariants({ variant: "secondary" })}
                >
                  View commit
                </Link>
              ),
            })}
      >
        {change.landedAs !== undefined && (
          <p className="text-sm text-kumo-subtle">
            Commit <span className="a-mono">{change.landedAs.slice(0, 7)}</span>
          </p>
        )}
      </Row>
    );
  if (escalation !== undefined && escalation.state === "open")
    return (
      <Row
        lead
        tone="person"
        icon={<HandPalmIcon size={20} weight="fill" />}
        title={
          <>
            {ruling?.answerable === true ? "Your ruling needed" : "Waiting for a member's ruling"}
            {ruling !== undefined && (
              <span className="font-normal text-kumo-default"> · {ruling.words.title}</span>
            )}
          </>
        }
        action={
          <EscalationLink id={escalation.id} className={buttonVariants({ variant: "secondary" })}>
            Question <span className="text-kumo-subtle">{escalation.label}</span>
          </EscalationLink>
        }
      >
        {ruling === undefined ? (
          <p className="text-base text-kumo-default">{escalation.question}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <RulingLines words={ruling.words} />
            <RulingActions
              words={ruling.words}
              answerable={ruling.answerable}
              readOnly="A member of the project rules on this."
              onRule={ruling.onRule}
            />
          </div>
        )}
      </Row>
    );
  if (change.state === "bounced" || state.bounce !== undefined) {
    const failed = checks.steps
      .filter((step) => step.result === "fail")
      .map((step) => state.stepNames[step.id] ?? step.id);
    return (
      <Row
        lead
        tone="fail"
        icon={<XCircleIcon size={20} weight="fill" />}
        title={bouncedOn(state.bounce)}
      >
        <p className="text-base text-kumo-default">
          {state.bounce !== undefined && causeNamed(state.bounce) ? (
            <BounceCause bounce={state.bounce} />
          ) : failed.length > 0 ? (
            `Failed: ${failed.join(", ")}`
          ) : (
            (verdict?.said ?? WAITING_ON.bounced.said)
          )}
        </p>
        {state.bounce !== undefined && <BounceSaid bounce={state.bounce} />}
      </Row>
    );
  }
  if (change.state === "withdrawn" || change.state === "superseded")
    return (
      <Row
        lead
        tone="closed"
        icon={<MinusCircleIcon size={20} weight="bold" />}
        title={WAITING_ON[change.state].title}
      >
        <p className="text-base text-kumo-default">{WAITING_ON[change.state].said}</p>
      </Row>
    );
  if (verdict?.outcome === "land")
    return (
      <Row
        lead
        tone="pass"
        icon={<CheckCircleIcon size={20} weight="fill" />}
        title="Checks passed"
      >
        <p className="text-sm text-kumo-subtle">{WAITING_ON.integrating.said}</p>
      </Row>
    );
  const requeued = change.state === "queued" ? state.requeued : undefined;
  // A change parked because its agent's lease lapsed waits on its agent: no person is asked anything.
  const lapsed = change.state === "parked" && state.parkedOn === "lease-lapsed";
  const waiting = lapsed
    ? { title: "Waiting on its agent", said: "Lease lapsed" }
    : requeued === undefined
      ? WAITING_ON[change.state]
      : {
          title: "Requeued",
          said: `${clockTime(requeued.at)} · ${REQUEUED[requeued.reason]}${requeued.times > 1 ? ` (×${requeued.times})` : ""}`,
        };
  return (
    <Row
      lead
      tone={change.state === "parked" && !lapsed ? "person" : "quiet"}
      icon={
        change.state === "verifying" || change.state === "integrating" ? (
          <CircleNotchIcon size={20} weight="bold" className="a-spin" />
        ) : (
          <ClockIcon size={20} weight="bold" />
        )
      }
      title={verdict === undefined || lapsed ? waiting.title : OUTCOME_WORD[verdict.outcome]}
    >
      <p className="text-base text-kumo-default">
        {verdict === undefined || lapsed ? waiting.said : verdict.said}
      </p>
    </Row>
  );
}

/** A step's result as a mark, as a code host marks each check. */
function ResultMark({ result, running }: { result?: StepResult; running: boolean }) {
  if (result === "pass" || result === "annotate")
    return (
      <CheckCircleIcon
        size={16}
        weight="fill"
        style={{ color: "var(--a-pass)" }}
        aria-label="Passed"
      />
    );
  if (result === "fail")
    return (
      <XCircleIcon size={16} weight="fill" style={{ color: "var(--a-fail)" }} aria-label="Failed" />
    );
  if (result === "escalate")
    return (
      <HandPalmIcon
        size={16}
        weight="fill"
        style={{ color: "var(--a-person)" }}
        aria-label="Asks a person"
      />
    );
  if (result === "abstain")
    return <MinusCircleIcon size={16} className="text-kumo-subtle" aria-label="Skipped" />;
  return running ? (
    <CircleNotchIcon size={16} className="a-spin text-kumo-default" aria-label="Running" />
  ) : (
    <ClockIcon size={16} className="text-kumo-subtle" aria-label="Not run" />
  );
}

const CHECKS_TITLE: Record<ChecksState, string> = {
  passed: "All checks passed",
  failed: "Some checks failed",
  held: "Checks held for a person",
  running: "Checks running",
  queued: "Checks queued",
  none: "No checks yet",
};

const CHECKS_TONE: Record<ChecksState, string> = {
  passed: "pass",
  failed: "fail",
  held: "person",
  running: "quiet",
  queued: "quiet",
  none: "quiet",
};

function ChecksMark({ state }: { state: ChecksState }) {
  if (state === "passed") return <CheckCircleIcon size={20} weight="fill" />;
  if (state === "failed") return <XCircleIcon size={20} weight="fill" />;
  if (state === "held") return <HandPalmIcon size={20} weight="fill" />;
  if (state === "running") return <CircleNotchIcon size={20} weight="bold" className="a-spin" />;
  return <ClockIcon size={20} weight="bold" />;
}

/** The checks, as the merge box lists them: how many, how each went, and the way to their logs. */
function ChecksRow({
  checks,
  name,
  names,
}: {
  checks: Checks;
  name: string;
  names: Record<string, string>;
}) {
  const count = (result: StepResult): number =>
    checks.steps.filter((step) => step.result === result).length;
  const said = [
    `${checks.steps.length} ${checks.steps.length === 1 ? "check" : "checks"}`,
    ...(count("pass") + count("annotate") > 0
      ? [`${count("pass") + count("annotate")} passed`]
      : []),
    ...(count("fail") > 0 ? [`${count("fail")} failed`] : []),
    ...(count("abstain") > 0 ? [`${count("abstain")} skipped`] : []),
  ].join(" · ");
  return (
    <Row
      tone={CHECKS_TONE[checks.state]}
      icon={<ChecksMark state={checks.state} />}
      title={CHECKS_TITLE[checks.state]}
      action={
        <Link
          to={{ at: "change", name, tab: "checks" }}
          className={buttonVariants({ variant: "secondary" })}
        >
          Details
        </Link>
      }
    >
      {checks.steps.length > 0 && (
        <>
          <p className="text-sm text-kumo-subtle">{said}</p>
          <ul className="mt-1 flex flex-col gap-1" aria-label="Checks">
            {checks.steps.map((step) => (
              <li key={step.id} className="flex items-center gap-2 text-sm">
                <ResultMark
                  {...(step.result === undefined ? {} : { result: step.result })}
                  running={checks.state === "running"}
                />
                <span className="a-mono text-kumo-strong">{names[step.id] ?? step.id}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Row>
  );
}

/** The conflicts this change is in, as the merge box says whether a branch conflicts with its base. */
function ConflictsRow({ state }: { state: ChangePageState }) {
  const { conflict, change } = state;
  // Keel landed it: a conflict it was in did not hold it, and is noted beneath the landing, not drawn as one that
  // stands against it.
  if (conflict !== undefined && change.state === "landed")
    return (
      <Row
        tone="quiet"
        icon={<ScalesIcon size={20} weight="bold" />}
        title={
          <>
            Noted:{" "}
            <ConflictLink id={conflict.id} className="a-link">
              {conflict.label}
            </ConflictLink>{" "}
            with{" "}
            {conflict.others.length === 0
              ? conflict.with
              : conflict.others.map((other, index) => (
                  <span key={other.id}>
                    {index > 0 && ", "}
                    <ChangeLink id={other.id} className="a-link">
                      {other.label}
                    </ChangeLink>
                  </span>
                ))}{" "}
            · didn't hold this change
          </>
        }
      />
    );
  if (conflict !== undefined)
    return (
      <Row
        tone={conflict.state === "dismissed" || conflict.state === "resolved" ? "quiet" : "fail"}
        icon={<ScalesIcon size={20} weight="bold" />}
        title={
          conflict.state === "dismissed" || conflict.state === "resolved"
            ? `Conflict with ${conflict.with === "" ? conflict.label : conflict.with} · ${conflict.state}`
            : conflict.with === ""
              ? `Conflict ${conflict.label}`
              : `Conflicts with ${conflict.with}`
        }
        action={
          <ConflictLink id={conflict.id} className={buttonVariants({ variant: "secondary" })}>
            View conflict
          </ConflictLink>
        }
      >
        <p className="text-base text-kumo-default">
          {conflict.label}, {conflict.state === "escalated" ? "proven" : conflict.state}
          {conflict.summary === "" ? "." : `: ${conflict.summary}`}
        </p>
      </Row>
    );
  if (state.noted.length > 0)
    return (
      <Row tone="quiet" icon={<ScalesIcon size={20} weight="bold" />} title="Conflict noted">
        <p className="text-base text-kumo-default">
          {state.noted.map((note, index) => (
            <span key={note.conflict.id}>
              {index > 0 && ", "}
              <ConflictLink id={note.conflict.id} className="a-link font-semibold">
                {note.conflict.label}
              </ConflictLink>{" "}
              on {note.predicate}
            </span>
          ))}
          {" · plan does not block"}
        </p>
      </Row>
    );
  if (change.commit === "") return null;
  return (
    <Row tone="pass" icon={<CheckCircleIcon size={20} weight="fill" />} title="No conflicts" />
  );
}

/** The box a code host puts above a pull request's merge button: where it stands, its checks, its conflicts. */
function MergeBox({
  state,
  checks,
  name,
  ruling,
}: {
  state: ChangePageState;
  checks: Checks;
  name: string;
  ruling?: ChangeRuling;
}) {
  const shown = checks.state !== "none" || checks.steps.length > 0;
  return (
    <section className="a-merge" aria-label="Status">
      <Status state={state} checks={checks} {...(ruling === undefined ? {} : { ruling })} />
      {shown && <ChecksRow checks={checks} name={name} names={state.stepNames} />}
      <ConflictsRow state={state} />
      {state.bounced !== undefined && (
        <Row tone="quiet" icon={<XCircleIcon size={20} weight="bold" />} title="Bounced before">
          <Bounced
            bounce={state.bounced}
            failed={checks.steps
              .filter((step) => step.result === "fail")
              .map((step) => state.stepNames[step.id] ?? step.id)}
          />
        </Row>
      )}
    </section>
  );
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
 * The plan a verdict was issued under, as Keel's view of the verdict gives it: its steps in Keel's order, as a code
 * host lists a run's checks, each with how it went and its log, the lines of the verdict's evidence that name it.
 * A step no line names says nothing of how it went: Keel's evidence says only what it says.
 */
function PlanSteps({ steps, names }: { steps: PlanStepRow[]; names: Record<string, string> }) {
  return (
    <ol className="flex flex-col" aria-label="Checks">
      {steps.map((step) => {
        const result = stepResultOf(step.id, step.lines);
        return (
          <li
            key={step.id}
            className="flex flex-col gap-1.5 border-t border-kumo-line px-4 py-3 first:border-t-0"
            data-step={step.id}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ResultMark {...(result === undefined ? {} : { result })} running={false} />
              <span className="a-mono font-semibold text-kumo-strong [overflow-wrap:anywhere]">
                {names[step.id] ?? step.id}
              </span>
              <span className="text-sm text-kumo-subtle">
                {step.kind} · tier {step.tier}, in {TIER_WHERE[step.tier]}
              </span>
              <span className="ml-auto">
                <ClassTag evidenceClass={step.evidenceCeiling} />
              </span>
            </div>
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
              <pre className="a-log" aria-label={`Log of ${step.id}`}>
                {step.lines.join("\n")}
              </pre>
            )}
            <details className="text-sm text-kumo-subtle">
              <summary className="cursor-pointer">Why it runs</summary>
              <p className="mt-1 [overflow-wrap:anywhere]">
                {step.tierReason}. {step.because}
              </p>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

/** How many of a footprint's files a change's page lists before "Show all". */
const FOOTPRINT_SHOWN = 8;

function FootprintLine({ entry }: { entry: ChangePageState["intent"]["footprint"][number] }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="a-chip w-[58px] justify-center">{entry.op}</span>
      <span className="a-mono text-kumo-strong">{entry.path}</span>
      {entry.symbol !== undefined && (
        <span className="a-mono text-kumo-subtle">{entry.symbol}</span>
      )}
    </li>
  );
}

/** Where a change's page has rows only the log holds, while it is read: skeleton rows, labelled for a reader. */
function Loading({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2 py-1" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, row) => (
        <SkeletonLine key={row} minWidth={40} maxWidth={90} />
      ))}
    </div>
  );
}

/** Where a change stands while the log is read, from Keel's read model alone: the status box's lead row, worded as `Status` words it. */
function EarlyStatus({ summary }: { summary: ChangeSummary }) {
  const { state } = summary;
  if (state === "landed")
    return (
      <Row
        lead
        tone="landed"
        icon={<GitMergeIcon size={20} weight="bold" />}
        title={WAITING_ON.landed.title}
      />
    );
  if (state === "bounced")
    return (
      <Row
        lead
        tone="fail"
        icon={<XCircleIcon size={20} weight="fill" />}
        title={WAITING_ON.bounced.title}
      >
        <p className="text-base text-kumo-default">{WAITING_ON.bounced.said}</p>
      </Row>
    );
  if (state === "withdrawn" || state === "superseded")
    return (
      <Row
        lead
        tone="closed"
        icon={<MinusCircleIcon size={20} weight="bold" />}
        title={WAITING_ON[state].title}
      >
        <p className="text-base text-kumo-default">{WAITING_ON[state].said}</p>
      </Row>
    );
  // A change parked because its agent's lease lapsed waits on its agent: no person is asked anything.
  const lapsed = state === "parked" && summary.parkReason === "lease-lapsed";
  const asking = state === "parked" && !lapsed;
  const waiting = lapsed
    ? { title: "Waiting on its agent", said: "Lease lapsed" }
    : WAITING_ON[state];
  return (
    <Row
      lead
      tone={asking ? "person" : "quiet"}
      icon={
        state === "verifying" || state === "integrating" ? (
          <CircleNotchIcon size={20} weight="bold" className="a-spin" />
        ) : asking ? (
          <HandPalmIcon size={20} weight="fill" />
        ) : (
          <ClockIcon size={20} weight="bold" />
        )
      }
      title={waiting.title}
    >
      <p className="text-base text-kumo-default">{waiting.said}</p>
    </Row>
  );
}

/** The states in which a change has a commit pushed: before them its agent is still writing it. */
const UNPUSHED: ReadonlySet<ChangeState> = new Set(["declared", "working"]);

/**
 * A change's page while the project's log is read and has not reached the change's latest entry: its head,
 * tabs and status box from Keel's read model of the project's changes, and skeleton rows for what only the log
 * holds. The log's own page takes its place once the fold has read that far.
 */
export function EarlyChange({
  summary,
  agent,
  tab,
}: {
  summary: ChangeSummary;
  /** The agent that holds it, as its card names it. */
  agent: { readonly label: string; readonly class: ShownClass; readonly handle?: string };
  tab: ChangeTab;
}) {
  const { route } = useWhere();
  const name = route.at === "change" ? route.name : String(summary.number);
  const pill = pillOf(summary.state);
  return (
    <Detail>
      <Head
        title={summary.goal}
        label={`#${summary.number}`}
        state={
          <>
            <StatePill state={summary.state} />
            {pill === "open" && (
              <span
                className="a-chip"
                data-tone={
                  summary.parkReason === "lease-lapsed"
                    ? "quiet"
                    : (CHANGE_TONE[summary.state] ?? "quiet")
                }
              >
                {CHANGE_STATE[summary.state]}
              </span>
            )}
          </>
        }
        meta={
          <>
            <span className="flex flex-wrap items-center gap-x-1.5 text-kumo-default">
              <HolderLink
                held={agent.handle === undefined ? {} : { handle: agent.handle }}
                className="a-link-quiet font-semibold text-kumo-strong"
              >
                <AgentTag label={agent.label} agentClass={agent.class} />
              </HolderLink>
              {pill === "landed"
                ? "landed 1 commit into trunk"
                : pill === "closed"
                  ? summary.state === "withdrawn"
                    ? "withdrew this change"
                    : "had this change superseded"
                  : UNPUSHED.has(summary.state)
                    ? "wants to land a change into trunk"
                    : "wants to land 1 commit into trunk"}
            </span>
            <span>
              declared{" "}
              <time className="a-num text-kumo-default">{dateTime(summary.declaredAt)}</time>
            </span>
            {summary.revision > 1 && <span>revision {summary.revision}</span>}
          </>
        }
      />
      <SubTabs
        label="Change"
        active={tab === "alternatives" ? "overview" : tab}
        tabs={[
          { id: "overview", label: "Conversation", to: { at: "change", name, tab: "overview" } },
          { id: "checks", label: "Checks", to: { at: "change", name, tab: "checks" } },
          { id: "files", label: "Files changed", to: { at: "change", name, tab: "files" } },
        ]}
      />
      <Split
        main={
          <>
            <section className="a-merge" aria-label="Status">
              <EarlyStatus summary={summary} />
              <Row tone="quiet" icon={<ClockIcon size={20} weight="bold" />} title="Checks">
                <Loading rows={2} />
              </Row>
            </section>
            <Loading rows={4} />
          </>
        }
        side={<Loading rows={5} />}
      />
    </Detail>
  );
}

export function Change({
  state,
  mode,
  tab,
  ruling,
}: {
  state: ChangePageState;
  mode: Mode;
  tab: ChangeTab;
  /** A question the change waits on, where the page has it in words. */
  ruling?: ChangeRuling;
}) {
  const { change, intent, verdict, escalation, plan, diff } = state;
  const { route } = useWhere();
  const name = route.at === "change" ? route.name : change.id;
  const waiting = escalation?.state === "open";
  const headline = state.drift.find((item) => item.class === "silent-retraction");
  const quieter = state.drift.filter((item) => item.class !== "silent-retraction");
  const checks = checksOf(change, verdict);
  const pill = pillOf(change.state);
  const subjects = [
    ...new Set([
      ...intent.premises.map((premise) => premise.subject),
      ...state.derived.map((effect) => effect.proposition.subject),
    ]),
  ];
  const agent = (
    <HolderLink held={state.held} className="a-link-quiet font-semibold text-kumo-strong">
      <AgentTag
        label={state.agent.label}
        agentClass={state.agent.class}
        harness={state.agent.harness}
      />
    </HolderLink>
  );
  return (
    <Detail>
      <Head
        title={intent.goal}
        label={change.label}
        state={
          <>
            <StatePill state={change.state} />
            {pill === "open" && (
              <span
                className="a-chip"
                data-tone={
                  state.parkedOn === "lease-lapsed"
                    ? "quiet"
                    : (CHANGE_TONE[change.state] ?? "quiet")
                }
              >
                {waiting && <HandPalmIcon size={13} weight="fill" />}
                {CHANGE_STATE[change.state]}
              </span>
            )}
            {change.unverified && <Unverified />}
          </>
        }
        meta={
          <>
            <span className="flex flex-wrap items-center gap-x-1.5 text-kumo-default">
              {agent}
              {pill === "landed"
                ? "landed 1 commit into trunk"
                : pill === "closed"
                  ? change.state === "withdrawn"
                    ? "withdrew this change"
                    : "had this change superseded"
                  : change.commit === ""
                    ? "wants to land a change into trunk"
                    : "wants to land 1 commit into trunk"}
            </span>
            <HeldRun held={state.held} className="a-link-quiet" />
            <span>
              declared{" "}
              <time className="a-num text-kumo-default">{dateTime(change.declaredAt)}</time>
              {change.submittedAt !== undefined && (
                <>
                  , pushed{" "}
                  <time className="a-num text-kumo-default">{clockTime(change.submittedAt)}</time>
                </>
              )}
            </span>
            {change.revision > 1 && <span>revision {change.revision}</span>}
          </>
        }
      />
      <SubTabs
        label="Change"
        active={tab === "alternatives" ? "overview" : tab}
        tabs={[
          { id: "overview", label: "Conversation", to: { at: "change", name, tab: "overview" } },
          {
            id: "checks",
            label: "Checks",
            to: { at: "change", name, tab: "checks" },
            ...(plan.stepCount === undefined ? {} : { count: plan.stepCount }),
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
              <MergeBox
                state={state}
                checks={checks}
                name={name}
                {...(ruling === undefined ? {} : { ruling })}
              />

              {intent.footprint.length > 0 && (
                <Panel
                  title="Footprint"
                  aside={`${intent.footprint.length} ${intent.footprint.length === 1 ? "file" : "files"} · declared`}
                  bodyClassName="px-4 py-3"
                >
                  <ul className="flex flex-col gap-1">
                    {intent.footprint.slice(0, FOOTPRINT_SHOWN).map((entry) => (
                      <FootprintLine key={entry.path} entry={entry} />
                    ))}
                  </ul>
                  {intent.footprint.length > FOOTPRINT_SHOWN && (
                    <details className="mt-1">
                      <summary className="a-link cursor-pointer text-sm">
                        Show all {intent.footprint.length}
                      </summary>
                      <ul className="mt-1 flex flex-col gap-1">
                        {intent.footprint.slice(FOOTPRINT_SHOWN).map((entry) => (
                          <FootprintLine key={entry.path} entry={entry} />
                        ))}
                      </ul>
                    </details>
                  )}
                </Panel>
              )}

              <Panel
                title="Premises and effects"
                aside="premises declared · effects derived from the diff"
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
                    {state.session.messages.toLocaleString("en-US")} messages
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
              {state.doubts.length > 0 && (
                <Tied title="Premises in doubt">
                  {state.doubts.map((doubt) => (
                    <div key={doubtKey(doubt)} className="flex flex-col gap-0.5" data-part="doubt">
                      <PropositionLine proposition={doubt.premise} />
                      <p className="leading-snug">
                        <DoubtSaid
                          doubt={doubt}
                          by={
                            <ChangeLink id={doubt.by.id} className="a-link font-semibold">
                              {doubt.by.label}
                            </ChangeLink>
                          }
                        />
                      </p>
                    </div>
                  ))}
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
                        {CHANGE_STATE[other.state]}
                      </span>
                      <span className="min-w-0 truncate text-kumo-subtle">“{other.goal}”</span>
                    </span>
                  ))}
                  <ChangeLink id={change.id} tab="alternatives" className="a-link">
                    Compare
                  </ChangeLink>
                </Tied>
              )}
              {escalation !== undefined && (
                <Tied title="Question">
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
              {state.precedents.length > 0 && (
                <Tied title="Decisions met">
                  {state.precedents.map((precedent) => (
                    <span key={precedent.decisionLabel} className="leading-snug">
                      <DecisionLink id={precedent.decisionId} className="a-link font-semibold">
                        {precedent.decisionLabel}
                      </DecisionLink>{" "}
                      {precedent.summary}
                      {precedent.stance !== undefined && (
                        <span className="text-kumo-subtle"> · {precedent.stance}</span>
                      )}
                    </span>
                  ))}
                </Tied>
              )}
              <Tied title="Branch">
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
                  <span className="text-kumo-subtle">No workspace yet</span>
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

      {tab === "checks" && (
        <Split
          main={
            <Panel
              title={CHECKS_TITLE[checks.state]}
              aside={
                plan.stepCount === undefined ? undefined : (
                  <>
                    plan <span className="a-mono">{plan.hash.slice(0, 19)}</span> · estimated $
                    {plan.costEstimateUsd.toFixed(3)}
                  </>
                )
              }
              bodyClassName=""
            >
              {plan.stepCount === undefined ? (
                <p className="px-4 py-3 text-base text-kumo-subtle">No checks yet</p>
              ) : verdict?.plan === undefined ? (
                <p className="px-4 py-3 text-base text-kumo-default">
                  {plan.stepCount} {plan.stepCount === 1 ? "check" : "checks"} planned
                  {verdict === undefined
                    ? " · no verdict yet"
                    : " · no steps listed with the verdict"}
                </p>
              ) : (
                <>
                  {!verdict.plan.own && (
                    <p className="px-4 pt-3 text-sm text-kumo-subtle [overflow-wrap:anywhere]">
                      Batch plan <span className="a-mono">{verdict.plan.hash.slice(0, 19)}</span>
                    </p>
                  )}
                  <PlanSteps steps={verdict.plan.steps} names={state.stepNames} />
                </>
              )}
            </Panel>
          }
          side={
            <Panel
              title="Verdict"
              aside={
                verdict === undefined ? undefined : (
                  <time className="a-num">{clockTime(verdict.issuedAt)}</time>
                )
              }
              bodyClassName="flex flex-col gap-2 p-3.5"
            >
              {verdict === undefined ? (
                <p className="text-base text-kumo-subtle">None yet.</p>
              ) : (
                <>
                  <p className="text-base font-semibold text-kumo-strong">
                    {OUTCOME_WORD[verdict.outcome]}
                  </p>
                  {verdict.recorded !== undefined ? (
                    <Recorded lines={verdict.recorded} />
                  ) : verdict.evidence.length > 0 ? (
                    <EvidenceList items={verdict.evidence} />
                  ) : null}
                </>
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
          <FilesChanged
            files={diff.files}
            additions={diff.additions}
            deletions={diff.deletions}
            annotations={diff.annotations}
            mode={mode}
            renderAnnotation={renderNote}
          />
        ))}
    </Detail>
  );
}
