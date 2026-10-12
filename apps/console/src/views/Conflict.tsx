import { usePublicOnly } from "../engine/react.tsx";
import { BellIcon, HandPalmIcon, ShieldCheckIcon, WarningDiamondIcon } from "@phosphor-icons/react";
import { CodeFile } from "../code/CodeDiff.tsx";
import type { ConflictPageState, MatrixCell, Outcome, Party, Pending } from "../domain/state.ts";
import type { ConflictTab } from "../route.ts";
import { useWhere } from "../router.tsx";
import type { Mode } from "../theme/mode.ts";
import { Detail, Head, Split, SubTabs, Tied } from "./Detail.tsx";
import { CONFLICT_TONE, ConflictMark } from "./List.tsx";
import { ChangeLink, EscalationLink, SubjectLink } from "./links.tsx";
import {
  AgentTag,
  ClassTag,
  EvidenceList,
  OutcomeWord,
  Panel,
  RunMark,
  clockTime,
  dateTime,
} from "./parts.tsx";

// ─── The two propositions, on the lattice ───────────────────────────────────

const RELATION_WORD: Record<string, string> = {
  is: "is",
  "at-most": "at most",
  "at-least": "at least",
  not: "is not",
  before: "before",
  after: "after",
};

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
  const derived = proposition.origin === "derived";
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1 px-5">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-kumo-contrast text-base font-semibold text-kumo-inverse">
          {party.world}
        </span>
        <span className="text-base font-medium capitalize text-kumo-strong">
          {proposition.role}
        </span>
        {derived ? (
          <span className="a-chip" data-tone="suspected">
            derived, not declared
          </span>
        ) : (
          <span className="a-chip">declared</span>
        )}
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
      <p className="truncate text-sm text-kumo-default">“{proposition.gloss}”</p>
      <div className="flex items-center gap-3 text-sm">
        {proposition.derivation === undefined ? (
          <>
            <ClassTag evidenceClass="testimony" />
            <span className="text-kumo-subtle">the agent's own claim</span>
          </>
        ) : (
          proposition.derivation.map((step) => (
            <span key={step.method} className="inline-flex items-center gap-1.5">
              <ClassTag evidenceClass={step.evidenceClass} />
              <span className="text-kumo-default">
                {step.method === "extractor"
                  ? "extractor"
                  : step.method === "clef"
                    ? "Clef"
                    : "code model"}
                {step.p === undefined ? "" : ` p = ${step.p.toFixed(2)}`}
              </span>
            </span>
          ))
        )}
      </div>
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
        <span className="min-w-0 truncate text-sm text-kumo-subtle">“{party.goal}”</span>
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
        <span className="text-kumo-subtle">a point, derived from the diff</span>
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

function summarise(runs: (Outcome | Pending)[]): string {
  const done = runs.filter(
    (run): run is Outcome => run === "pass" || run === "fail" || run === "n/a",
  );
  const first = done[0];
  if (first === undefined) return "not run yet";
  const settled = done.every((run) => run === first);
  const count = done.length === 3 ? "three runs" : done.length === 2 ? "twice" : "once";
  const head = settled ? `${first}, ${count}` : done.join(", ");
  const running = runs.indexOf("running");
  return running === -1 ? head : `${head}. Run ${running + 1} running`;
}

function Cell({ cell, slim }: { cell: MatrixCell; slim: boolean }) {
  if (cell.kind === "none") return null;
  if (cell.kind === "tests") {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-lg">
          <OutcomeWord outcome={cell.outcome} size={20} />
        </div>
        {cell.passed !== undefined && cell.total !== undefined && (
          <span className="a-num text-base text-kumo-default">
            {cell.passed} of {cell.total} tests
          </span>
        )}
        {cell.reason !== undefined && !slim && (
          <span className="text-sm text-kumo-subtle">{cell.reason}</span>
        )}
      </div>
    );
  }
  const size = slim ? 38 : 44;
  const [first, second, third] = cell.runs;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <RunMark outcome={first} run={1} size={size} control={cell.control === true} />
        <RunMark outcome={second} run={2} size={size} control={cell.control === true} />
        <RunMark outcome={third} run={3} size={size} control={cell.control === true} />
        {slim && (
          <span className="ml-1 text-sm text-kumo-subtle">
            {summarise(cell.runs)}
            {cell.control === true && cell.runs.includes("fail") ? ", as it must" : ""}
            {cell.reason === undefined ? "" : `: ${cell.reason.toLowerCase()}`}
          </span>
        )}
      </div>
      {!slim && (
        <span className="text-sm text-kumo-default">
          <span className="font-medium text-kumo-strong">{summarise(cell.runs)}</span>
          {cell.reason === undefined ? "" : `. ${cell.reason}`}
        </span>
      )}
    </div>
  );
}

function decides(cell: MatrixCell): boolean {
  // A fail in the control world is the probe working. Only a fail elsewhere decides a conflict.
  return cell.kind === "probe" && cell.control !== true && cell.runs.includes("fail");
}

function Matrix({ state }: { state: ConflictPageState }) {
  const { matrix } = state;
  return (
    <table className="a-matrix">
      <colgroup>
        <col style={{ width: 168 }} />
        <col />
        <col />
        <col style={{ width: "34%" }} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">World</th>
          {matrix.checks.map((check) => (
            <th key={check.id} scope="col">
              {check.label}
              {check.id === "probe" && <span className="font-normal"> · three runs</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {matrix.worlds.map((world) => {
          // The baseline and the control are there to be checked, not read: two slim rows above the three that matter.
          const slim = world.id === "trunk" || world.id === "A-noop";
          const row = matrix.cells[world.id];
          return (
            <tr key={world.id} data-world={world.id} style={{ height: slim ? 58 : "28%" }}>
              <th scope="row">
                <div
                  className={
                    slim
                      ? "text-base font-medium text-kumo-default"
                      : "text-[26px] font-semibold leading-tight text-kumo-strong"
                  }
                >
                  {world.label}
                </div>
                <div className="text-sm font-normal text-kumo-subtle">
                  {world.id === "trunk"
                    ? "baseline"
                    : world.id === "A-noop"
                      ? "control"
                      : world.gloss}
                </div>
              </th>
              {matrix.checks.map((check) => {
                const cell = row[check.id];
                return (
                  <td key={check.id} data-decides={decides(cell)}>
                    <Cell cell={cell} slim={slim} />
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── The page ───────────────────────────────────────────────────────────────

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
      <span className="leading-snug text-kumo-subtle">“{party.goal}”</span>
    </span>
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
  const { conflict, probe, parties, escalation, guard, decision } = state;
  const { route } = useWhere();
  const hidden = usePublicOnly();
  const name = route.at === "conflict" ? route.name : conflict.id;
  return (
    <Detail>
      <Head
        title={
          conflict.summary === "" ? `A disagreement about ${state.subject.key}` : conflict.summary
        }
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
            <span>
              on{" "}
              <SubjectLink subject={state.subject.key} className="a-mono a-link-quiet font-medium">
                {state.subject.key}
              </SubjectLink>
            </span>
            <span>
              predicate <span className="a-mono text-kumo-default">{state.lattice.predicate}</span>
            </span>
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
            label: `Probe ${probe.label}`,
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
          <Split
            main={
              <>
                <Panel
                  title="World matrix"
                  aside="Each change alone, then both together"
                  bodyClassName="overflow-hidden rounded-b-[10px]"
                >
                  <div className="h-[520px]">
                    <Matrix state={state} />
                  </div>
                </Panel>
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
                            tab="verification"
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
                  <Side party={parties.A} />
                  <Side party={parties.B} />
                </Tied>
                <Tied title="Subject">
                  <SubjectLink subject={state.subject.key} className="a-mono a-link break-all">
                    {state.subject.key}
                  </SubjectLink>
                  {state.subject.gloss !== "" && (
                    <span className="leading-snug text-kumo-subtle">{state.subject.gloss}</span>
                  )}
                </Tied>
                {escalation === undefined && hidden && conflict.state === "escalated" && (
                  <Tied title="Escalation">
                    <span className="leading-snug text-kumo-subtle">
                      This conflict waits on a person's ruling. Keel shows the question to the
                      project's members.
                    </span>
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
                  </Tied>
                )}
                {decision !== undefined && (
                  <Tied title="Decision">
                    <span>
                      <b className="font-semibold text-kumo-strong">{decision.label}</b>{" "}
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

      {tab === "probe" && (
        <section className="a-panel overflow-hidden" aria-label={`Probe ${probe.label}`}>
          <header className="a-panel-head">
            <h2 className="a-h">Probe {probe.label}</h2>
            <ClassTag evidenceClass="opinion" />
            <span className="text-sm text-kumo-subtle">until it discriminates</span>
            <span className="ml-auto text-sm text-kumo-subtle">
              {probe.state} · attempt {probe.attempt} of 3
            </span>
          </header>
          {probe.source === "" ? (
            <p className="px-5 py-6 text-base text-kumo-subtle">
              {probe.path === ""
                ? "Keel has not drafted a probe for this conflict yet."
                : "Keel has not served this probe's source."}
            </p>
          ) : (
            <CodeFile
              path={probe.path}
              source={probe.source}
              mode={mode}
              className="a-code a-code-tight"
            />
          )}
        </section>
      )}

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
