// Mission Control: the live graph of what exists in Keel right now, with
// trunk's numbers above it and a subject's detail beside it.

import { Suspense, lazy, useCallback, useState } from "react";
import type { AgentClass } from "../domain/state.ts";
import { LANES, lanesOf } from "../engine/lanes.ts";
import { usePlayer, useSelected } from "../engine/react.tsx";
import { trunkStatsOf } from "../engine/select.ts";
import { subjectDetailOf } from "../engine/subject.ts";
import type { Mode } from "../theme/mode.ts";
import { MissionGraph } from "../views/MissionGraph.tsx";
import { SubjectPanel } from "../views/SubjectPanel.tsx";
import { TrunkLine } from "../views/TrunkStats.tsx";
import { CLASS_WORD } from "../views/parts.tsx";

// Playback is for a test fixture's log. It is loaded only in development, so the built console does not have it.
const Transport = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import("../views/Transport.tsx")).Transport }))
  : null;

const CLASSES: readonly AgentClass[] = ["real", "hosted", "synthetic"];

export function MissionControlPage({ subject, mode }: { subject?: string; mode: Mode }) {
  const player = usePlayer();
  // What a reader has opened and closed, and how far down they have asked to see. It lasts while they are here.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(LANES);
  // A subject open beside the graph has its lane shown and open in it, however far down it comes.
  const lanes = useSelected(
    (world, { t }) =>
      lanesOf(world, t, {
        opened,
        closed,
        shown,
        ...(subject === undefined ? {} : { pinned: subject }),
      }),
    [opened, closed, shown, subject],
  );
  const trunk = useSelected((world, { t }) => trunkStatsOf(world, t));
  const detail = useSelected(
    (world) => (subject === undefined ? null : subjectDetailOf(world, subject)),
    [subject],
  );
  const toggle = useCallback((key: string, to: boolean): void => {
    const [into, outOf] = to ? [setOpened, setClosed] : [setClosed, setOpened];
    into((before) => new Set([...before, key]));
    outOf((before) => new Set([...before].filter((each) => each !== key)));
  }, []);
  const more = useCallback((): void => setShown((before) => before + LANES), []);
  const agents = CLASSES.filter((agentClass) => lanes.agents[agentClass] > 0).map(
    (agentClass) => `${lanes.agents[agentClass].toLocaleString("en-US")} ${CLASS_WORD[agentClass]}`,
  );
  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">Mission Control</h1>
      <div className="flex shrink-0 flex-wrap items-center gap-x-6 border-b border-kumo-line bg-kumo-base pr-4">
        <TrunkLine trunk={trunk} />
        <p className="a-num ml-auto shrink-0 py-3 text-[13px] text-kumo-subtle" data-working>
          {agents.length > 0 && (
            <>
              <span className="font-semibold text-kumo-strong">{agents.join(" · ")}</span>{" "}
              {agents.length === 1 &&
              lanes.agents.real + lanes.agents.hosted + lanes.agents.synthetic === 1
                ? "agent"
                : "agents"}{" "}
              ·{" "}
            </>
          )}
          <span className="font-semibold text-kumo-strong">
            {lanes.changes.toLocaleString("en-US")}
          </span>{" "}
          {lanes.changes === 1 ? "change" : "changes"} open
        </p>
        {Transport !== null && !player.live && (
          <Suspense fallback={null}>
            <Transport />
          </Suspense>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <MissionGraph
            lanes={lanes}
            mode={mode}
            onToggle={toggle}
            onMore={more}
            {...(detail === null ? {} : { selected: detail.key })}
          />
        </div>
        {detail !== null && <SubjectPanel detail={detail} />}
        {subject !== undefined && detail === null && (
          <aside className="a-subject px-5 py-4" aria-label={`Subject ${subject}`}>
            <h2 className="a-mono break-all text-lg font-semibold text-kumo-strong">{subject}</h2>
            <p className="mt-1 text-base text-kumo-subtle">
              Keel has said nothing about a subject of this name so far. A subject is here once it
              has been minted, or a change has relied on it.
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}
