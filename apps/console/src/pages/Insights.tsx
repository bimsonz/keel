// Insights: the numbers about the project, as distinct from the things in it.
// Trunk's own, what review cost at each stage, and, where a run was sealed
// before it began, how Keel did against what was planted.

import { funnelOf } from "../engine/funnel.ts";
import { useClock, usePublicOnly, useSelected } from "../engine/react.tsx";
import { benchmarkOf } from "../engine/benchmark.ts";
import { trunkStatsOf } from "../engine/select.ts";
import type { InsightsTab } from "../route.ts";
import { Link } from "../router.tsx";
import { Funnel } from "../views/Funnel.tsx";
import { Column } from "../views/List.tsx";
import { Benchmark } from "../views/Benchmark.tsx";
import { TrunkTable } from "../views/TrunkStats.tsx";

const PAGES: { id: InsightsTab; label: string }[] = [
  { id: "trunk", label: "Trunk" },
  { id: "funnel", label: "Review funnel" },
  { id: "benchmark", label: "Benchmark" },
];

function Trunk() {
  // A rate is over the last minute, so it is read again as the minute moves on, whether or not Keel wrote.
  const clock = useClock(0.5);
  const trunk = useSelected((world, { t }) => trunkStatsOf(world, t), [clock]);
  return (
    <Column>
      <header>
        <h1 className="text-[22px] font-semibold text-kumo-strong">Trunk</h1>
        <p className="mt-0.5 text-base text-kumo-default">
          Only Keel writes to trunk. These are its own counts of what that has come to.
        </p>
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

export function InsightsPage({ tab }: { tab: InsightsTab }) {
  // A benchmark is listed only where a run was sealed. Its address still answers, and says there is none.
  const sealed = useSelected((world) => world.seal !== undefined);
  return (
    <div className="grid h-full grid-cols-[208px_minmax(0,1fr)]">
      <nav aria-label="Insights" className="a-submenu">
        {PAGES.filter((page) => page.id !== "benchmark" || sealed || tab === "benchmark").map(
          (page) => (
            <Link
              key={page.id}
              to={{ at: "insights", tab: page.id }}
              aria-current={page.id === tab ? "page" : undefined}
            >
              {page.label}
            </Link>
          ),
        )}
      </nav>
      <div className="min-h-0 min-w-0">
        {tab === "trunk" && <Trunk />}
        {tab === "funnel" && <ReviewFunnel />}
        {tab === "benchmark" && <SealedRun />}
      </div>
    </div>
  );
}
