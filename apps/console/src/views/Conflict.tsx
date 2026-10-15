import { usePublicOnly } from "../engine/react.tsx";
import {
  BellIcon,
  GavelIcon,
  HandPalmIcon,
  ShieldCheckIcon,
  WarningDiamondIcon,
} from "@phosphor-icons/react";
import { CodeFile } from "./later.tsx";
import type { ConflictPageState, MatrixRow, Outcome, Party, Pending } from "../domain/state.ts";
import type { ConflictTab } from "../route.ts";
import { useWhere } from "../router.tsx";
import type { Mode } from "../theme/mode.ts";
import { Detail, Head, Split, SubTabs, Tied } from "./Detail.tsx";
import { CONFLICT_TONE, ConflictMark } from "./List.tsx";
import { ChangeLink, DecisionLink, EscalationLink, SubjectLink } from "./links.tsx";
import type { ReactNode } from "react";
import {
  AgentTag,
  ClassTag,
  EvidenceList,
  OutcomeWord,
  Panel,
  RELATION_WORD,
  RunMark,
  clockTime,
  dateTime,
} from "./parts.tsx";

// ─── The two propositions, on the lattice ───────────────────────────────────

/** A premise is declared by the agent that holds it: Keel takes it as that agent's word. */
const PREMISE = { declared: true, evidenceClass: "testimony" } as const;

const METHOD_WORD = {
  extractor: "an extractor",
  clef: "Clef",
  "code-model": "a code model",
} as const;

function PartyCard({
  party,
  predicate,
  silentRetraction,
}: {
  party: Party;
  predicate: string;
  silentRetraction: boolean;
}) {
  const { proposition } = party;
  // A premise is its agent's own. Of an effect the page says only what Keel's suspicion said of it.
  const known = proposition.role === "premise" ? PREMISE : proposition.evidence;
  const derived = known?.declared === false;
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1 px-5" data-party={party.world}>
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-kumo-contrast text-base font-semibold text-kumo-inverse">
          {party.world}
        </span>
        <span className="text-base font-medium capitalize text-kumo-strong">
          {proposition.role}
        </span>
        {known !== undefined &&
          (derived ? (
            <span className="a-chip" data-tone="suspected">
              derived, not declared
            </span>
          ) : (
            <span className="a-chip">declared</span>
          ))}
        {derived && silentRetraction && (
          <span className="a-chip" data-tone="suspected">
            <WarningDiamondIcon size={13} weight="fill" />
            silent retraction
          </span>
        )}
      </div>
      <p className="text-[19px] font-semibold leading-snug text-kumo-strong">
        {predicate} {RELATION_WORD[proposition.relation] ?? proposition.relation}{" "}
        <span className="a-mono">{proposition.value}</span>
      </p>
      {proposition.gloss !== "" && (
        <p className="truncate text-sm text-kumo-default">“{proposition.gloss}”</p>
      )}
      {known !== undefined && (
        <div className="flex items-center gap-3 text-sm">
          <ClassTag evidenceClass={known.evidenceClass} />
          <span className="text-kumo-subtle">
            {known.declared
              ? "the agent's own claim"
              : `Keel derived it${known.method === undefined ? "" : `, by ${METHOD_WORD[known.method]}`}`}
          </span>
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2">
        {/* Which change this side is, by Keel's number for it. */}
        <span
          className="a-mono shrink-0 text-sm font-semibold text-kumo-strong"
          title={`Change ${party.label}`}
        >
          {party.label}
        </span>
        <span className="shrink-0 whitespace-nowrap">
          <AgentTag
            label={party.agent.label}
            agentClass={party.agent.class}
            harness={party.agent.harness}
          />
        </span>
        {party.goal !== "" && (
          <span className="min-w-0 truncate text-sm text-kumo-subtle">“{party.goal}”</span>
        )}
      </div>
      {party.told !== undefined && (
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-kumo-subtle">
          <BellIcon size={14} className="shrink-0" />
          <span className="truncate" title={party.told.next.join(" · ")}>
            Keel{" "}
            {party.told.how === "bounced" ? "bounced it on this conflict" : "noted this against it"}
            , and told its agent: {party.told.next.join(" · ")}
          </span>
        </p>
      )}
      {party.ruledAgainst !== undefined && (
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-kumo-subtle">
          <GavelIcon size={14} className="shrink-0" />
          <span className="truncate" title={party.ruledAgainst.next.join(" · ")}>
            The ruling went against it: Keel bounced it on{" "}
            {party.ruledAgainst.decision === undefined
              ? "the decision"
              : `decision ${party.ruledAgainst.decision}`}
            {party.ruledAgainst.next.length > 0 &&
              `, and told its agent: ${party.ruledAgainst.next.join(" · ")}`}
          </span>
        </p>
      )}
    </div>
  );
}

/** Lattice values on one axis. A premise is the range it tolerates; an effect is a point. */
function LatticeLine({ state }: { state: ConflictPageState }) {
  const { values, standing } = state.lattice;
  if (standing !== "ranked") {
    // Keel compares the two; the console draws a line only where Keel's lattice has one through both.
    return (
      <div className="mx-6 flex h-full flex-col justify-center gap-1 text-base">
        <p className="font-medium text-kumo-strong">
          {standing === "unranked"
            ? `Keel's lattice for ${state.lattice.predicate} does not rank these two values against each other.`
            : `There is no line to draw for ${state.lattice.predicate}.`}
        </p>
        <p className="text-kumo-default">
          {standing === "unranked"
            ? "Neither is above the other, so only a probe can say whether they disagree."
            : "Its values have no order Keel publishes, or Keel's lattices have not been read."}
        </p>
      </div>
    );
  }
  const at = (value: string): number => {
    const index = Math.max(0, values.indexOf(value));
    return ((index + 0.5) / values.length) * 100;
  };
  if (state.parties === undefined) return null;
  const premise = state.parties.A.proposition;
  const effect = state.parties.B.proposition;
  const rangeEnd = at(premise.value);
  const point = at(effect.value);
  const inside = point <= rangeEnd;
  return (
    <div className="relative mx-6 h-full">
      {/* A: the range it tolerates */}
      <div className="absolute flex items-center gap-2 text-sm" style={{ left: 0, top: 14 }}>
        <span className="flex h-5 w-5 items-center justify-center rounded bg-kumo-contrast text-sm font-semibold text-kumo-inverse">
          A
        </span>
        <span className="font-medium text-kumo-strong">
          relies on {RELATION_WORD[premise.relation]} {premise.value}
        </span>
        <span className="text-kumo-subtle">everything in this range is fine</span>
      </div>
      <div
        className="absolute h-2.5 rounded-sm bg-kumo-contrast"
        style={{ left: 0, width: `${rangeEnd}%`, top: 44 }}
      />
      <div
        className="absolute h-[18px] w-0.5 bg-kumo-contrast"
        style={{ left: `calc(${rangeEnd}% - 2px)`, top: 40 }}
      />

      {/* The axis */}
      <div className="absolute inset-x-0 h-px bg-kumo-interact" style={{ top: 78 }} />
      {!inside && (
        <>
          <div
            className="absolute h-0.5"
            style={{
              left: `${rangeEnd}%`,
              width: `${point - rangeEnd}%`,
              top: 77.5,
              background: "var(--a-suspected)",
            }}
          />
          <span
            className="absolute -translate-x-1/2 whitespace-nowrap text-sm font-medium"
            style={{ left: `${(rangeEnd + point) / 2}%`, top: 50, color: "var(--a-suspected-ink)" }}
          >
            outside A's range
          </span>
        </>
      )}
      {values.map((value) => (
        <div
          key={value}
          className="absolute -translate-x-1/2"
          style={{ left: `${at(value)}%`, top: 72 }}
        >
          <div className="mx-auto h-3 w-px bg-kumo-interact" />
          <div
            data-lattice-value={value}
            className={`a-mono mt-1.5 whitespace-nowrap text-base ${
              value === premise.value || value === effect.value
                ? "font-semibold text-kumo-strong"
                : "text-kumo-subtle"
            }`}
          >
            {value}
          </div>
        </div>
      ))}

      {/* B: a point */}
      <div
        className="absolute h-4 w-4 -translate-x-1/2 rounded-full border-[3px] border-kumo-base"
        style={{
          left: `${point}%`,
          top: 70,
          background: "var(--a-suspected)",
          boxShadow: "0 0 0 1.5px var(--a-suspected)",
        }}
      />
      <div
        className="absolute flex -translate-x-1/2 items-center gap-2 whitespace-nowrap text-sm"
        style={{ left: `${point}%`, top: 122 }}
      >
        <span className="flex h-5 w-5 items-center justify-center rounded bg-kumo-contrast text-sm font-semibold text-kumo-inverse">
          B
        </span>
        <span className="font-medium text-kumo-strong">makes it {effect.value}</span>
        <span className="text-kumo-subtle">a point</span>
      </div>

      <span className="absolute left-0 text-sm text-kumo-subtle" style={{ top: 122 }}>
        fresher
      </span>
      <span className="absolute right-0 text-sm text-kumo-subtle" style={{ top: 122 }}>
        staler
      </span>
    </div>
  );
}

// ─── The world matrix ───────────────────────────────────────────────────────

function summarise(runs: (Outcome | Pending)[], calibrating: boolean): string {
  const done = runs.filter(
    (run): run is Outcome => run === "pass" || run === "fail" || run === "n/a",
  );
  const first = done[0];
  if (first === undefined) return calibrating ? "not run yet" : "not run";
  const settled = done.every((run) => run === first);
  const count = done.length === 3 ? "three runs" : done.length === 2 ? "twice" : "once";
  return settled ? `${first}, ${count}` : done.join(", ");
}

/** The suites Keel ran in one world: trunk's on trunk, each side's own in its world, and both where they are composed. */
function Suites({ row, slim }: { row: MatrixRow; slim: boolean }) {
  return (
    <div className={slim ? "flex flex-wrap gap-x-6 gap-y-1" : "flex flex-col gap-3"}>
      {row.suites.map((suite) => (
        <div key={suite.check} data-check={suite.check} className="flex flex-col gap-0.5">
          <span className="text-sm text-kumo-subtle">{suite.label}</span>
          <span className="flex flex-wrap items-baseline gap-x-2 text-lg">
            <OutcomeWord outcome={suite.outcome} size={slim ? 16 : 20} />
            {suite.passed !== undefined && suite.total !== undefined && (
              <span className="a-num text-base text-kumo-default">
                {suite.passed} of {suite.total} tests
              </span>
            )}
          </span>
          {suite.reason !== undefined && (
            <span className="text-sm text-kumo-subtle">{suite.reason}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Runs({ row, slim, calibrating }: { row: MatrixRow; slim: boolean; calibrating: boolean }) {
  if (row.runs.length === 0) return null;
  const size = slim ? 38 : 44;
  const control = row.control === true;
  const words = summarise(row.runs, calibrating);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {row.runs.map((outcome, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- a run is its place in the order: run 1, 2, 3
          <RunMark key={index} outcome={outcome} run={index + 1} size={size} control={control} />
        ))}
        {slim && (
          <span className="ml-1 text-sm text-kumo-subtle">
            {words}
            {control && row.runs.includes("fail") ? ", as it must" : ""}
            {row.reason === undefined ? "" : `: ${row.reason.toLowerCase()}`}
          </span>
        )}
      </div>
      {!slim && (
        <span className="text-sm text-kumo-default">
          <span className="font-medium text-kumo-strong">{words}</span>
          {row.reason === undefined ? "" : `. ${row.reason}`}
        </span>
      )}
    </div>
  );
}

/** A fail in the control world is the probe working. Only a fail elsewhere decides a conflict. */
const decides = (row: MatrixRow): boolean => row.control !== true && row.runs.includes("fail");

function Matrix({ state }: { state: ConflictPageState }) {
  const { matrix } = state;
  return (
    <table className="a-matrix">
      <colgroup>
        <col style={{ width: 168 }} />
        <col />
        <col style={{ width: "38%" }} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">World</th>
          <th scope="col">Suites</th>
          <th scope="col">
            {matrix.probe === undefined ? "Probe" : `Probe ${matrix.probe}`}
            <span className="font-normal"> · three runs</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {matrix.rows.map((row) => {
          // The baseline and the control are there to be checked, not read: two slim rows above the three that matter.
          const slim = row.id === "trunk" || row.id === "A-noop";
          return (
            <tr key={row.id} data-world={row.id} style={{ height: slim ? 58 : "28%" }}>
              <th scope="row">
                <div
                  className={
                    slim
                      ? "text-base font-medium text-kumo-default"
                      : "text-[26px] font-semibold leading-tight text-kumo-strong"
                  }
                >
                  {row.label}
                </div>
                <div className="text-sm font-normal text-kumo-subtle">
                  {row.id === "trunk" ? "baseline" : row.id === "A-noop" ? "control" : row.gloss}
                </div>
              </th>
              <td data-cell="suites">
                <Suites row={row} slim={slim} />
              </td>
              <td data-cell="probe" data-decides={decides(row)}>
                <Runs row={row} slim={slim} calibrating={matrix.calibrating} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── The page ───────────────────────────────────────────────────────────────

const ESCALATED = {
  "human-class": "Keel asked because a conflict of this kind is a person's to judge.",
  unprovable: "Keel asked because no probe could prove it either way.",
} as const;

function Side({ party }: { party: Party }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-kumo-contrast text-[12px] font-semibold text-kumo-inverse">
          {party.world}
        </span>
        <ChangeLink id={party.changeId} className="a-mono a-link font-semibold">
          {party.label}
        </ChangeLink>
        <AgentTag
          label={party.agent.label}
          agentClass={party.agent.class}
          harness={party.agent.harness}
        />
      </span>
      {party.goal !== "" && <span className="leading-snug text-kumo-subtle">“{party.goal}”</span>}
    </span>
  );
}

const DISCARD_WORD: Record<string, string> = {
  "non-discriminating": "it gave the same answer in every world",
  unstable: "its runs in one world did not agree",
  "draft-failed": "none of its drafts could be kept",
  "run-failed": "its run ended before every world had answered",
};

const none = (words: string): ReactNode => (
  <p className="px-5 py-6 text-base text-kumo-subtle">{words}</p>
);

/** A probe's source as Keel serves it, file by file, or what Keel said in its place. */
function ProbeSource({
  probe,
  mode,
}: {
  probe: NonNullable<ConflictPageState["probe"]>;
  mode: Mode;
}): ReactNode {
  const { source } = probe;
  if (source === "unread") return none("Reading the probe's source from Keel.");
  if (source === "refused") return none("Keel did not give this probe's source.");
  if (source.length > 0)
    return source.map((file) => (
      <CodeFile
        key={file.path}
        path={file.path}
        source={file.text}
        mode={mode}
        className="a-code a-code-tight"
      />
    ));
  return none(
    probe.bundleHash === undefined
      ? "None of this probe's drafts compiled, so it has no source."
      : "Keel no longer keeps the bundle this probe's source was in.",
  );
}

export function Conflict({
  state,
  mode,
  tab,
}: {
  state: ConflictPageState;
  mode: Mode;
  tab: ConflictTab;
}) {
  const { conflict, probe, parties, escalation, guard, decision, subject } = state;
  const { route } = useWhere();
  const hidden = usePublicOnly();
  const name = route.at === "conflict" ? route.name : conflict.id;
  return (
    <Detail>
      <Head
        title={conflict.title}
        label={conflict.label}
        state={
          <span className="a-chip" data-tone={CONFLICT_TONE[conflict.state] ?? "quiet"}>
            <ConflictMark state={conflict.state} guarded={guard !== undefined} size={13} />
            {conflict.state === "escalated" ? "proven" : conflict.state}
          </span>
        }
        meta={
          <>
            <span>{conflict.kind}</span>
            {conflict.origin === "opinion" && <span>suspected by a model</span>}
            {subject !== undefined && (
              <span>
                on{" "}
                <SubjectLink subject={subject.key} className="a-mono a-link-quiet font-medium">
                  {subject.key}
                </SubjectLink>
              </span>
            )}
            {conflict.predicate !== undefined && (
              <span>
                predicate <span className="a-mono text-kumo-default">{conflict.predicate}</span>
              </span>
            )}
            <span>
              opened <time className="a-num text-kumo-default">{dateTime(conflict.openedAt)}</time>
            </span>
          </>
        }
      />
      <SubTabs
        label="Conflict"
        active={tab}
        tabs={[
          { id: "overview", label: "Overview", to: { at: "conflict", name, tab: "overview" } },
          {
            id: "probe",
            label: probe === undefined ? "Probe" : `Probe ${probe.label}`,
            to: { at: "conflict", name, tab: "probe" },
          },
          {
            id: "evidence",
            label: "Evidence",
            to: { at: "conflict", name, tab: "evidence" },
            count: state.evidence.length,
          },
        ]}
      />

      {tab === "overview" && (
        <>
          {/* Wide, the line the two sides stand on runs between them. Narrower, it runs beneath them, at its full length. */}
          {parties === undefined ? (
            // Keel suspected it without naming a premise and an effect. It drafts no probe for such a conflict,
            // and the page sets nothing against anything on its own account.
            <section className="a-panel px-5 py-4" aria-label="The two sides">
              <p className="text-base font-medium text-kumo-strong">
                Keel named no premise and no effect for this conflict.
              </p>
              <p className="text-base text-kumo-default">
                It says who is party to it, and not what each holds, so there are no two sides to
                set against each other here. Keel drafts a probe only where it has named both.
              </p>
            </section>
          ) : (
            <section
              className="a-panel grid grid-cols-2 min-[1500px]:h-[172px] min-[1500px]:grid-cols-[410px_minmax(0,1fr)_410px] min-[1500px]:divide-x min-[1500px]:divide-kumo-hairline"
              aria-label="The two sides"
            >
              <div className="grid py-4 min-[1500px]:py-0">
                <PartyCard
                  party={parties.A}
                  predicate={state.lattice.predicate}
                  silentRetraction={false}
                />
              </div>
              <div className="order-last col-span-2 h-[172px] border-t border-kumo-hairline min-[1500px]:order-none min-[1500px]:col-span-1 min-[1500px]:h-auto min-[1500px]:border-t-0">
                <LatticeLine state={state} />
              </div>
              <div className="grid border-l border-kumo-hairline py-4 min-[1500px]:border-l-0 min-[1500px]:py-0">
                <PartyCard
                  party={parties.B}
                  predicate={state.lattice.predicate}
                  silentRetraction={conflict.silentRetraction}
                />
              </div>
            </section>
          )}
          <Split
            main={
              <>
                {(parties !== undefined || probe !== undefined) && (
                  <Panel
                    title="World matrix"
                    aside="Each change alone, then both together"
                    bodyClassName="overflow-hidden rounded-b-[10px]"
                  >
                    <div className="h-[520px]">
                      <Matrix state={state} />
                    </div>
                  </Panel>
                )}
                {state.after.length > 0 && (
                  <Panel
                    title="After it was settled"
                    aside="the matrix above is the probe's record"
                    bodyClassName="p-3.5"
                  >
                    <ul className="flex flex-col gap-1.5" aria-label="What came of each side">
                      {state.after.map((side) => (
                        <li key={side.changeId} className="text-base text-kumo-default">
                          <ChangeLink
                            id={side.changeId}
                            tab="checks"
                            className="a-link font-semibold"
                          >
                            {side.label}
                          </ChangeLink>{" "}
                          {side.revision > 1
                            ? `came back as revision ${side.revision}`
                            : "was judged"}
                          : verdict <b className="font-semibold text-kumo-strong">{side.outcome}</b>
                          {side.summary !== "" && (
                            <span className="text-kumo-subtle"> · {side.summary}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Panel>
                )}
                <Panel title="What happened" aside="oldest first" bodyClassName="">
                  <ol className="a-timeline">
                    {state.timeline.map((item) => (
                      <li
                        key={item.at + item.title}
                        className="a-tl-item"
                        data-now={item.now === true}
                      >
                        <span className="a-tl-dot" />
                        <time className="a-num text-sm text-kumo-subtle" dateTime={item.at}>
                          {clockTime(item.at)}
                        </time>
                        <span className="min-w-0">
                          <span
                            className={
                              item.now === true
                                ? "font-semibold text-kumo-strong"
                                : "text-kumo-default"
                            }
                          >
                            {item.title}
                          </span>
                          {item.detail !== undefined && (
                            <span className="block text-sm leading-snug text-kumo-subtle">
                              {item.detail}
                            </span>
                          )}
                        </span>
                        <span className="a-mono text-sm text-kumo-subtle">{item.type}</span>
                      </li>
                    ))}
                  </ol>
                </Panel>
              </>
            }
            side={
              <>
                <Tied title="Changes">
                  {parties === undefined ? (
                    state.named.map((party) =>
                      party.changeId === undefined ? (
                        <span key={party.label} className="text-kumo-default">
                          {party.label}
                        </span>
                      ) : (
                        <ChangeLink
                          key={party.changeId}
                          id={party.changeId}
                          className="a-mono a-link font-semibold"
                        >
                          {party.label}
                        </ChangeLink>
                      ),
                    )
                  ) : (
                    <>
                      <Side party={parties.A} />
                      <Side party={parties.B} />
                    </>
                  )}
                </Tied>
                {subject !== undefined && (
                  <Tied title="Subject">
                    <SubjectLink subject={subject.key} className="a-mono a-link break-all">
                      {subject.key}
                    </SubjectLink>
                    {subject.gloss !== "" && subject.gloss !== subject.key && (
                      <span className="leading-snug text-kumo-subtle">{subject.gloss}</span>
                    )}
                  </Tied>
                )}
                {(conflict.proven !== undefined ||
                  conflict.dismissed !== undefined ||
                  conflict.move !== undefined) && (
                  <Tied title="Outcome">
                    {conflict.proven !== undefined && (
                      <span className="leading-snug">
                        Proven by{" "}
                        <b className="font-semibold text-kumo-strong">{conflict.proven}</b>
                      </span>
                    )}
                    {conflict.dismissed !== undefined && (
                      <span className="leading-snug">
                        Dismissed: <span className="text-kumo-strong">{conflict.dismissed}</span>
                      </span>
                    )}
                    {conflict.move !== undefined && (
                      <span className="leading-snug">
                        Resolved by the move{" "}
                        <b className="a-mono font-semibold text-kumo-strong">{conflict.move}</b>
                      </span>
                    )}
                  </Tied>
                )}
                {escalation === undefined && hidden && conflict.state === "escalated" && (
                  <Tied title="Escalation">
                    <span className="leading-snug text-kumo-subtle">
                      This conflict waits on a person's ruling. Keel shows the question to the
                      project's members.
                    </span>
                    {state.escalated !== undefined && (
                      <span className="leading-snug text-kumo-subtle">
                        {ESCALATED[state.escalated]}
                      </span>
                    )}
                  </Tied>
                )}
                {escalation !== undefined && (
                  <Tied title="Escalation">
                    <span className="flex flex-wrap items-center gap-2">
                      <EscalationLink id={escalation.id} className="a-link font-semibold">
                        {escalation.label}
                      </EscalationLink>
                      <span
                        className="a-chip"
                        data-tone={escalation.state === "open" ? "person" : "quiet"}
                      >
                        {escalation.state === "open" && <HandPalmIcon size={12} weight="fill" />}
                        {escalation.state}
                      </span>
                    </span>
                    <span className="leading-snug">{escalation.question}</span>
                    {state.escalated !== undefined && (
                      <span className="leading-snug text-kumo-subtle">
                        {ESCALATED[state.escalated]}
                      </span>
                    )}
                  </Tied>
                )}
                {decision !== undefined && (
                  <Tied title="Decision">
                    <span>
                      <DecisionLink id={decision.id} className="a-link font-semibold">
                        {decision.label}
                      </DecisionLink>{" "}
                      {decision.chosen}
                    </span>
                  </Tied>
                )}
                {guard !== undefined && (
                  <Tied title="Guard">
                    <span className="flex items-center gap-1.5">
                      <ShieldCheckIcon
                        size={15}
                        weight="fill"
                        style={{
                          color: guard.state === "admitted" ? "var(--a-pass)" : "var(--a-na-line)",
                        }}
                      />
                      <b className="font-semibold text-kumo-strong">{guard.label}</b>
                      <span className="text-kumo-subtle">
                        {guard.state === "admitted" ? "guards trunk" : "retired by a decision"}
                        {` · admitted on ${guard.runs} ${guard.runs === 1 ? "run" : "runs"}`}
                      </span>
                    </span>
                  </Tied>
                )}
                {conflict.costUsd !== undefined && (
                  <Tied title="Cost to settle">
                    <span className="a-num text-kumo-strong">${conflict.costUsd.toFixed(3)}</span>
                  </Tied>
                )}
              </>
            }
          />
        </>
      )}

      {tab === "probe" &&
        (probe === undefined ? (
          <section className="a-panel" aria-label="Probe">
            <p className="px-5 py-6 text-base text-kumo-subtle">
              Keel has not drafted a probe for this conflict.
            </p>
          </section>
        ) : (
          <section className="a-panel overflow-hidden" aria-label={`Probe ${probe.label}`}>
            <header className="a-panel-head">
              <h2 className="a-h">Probe {probe.label}</h2>
              <ClassTag evidenceClass="opinion" />
              <span className="text-sm text-kumo-subtle">until it discriminates</span>
              <span className="ml-auto text-sm text-kumo-subtle">
                {probe.state}
                {probe.attempts === undefined ? "" : ` · draft ${probe.attempts}`}
              </span>
            </header>
            {probe.discarded !== undefined && (
              <p
                className="border-b border-kumo-hairline px-5 py-3 text-base text-kumo-default"
                data-discarded={probe.discarded.reason}
              >
                Keel discarded it: <b className="font-semibold">{probe.discarded.reason}</b>
                {probe.discarded.detail === undefined ? "" : ` (${probe.discarded.detail})`}
                <span className="text-kumo-subtle">
                  {DISCARD_WORD[probe.discarded.reason] === undefined
                    ? ""
                    : `, ${DISCARD_WORD[probe.discarded.reason]}`}
                </span>
              </p>
            )}
            <ProbeSource probe={probe} mode={mode} />
          </section>
        ))}

      {tab === "evidence" && (
        <div className="max-w-[760px]">
          <Panel title="Evidence" aside="by class" bodyClassName="px-3.5 py-3">
            {state.evidence.length === 0 ? (
              <p className="text-base text-kumo-subtle">Nothing bears on this conflict yet.</p>
            ) : (
              <EvidenceList items={state.evidence} />
            )}
          </Panel>
        </div>
      )}
    </Detail>
  );
}
