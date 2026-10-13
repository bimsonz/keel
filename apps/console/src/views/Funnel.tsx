// The review funnel. First the changes: how many Keel's events took as far as
// each stage, and what became of the ones that got no further. Then the
// conflicts Keel found on the way: what a probe settled and what went to a
// person, the last stage and the rarest. Both are counted from Keel's events.
//
// Under them, where a source reports it and nowhere else: every submitted
// change could be compared with every premise any other change holds, and the
// counters show how few comparisons are ever made and which stage settled each.

import { usePublicOnly } from "../engine/react.tsx";
import { ArrowDownIcon, HandPalmIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { EvidenceClass } from "../contract/mfp.ts";
import type { FunnelStage } from "../contract/observations.ts";
import type { ChangeRow, ChangeStage, FunnelRow, FunnelState } from "../engine/funnel.ts";
import { PAGE } from "../engine/lists.ts";
import { Link } from "../router.tsx";
import { ClassTag } from "./parts.tsx";

const STAGES: Record<FunnelStage, { name: string; does: string; evidence?: EvidenceClass }> = {
  0: {
    name: "Subject index",
    does: "Looks up the premises on what the change alters. Nothing else is ever compared.",
  },
  1: {
    name: "Lattice",
    does: "Compares each derived effect with each premise, in code.",
    evidence: "ruling",
  },
  2: {
    name: "Clef",
    does: "Where no extractor applies, derives the effect. It settles what its asks agree is compatible, and passes on the rest.",
    evidence: "opinion",
  },
  3: {
    name: "Code model",
    does: "Drafts a probe for what is still contested. It settles nothing.",
    evidence: "opinion",
  },
  4: {
    name: "Probe",
    does: "Runs three times in every world: trunk, each change alone, both together.",
    evidence: "proof",
  },
  5: {
    name: "A person",
    does: "Rules on what is a matter of judgement. The answer becomes a decision.",
    evidence: "ruling",
  },
};

/** A change's stages, in Keel's own words for them. */
const CHANGE: Record<ChangeStage, { name: string; does: string }> = {
  declared: {
    name: "Declared",
    does: "An agent tells Keel what it means to change, and what it relies on.",
  },
  precheck: {
    name: "Precheck",
    does: "Keel derives what the submitted commit does, and compiles the plan that will verify it.",
  },
  verified: {
    name: "Verified",
    does: "Keel runs the plan on the change's batch, and its verdict is to land it.",
  },
  landed: { name: "Landed", does: "On trunk. Only Keel writes there." },
};

/** What Keel said of a change that is out of the flow, in the order the page lists them. */
const LEFT: readonly [keyof ChangeRow["out"], string][] = [
  ["verdict", "bounced on a verdict"],
  ["conflict", "bounced on a proven conflict"],
  ["declined", "bounced on a refused push"],
  ["drifted", "drifted from what it declared"],
  ["withdrawn", "withdrawn"],
  ["superseded", "superseded"],
];

const count = (value: number): string => value.toLocaleString("en-US");
const plural = (n: number, one: string, many: string): string =>
  `${count(n)} ${n === 1 ? one : many}`;

/** Dollars to two significant figures: $0.067, $0.00028. Below a thousandth of a cent it only says so. */
function dollars(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.00001) return "under $0.00001";
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(Math.max(2, Math.ceil(-Math.log10(value)) + 1))}`;
}

/** A share as a percentage that never rounds a remainder away: 99.96%, not 100%. */
function share(part: number, whole: number): string {
  if (whole === 0) return "";
  const percent = (part / whole) * 100;
  if (part === whole || part === 0) return `${percent}%`;
  return `${percent.toFixed(percent > 99.9 || percent < 0.1 ? 2 : 1)}%`;
}

function Tile({
  label,
  value,
  children,
  waiting = false,
}: {
  label: string;
  value: ReactNode;
  children: ReactNode;
  waiting?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-6 py-5">
      <dt className="text-sm text-kumo-subtle">{label}</dt>
      <dd className="flex items-center gap-2.5 text-[34px] font-semibold leading-none text-kumo-strong">
        {value}
        {waiting && (
          <HandPalmIcon
            size={24}
            weight="fill"
            style={{ color: "var(--a-person)" }}
            aria-label="A person is being asked"
          />
        )}
      </dd>
      <dd className="text-sm leading-snug text-kumo-default">{children}</dd>
    </div>
  );
}

const NOT_COUNTED = (
  <span className="font-normal text-kumo-subtle" title="Keel does not count this stage yet">
    —
  </span>
);

const NO_COST = (
  <span className="font-normal text-kumo-subtle" title="Keel records no cost yet">
    —
  </span>
);

type Part = { part: "settled" | "open" | "passed"; n: number; title: string };

/** What reached a stage, as one bar, each part as wide as its share. */
function Bar({ parts, person = false }: { parts: readonly Part[]; person?: boolean }) {
  if (parts.every((entry) => entry.n === 0))
    return <div className="a-funnel-bar" data-empty="nothing" />;
  return (
    <div className="a-funnel-bar">
      <span className="sr-only">
        {parts.flatMap((entry) => (entry.n > 0 ? [entry.title] : [])).join(", ")}
      </span>
      {parts.map(
        (entry) =>
          entry.n > 0 && (
            <i
              key={entry.part}
              data-part={entry.part}
              data-person={person ? "" : undefined}
              style={{ flexGrow: entry.n }}
              title={entry.title}
            />
          ),
      )}
    </div>
  );
}

/** What reached the level, as one bar: settled here, passed on, and still open. */
function Split({ row }: { row: FunnelRow }) {
  if (!row.reported) return <div className="a-funnel-bar" data-empty="unreported" />;
  return (
    <Bar
      person={row.stage === 5}
      parts={[
        { part: "settled", n: row.settled, title: `${count(row.settled)} settled here` },
        {
          part: "open",
          n: row.open,
          title:
            row.stage === 5
              ? `${count(row.open)} waiting for a person`
              : `${count(row.open)} still here`,
        },
        { part: "passed", n: row.passedOn, title: `${count(row.passedOn)} passed on` },
      ]}
    />
  );
}

/**
 * One stage of the changes' funnel: how many Keel's events took this far, what became of the ones that got no
 * further, and how many went on. `estimate` is Keel's own, of the plans it compiled, and is worded as one.
 */
function ChangeStageRow({
  row,
  unverified,
  estimate,
}: {
  row: ChangeRow;
  unverified: number;
  estimate?: FunnelState["estimate"];
}) {
  const stage = CHANGE[row.stage];
  const last = row.stage === "landed";
  const causes = LEFT.flatMap(([cause, words]) =>
    row.out[cause] > 0 ? [{ n: row.out[cause], words }] : [],
  );
  const left = causes.reduce((sum, entry) => sum + entry.n, 0);
  const told = [
    ...causes.map((entry) => `${count(entry.n)} ${entry.words}`),
    ...(row.here > 0
      ? [
          `${count(row.here)} still here${row.parked > 0 ? `, ${count(row.parked)} of them parked` : ""}`,
        ]
      : []),
  ];
  return (
    <tr data-stage={row.stage}>
      <th scope="row">
        <span className="text-lg font-semibold text-kumo-strong">{stage.name}</span>
        <p className="mt-1 text-sm font-normal leading-snug text-kumo-default">{stage.does}</p>
      </th>
      <td className="a-num text-right text-[28px] font-semibold leading-none text-kumo-strong">
        {count(row.reached)}
      </td>
      <td>
        {last ? (
          <p className="text-sm text-kumo-subtle">
            {unverified > 0 &&
              `${count(unverified)} without verification, which is off for this project`}
          </p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="a-num text-lg font-semibold text-kumo-strong">{count(left)}</span>
              <span className="a-num text-sm text-kumo-subtle">{share(left, row.reached)}</span>
            </div>
            <Bar
              parts={[
                { part: "settled", n: left, title: `${count(left)} left here` },
                { part: "open", n: row.here, title: `${count(row.here)} still here` },
                { part: "passed", n: row.wentOn, title: `${count(row.wentOn)} went on` },
              ]}
            />
            <p className="mt-1.5 min-h-5 text-sm text-kumo-subtle">{told.join(" · ")}</p>
          </>
        )}
      </td>
      <td className="a-num text-right text-lg text-kumo-default">
        {!last && (
          <span className="inline-flex items-center gap-1.5">
            {count(row.wentOn)}
            <ArrowDownIcon size={15} className="text-kumo-subtle" aria-hidden />
          </span>
        )}
      </td>
      <td className="a-num text-right text-lg text-kumo-default">
        {row.stage === "verified" && estimate !== undefined ? (
          <>
            <span className="block text-sm text-kumo-subtle">Keel's estimate</span>
            {dollars(estimate.usd)}
            <span className="block text-sm text-kumo-subtle">
              for {plural(estimate.plans, "plan", "plans")}, before any ran
            </span>
          </>
        ) : (
          NO_COST
        )}
      </td>
    </tr>
  );
}

/** One of the page's three tables, under its own heading. */
function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="a-panel overflow-hidden" aria-label={title}>
      <header className="flex items-baseline justify-between gap-4 border-b border-kumo-hairline px-6 py-3">
        <h2 className="text-base font-semibold text-kumo-strong">{title}</h2>
        <span className="text-sm text-kumo-subtle">{note}</span>
      </header>
      {children}
    </section>
  );
}

/** `numbered` for the comparison counters, which Keel numbers cheapest first. A conflict's two stages go by name. */
function Stage({ row, numbered }: { row: FunnelRow; numbered: boolean }) {
  const stage = STAGES[row.stage];
  const person = row.stage === 5;
  return (
    <tr data-waiting={person && row.open > 0 ? "" : undefined}>
      <th scope="row">
        <div className="flex items-baseline gap-3">
          {numbered && (
            <span className="w-[62px] shrink-0 text-sm font-normal text-kumo-subtle">
              Stage {row.stage}
            </span>
          )}
          <span className="text-lg font-semibold text-kumo-strong">{stage.name}</span>
          {stage.evidence !== undefined && <ClassTag evidenceClass={stage.evidence} />}
        </div>
        <p
          className={`mt-1 text-sm font-normal leading-snug text-kumo-default ${numbered ? "pl-[74px]" : ""}`}
        >
          {stage.does}
        </p>
      </th>
      <td className="a-num text-right text-[28px] font-semibold leading-none text-kumo-strong">
        {row.reported ? count(row.reached) : NOT_COUNTED}
      </td>
      <td>
        <div className="flex items-baseline justify-between gap-3">
          <span className="a-num text-lg font-semibold text-kumo-strong">
            {row.reported ? count(row.settled) : NOT_COUNTED}
          </span>
          <span className="a-num text-sm text-kumo-subtle">
            {row.reported
              ? share(row.settled, row.reached)
              : person
                ? "shown to members"
                : "not counted yet"}
          </span>
        </div>
        <Split row={row} />
        <p className="mt-1.5 min-h-5 text-sm text-kumo-subtle">
          {row.dismissed !== undefined &&
            row.settled > 0 &&
            `${count(row.dismissed)} dismissed as false alarms · ${count(row.proven ?? 0)} proven`}
          {row.open > 0 &&
            !person &&
            `${row.settled > 0 && row.dismissed !== undefined ? " · " : ""}${count(row.open)} still here`}
          {row.open > 0 && person && (
            <span
              className="inline-flex items-center gap-1.5 font-medium"
              style={{ color: "var(--a-person-ink)" }}
            >
              <HandPalmIcon size={14} weight="fill" />
              {count(row.open)} waiting for a person
              <Link
                to={{ at: "escalations", filter: "open", shown: PAGE }}
                className="a-link font-normal"
              >
                Open the escalations
              </Link>
            </span>
          )}
        </p>
      </td>
      <td className="a-num text-right text-lg text-kumo-default">
        {person ? (
          ""
        ) : row.reported ? (
          <span className="inline-flex items-center gap-1.5">
            {count(row.passedOn)}
            <ArrowDownIcon size={15} className="text-kumo-subtle" aria-hidden />
          </span>
        ) : (
          NOT_COUNTED
        )}
      </td>
      <td className="a-num text-right text-lg text-kumo-default">
        {person ? (
          <span className="text-sm text-kumo-subtle">a person's time</span>
        ) : row.usd === undefined ? (
          row.reported ? (
            NO_COST
          ) : (
            NOT_COUNTED
          )
        ) : (
          dollars(row.usd)
        )}
      </td>
    </tr>
  );
}

/** The columns of the conflicts' and the comparisons' tables, which are the same. */
function Settled() {
  return (
    <thead>
      <tr>
        <th scope="col">Stage</th>
        <th scope="col" className="text-right">
          Reached
        </th>
        <th scope="col">
          <span className="flex items-center justify-between gap-3">
            Settled here
            <span className="a-funnel-key">
              <i data-part="settled" /> settled <i data-part="open" /> still here{" "}
              <i data-part="passed" /> passed on
            </span>
          </span>
        </th>
        <th scope="col" className="text-right">
          Passed on
        </th>
        <th scope="col" className="text-right">
          Cost
        </th>
      </tr>
    </thead>
  );
}

export function Funnel({ state }: { state: FunnelState }) {
  // A reader who is not shown the questions put to a person is given no count of them.
  const hidden = usePublicOnly();
  const counted = state.rows.some((row) => row.reported && row.stage === 0);
  const { changes, estimate } = state;
  const bounces = changes.bounces.verdict + changes.bounces.conflict + changes.bounces.declined;
  const perThousand =
    state.usd === undefined || state.changesLanded === 0
      ? undefined
      : (state.usd / state.changesLanded) * 1000;
  return (
    <div className="a-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1480px] flex-col gap-5 px-6 py-5">
        <header className="flex items-baseline justify-between gap-6">
          <div>
            <h1 className="text-[22px] font-semibold text-kumo-strong">Review funnel</h1>
            <p className="mt-0.5 text-base text-kumo-default">
              Models translate, lattices compare, probes prove, people decide.
            </p>
          </div>
          <span className="text-sm text-kumo-subtle">Counted from Keel's events</span>
        </header>

        <dl className="a-panel grid grid-cols-2 divide-x divide-kumo-hairline xl:grid-cols-4">
          <Tile label="Changes landed" value={count(changes.landed)}>
            of {count(changes.declared)} declared
            {changes.landedUnverified > 0 &&
              ` · ${count(changes.landedUnverified)} without verification`}
          </Tile>
          <Tile label="Changes bounced" value={count(changes.bounced)}>
            {changes.bounced === 0
              ? "Keel has bounced no change."
              : `${plural(bounces, "bounce", "bounces")} in all · ${count(changes.bouncedThenLanded)} of those changes landed since`}
          </Tile>
          <Tile
            label="Cost of review"
            value={state.usd === undefined ? NO_COST : dollars(state.usd)}
          >
            {state.usd === undefined
              ? `Keel records no cost yet.${
                  estimate === undefined
                    ? ""
                    : ` Its own estimate for the ${plural(estimate.plans, "plan", "plans")} it compiled is ${dollars(estimate.usd)}.`
                }`
              : perThousand === undefined
                ? "Nothing has landed yet."
                : `${dollars(perThousand)} per thousand changes landed${counted ? "" : ", probes only"}`}
          </Tile>
          <Tile
            label="People asked"
            value={hidden ? NOT_COUNTED : count(state.peopleAsked)}
            waiting={state.peopleWaiting > 0}
          >
            {hidden
              ? "Keel shows a project's questions to its members"
              : `of ${count(state.changesLanded)} ${state.changesLanded === 1 ? "change" : "changes"} landed`}
            {state.medianAnswerMs !== undefined &&
              state.medianAnswerMs > 0 &&
              ` · answered in ${Math.round(state.medianAnswerMs / 1000)} s`}
          </Tile>
        </dl>

        <Section title="Changes" note="each counted once at a stage, however often it came back">
          <div className="overflow-x-auto">
            <table className="a-funnel" data-funnel="changes">
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col" className="text-right">
                    Reached
                  </th>
                  <th scope="col">
                    <span className="flex items-center justify-between gap-3">
                      Left here
                      <span className="a-funnel-key">
                        <i data-part="settled" /> left <i data-part="open" /> still here{" "}
                        <i data-part="passed" /> went on
                      </span>
                    </span>
                  </th>
                  <th scope="col" className="text-right">
                    Went on
                  </th>
                  <th scope="col" className="text-right">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {changes.rows.map((row) => (
                  <ChangeStageRow
                    key={row.stage}
                    row={row}
                    unverified={changes.landedUnverified}
                    estimate={estimate}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          title="Conflicts"
          note={`${plural(state.suspected, "conflict", "conflicts")} suspected`}
        >
          <div className="overflow-x-auto">
            <table className="a-funnel" data-funnel="conflicts">
              <Settled />
              <tbody>
                {state.rows
                  .filter((row) => row.stage >= 4)
                  .map((row) => (
                    <Stage key={row.stage} row={row} numbered={false} />
                  ))}
              </tbody>
            </table>
          </div>
        </Section>

        {counted ? (
          <Section
            title="Comparisons"
            note={`${count(state.changesCompared ?? 0)} submitted changes compared`}
          >
            <dl className="grid grid-cols-2 divide-x divide-kumo-hairline border-b border-kumo-hairline">
              <Tile
                label="Comparisons per change"
                value={
                  state.perChange === undefined ? NOT_COUNTED : state.perChange.compared.toFixed(1)
                }
              >
                {state.perChange !== undefined &&
                  `not ${count(Math.round(state.perChange.everything))}, the premises other changes hold`}
              </Tile>
              <Tile
                label="Settled before any model is asked"
                value={
                  state.settledBeforeModels === undefined
                    ? NOT_COUNTED
                    : share(state.settledBeforeModels, 1)
                }
              >
                by the subject index and the lattice, in code
              </Tile>
            </dl>
            <div className="overflow-x-auto">
              <table className="a-funnel" data-funnel="comparisons">
                <Settled />
                <tbody>
                  {state.rows
                    .filter((row) => row.stage < 4)
                    .map((row) => (
                      <Stage key={row.stage} row={row} numbered />
                    ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-kumo-hairline px-6 py-3 text-sm leading-relaxed text-kumo-subtle">
              A comparison is one derived effect on a subject, checked against one distinct premise
              another change holds there, in flight or landed. These four stages are Keel's own
              counters; what they pass on is what reaches the probe.
            </p>
          </Section>
        ) : (
          <p className="text-sm leading-relaxed text-kumo-subtle">
            Keel does not report how many comparisons each change needed yet, so none is shown.
          </p>
        )}
      </div>
    </div>
  );
}
