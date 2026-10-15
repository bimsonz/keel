// Insights: the numbers about the project, as distinct from the things in it.
// Trunk's own, what review cost at each stage, and, where a run was sealed
// before it began, how Keel did against what was planted. Beside them, as a
// code host's Insights has its own pages, Keel's records that no tab of a
// code host holds: the project's decisions, its conflicts, and the questions
// put to a person.

import { funnelOf } from "../engine/funnel.ts";
import type { ReactNode } from "react";
import { useClock, usePlayer, usePublicOnly, useSelected } from "../engine/react.tsx";
import { benchmarkOf } from "../engine/benchmark.ts";
import { trunkStatsOf } from "../engine/select.ts";
import type { InsightsTab, Route } from "../route.ts";
import { Link } from "../router.tsx";
import { Funnel } from "../views/Funnel.tsx";
import { PAGE } from "../engine/lists.ts";
import { Column } from "../views/List.tsx";
import { Benchmark } from "../views/Benchmark.tsx";
import { TrunkTable } from "../views/TrunkStats.tsx";

/** Insights' own pages, and Keel's records beside them. */
export type InsightsPlace = InsightsTab | "decisions" | "conflicts" | "questions";

const PAGES: { id: InsightsPlace; label: string; to: Route }[] = [
  { id: "trunk", label: "Trunk", to: { at: "insights", tab: "trunk" } },
  { id: "funnel", label: "Review funnel", to: { at: "insights", tab: "funnel" } },
  { id: "benchmark", label: "Benchmark", to: { at: "insights", tab: "benchmark" } },
  { id: "decisions", label: "Decisions", to: { at: "decisions" } },
  { id: "conflicts", label: "Conflicts", to: { at: "conflicts", filter: "open", shown: PAGE } },
  { id: "questions", label: "Questions", to: { at: "escalations", filter: "open", shown: PAGE } },
];

function Trunk() {
  // A rate is over the last minute, so it is read again as the minute moves on, whether or not Keel wrote.
  const clock = useClock(0.5);
  const trunk = useSelected((world, { t }) => trunkStatsOf(world, t), [clock]);
  return (
    <Column>
      <header>
        <h1 className="text-[22px] font-semibold text-kumo-strong">Trunk</h1>
      </header>
      <TrunkTable trunk={trunk} />
    </Column>
  );
}

function ReviewFunnel() {
  const hidden = usePublicOnly();
  const state = useSelected((world) => funnelOf(world, !hidden), [hidden]);
  return <Funnel state={state} />;
}

function SealedRun() {
  const state = useSelected(benchmarkOf);
  return <Benchmark state={state} />;
}

/** Insights' menu down the side, as a code host has one, and the page it opened beside it. */
export function InsightsFrame({ at, children }: { at: InsightsPlace; children: ReactNode }) {
  // A benchmark is listed only where a run was sealed. Its address still answers, and says there is none.
  const sealed = useSelected((world) => world.seal !== undefined);
  // Keel remembers a project's decisions, and a test fixture has no memory of its own to read.
  const remembers = usePlayer().source.decisions !== undefined;
  return (
    <div className="grid h-full grid-cols-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[208px_minmax(0,1fr)] md:grid-rows-1">
      <nav aria-label="Insights" className="a-submenu">
        {PAGES.filter(
          (page) =>
            (page.id !== "benchmark" || sealed || at === "benchmark") &&
            (page.id !== "decisions" || remembers || at === "decisions"),
        ).map((page) => (
          <Link key={page.id} to={page.to} aria-current={page.id === at ? "page" : undefined}>
            {page.label}
          </Link>
        ))}
      </nav>
      <div className="min-h-0 min-w-0">{children}</div>
    </div>
  );
}

export function InsightsPage({ tab }: { tab: InsightsTab }) {
  return (
    <InsightsFrame at={tab}>
      {tab === "trunk" && <Trunk />}
      {tab === "funnel" && <ReviewFunnel />}
      {tab === "benchmark" && <SealedRun />}
    </InsightsFrame>
  );
}
