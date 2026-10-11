// The benchmark: what the swarm's runner planted, held against what Keel did
// about it. Sealed until the runner publishes its ground truth; then every
// planted disagreement and every decoy is shown with its outcome, misses first.

import { CheckIcon, CircleNotchIcon, LockIcon, LockOpenIcon, XIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import {
  type ScoreOutcome,
  type ScoreRow,
  type BenchmarkState,
  sealHolds,
} from "../engine/benchmark.ts";
import { ChangeLink, ConflictLink } from "./links.tsx";

const OUTCOME: Record<ScoreOutcome, { word: string; tone?: string; Icon?: typeof CheckIcon }> = {
  caught: { word: "caught", tone: "guarded", Icon: CheckIcon },
  missed: { word: "missed", tone: "proven", Icon: XIcon },
  "false-positive": { word: "false positive", tone: "proven", Icon: XIcon },
  dismissed: { word: "dismissed", tone: "quiet" },
  "left-alone": { word: "never raised", tone: "quiet" },
  undecided: { word: "undecided" },
};

function Tile({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-6 py-5">
      <dt className="text-sm text-kumo-subtle">{label}</dt>
      <dd className="flex items-center gap-2.5 text-[34px] font-semibold leading-none text-kumo-strong">
        {value}
      </dd>
      <dd className="text-sm leading-snug text-kumo-default">{children}</dd>
    </div>
  );
}

const of = (part: number, whole: number): ReactNode => (
  <>
    {part}
    <span className="text-[22px] font-normal text-kumo-subtle">of {whole}</span>
  </>
);

/** `sha256:` and the two ends of the digest, for a line of prose. The whole of it is in the title. */
function Commitment({ value }: { value: string }) {
  return (
    <span className="a-mono text-kumo-strong" title={value}>
      {value.slice(0, 15)}…{value.slice(-8)}
    </span>
  );
}

/** What Keel did about one entry, in a sentence. */
function account(row: ScoreRow): string {
  const { conflict, derived, entry } = row;
  if (conflict !== undefined) {
    const cost = conflict.costUsd === undefined ? "" : ` for $${conflict.costUsd}`;
    if (row.outcome === "dismissed" || (row.outcome === "missed" && conflict.state === "dismissed"))
      return `Conflict ${conflict.label} was raised, and its probe dismissed it${cost}.`;
    if (row.outcome === "undecided") return `Conflict ${conflict.label} is open.`;
    const guard =
      conflict.guard === undefined || conflict.guard === ""
        ? ""
        : `, and guard ${conflict.guard} now holds it`;
    const decision =
      conflict.decision === undefined || conflict.decision === ""
        ? ""
        : ` A person ruled: decision ${conflict.decision}.`;
    return `Conflict ${conflict.label} was proven${guard}.${decision}`;
  }
  if (row.outcome === "undecided") return "Nothing has been raised so far.";
  const how =
    derived === undefined
      ? ""
      : ` ${derived.method === "clef" ? "Clef" : `The ${derived.method}`} derived ${entry.predicate} is ${derived.value}${derived.p === undefined ? "" : ` (p = ${derived.p})`}${derived.method === "clef" ? ", and no extractor applied" : ""}.`;
  return `Nothing was raised.${how}${row.alters?.landed === true ? " Both changes landed." : ""}`;
}

function Entry({ row }: { row: ScoreRow }) {
  const { entry } = row;
  const outcome = OUTCOME[row.outcome];
  const altersId = row.alters?.changeId;
  return (
    <tr data-outcome={row.outcome}>
      <th scope="row">
        <span className="a-mono text-sm text-kumo-subtle">{entry.id}</span>
        <span className="ml-3 text-base font-semibold text-kumo-strong">
          {entry.kind === "planted" ? "Planted" : "Decoy"}
        </span>
      </th>
      <td>
        <span className="a-mono text-kumo-strong">{entry.subject}</span>
        <p className="mt-0.5 text-sm text-kumo-default">
          {entry.relies.agent} relies on {entry.predicate} at most {entry.relies.atMost}.{" "}
          {entry.kind === "planted"
            ? `${entry.alters.agent} makes it ${entry.alters.to}.`
            : `${entry.alters.agent} only looks as if it changes that: it stays ${entry.alters.to}.`}
        </p>
      </td>
      <td>
        <span className="a-chip" data-tone={outcome.tone}>
          {outcome.Icon !== undefined && <outcome.Icon size={13} weight="bold" />}
          {outcome.word}
        </span>
      </td>
      <td>
        <p className="text-sm leading-snug text-kumo-default">{account(row)}</p>
        {!row.borneOut && (
          <p className="mt-0.5 text-sm font-medium" style={{ color: "var(--a-suspected-ink)" }}>
            Keel's log does not show these to be the changes that were sealed.
          </p>
        )}
      </td>
      <td className="text-right">
        {row.conflict === undefined ? (
          altersId !== undefined && (
            <ChangeLink id={altersId} className="a-link text-sm">
              The change
            </ChangeLink>
          )
        ) : (
          <ConflictLink id={row.conflict.id} className="a-link text-sm">
            The conflict
          </ConflictLink>
        )}
      </td>
    </tr>
  );
}

function Tally({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 px-6 py-5">
      <dt className="text-sm text-kumo-subtle">{label}</dt>
      <dd className="a-num text-[28px] font-semibold leading-none text-kumo-strong">{value}</dd>
    </div>
  );
}

/** Whether the published text hashes to the commitment: checked here, in the browser, each time it is shown. */
function useSeal(
  sealed: string | undefined,
  commitment: string | undefined,
): "checking" | "holds" | "broken" | "unchecked" {
  const [checked, setChecked] = useState<{ of: string; holds: boolean | null } | null>(null);
  const key = `${commitment ?? ""}\n${sealed ?? ""}`;
  useEffect(() => {
    if (sealed === undefined || commitment === undefined) return undefined;
    let current = true;
    const check = async (): Promise<void> => {
      const holds = await sealHolds(sealed, commitment);
      if (current) setChecked({ of: key, holds });
    };
    void check();
    return () => {
      current = false;
    };
  }, [sealed, commitment, key]);
  if (checked?.of !== key) return "checking";
  if (checked.holds === null) return "unchecked";
  return checked.holds ? "holds" : "broken";
}

export function Benchmark({ state }: { state: BenchmarkState }) {
  const seal = useSeal(state.sealedText, state.commitment);
  if (state.phase === "none") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <h1 className="text-xl font-semibold text-kumo-strong">No sealed run here</h1>
        <p className="max-w-[56ch] text-base text-kumo-subtle">
          A benchmark needs a run whose ground truth was sealed before it began: disagreements
          planted on purpose, and decoys made to look like them. No such run has published its
          commitment to this Keel.
        </p>
      </div>
    );
  }
  const unsealed = state.phase === "unsealed";
  return (
    <div className="a-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1480px] flex-col gap-5 px-6 py-5">
        <header className="flex items-baseline justify-between gap-6">
          <div>
            <h1 className="text-[22px] font-semibold text-kumo-strong">Benchmark</h1>
            <p className="mt-0.5 text-base text-kumo-default">
              What the runner planted, held against what Keel did about it.
            </p>
          </div>
          <span className="a-mono text-sm text-kumo-subtle">{state.runner}</span>
        </header>

        {unsealed ? (
          <dl className="a-panel grid grid-cols-2 divide-x divide-kumo-hairline xl:grid-cols-4">
            <Tile label="Planted disagreements caught" value={of(state.caught, state.planted)}>
              each proven by a probe, three runs out of three
            </Tile>
            <Tile label="Missed" value={state.missed}>
              {state.missed === 0
                ? "Nothing planted got through."
                : "planted, landed, and never proven: first in the list below"}
            </Tile>
            <Tile label="Decoys proven by mistake" value={of(state.falsePositives, state.decoys)}>
              {state.decoysRaised === 0
                ? "None was ever raised."
                : `${state.decoysRaised} were raised, and each was dismissed by its probe`}
            </Tile>
            <Tile
              label="Seal"
              value={
                seal === "checking" ? (
                  <CircleNotchIcon size={28} className="a-spin" aria-label="Checking" />
                ) : seal === "unchecked" ? (
                  "Not checked"
                ) : seal === "holds" ? (
                  <>
                    <CheckIcon
                      size={28}
                      weight="bold"
                      style={{ color: "var(--a-pass)" }}
                      aria-hidden
                    />
                    Holds
                  </>
                ) : (
                  <>
                    <XIcon size={28} weight="bold" style={{ color: "var(--a-fail)" }} aria-hidden />
                    Broken
                  </>
                )
              }
            >
              {seal === "broken"
                ? "What was published is not what was committed to. "
                : seal === "unchecked"
                  ? "This page is not on a secure origin, so it cannot hash the manifest. The commitment was: "
                  : "The manifest hashes to the commitment made before the run: "}
              <Commitment value={state.commitment ?? ""} />
            </Tile>
          </dl>
        ) : (
          <section className="a-panel flex items-start gap-5 p-6">
            <LockIcon size={34} weight="fill" className="shrink-0 text-kumo-subtle" aria-hidden />
            <div className="flex min-w-0 flex-col gap-2">
              <h2 className="text-[28px] font-semibold leading-none text-kumo-strong">
                Sealed: {state.planted} planted, {state.decoys} decoys
              </h2>
              <p className="max-w-[86ch] text-base leading-relaxed text-kumo-default">
                Before the run, the runner arranged {state.planted} real disagreements between
                agents and {state.decoys} decoys that only look like one. It published this
                commitment and nothing else. Neither Keel nor this console can tell which is which
                until the run is over and the manifest is published.
              </p>
              <p className="a-mono break-all text-base text-kumo-strong">{state.commitment}</p>
            </div>
          </section>
        )}

        {!unsealed && (
          <section className="a-panel">
            <header className="a-panel-head">
              <h2 className="a-h">What Keel has done so far</h2>
              <span className="ml-auto text-sm text-kumo-subtle">
                from the log, whatever the truth turns out to be
              </span>
            </header>
            <dl className="grid grid-cols-3 divide-x divide-kumo-hairline">
              <Tally label="Conflicts proven" value={state.keel.proven} />
              <Tally label="Dismissed as false alarms" value={state.keel.dismissed} />
              <Tally label="Still open" value={state.keel.open} />
            </dl>
          </section>
        )}

        {unsealed && (
          <section className="a-panel overflow-hidden">
            <header className="a-panel-head">
              <LockOpenIcon size={18} className="text-kumo-subtle" aria-hidden />
              <h2 className="a-h">The manifest, unsealed</h2>
              <span className="ml-auto text-sm text-kumo-subtle">
                {state.unplanted.length === 0
                  ? "Keel proved nothing the runner did not plant"
                  : `Keel also proved ${state.unplanted.join(", ")}, which the runner did not plant`}
                {state.undecided > 0 && ` · ${state.undecided} undecided`}
              </span>
            </header>
            <table className="a-score">
              <thead>
                <tr>
                  <th scope="col">Entry</th>
                  <th scope="col">What the runner arranged</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">What Keel did</th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((row) => (
                  <Entry key={row.entry.id} row={row} />
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}
