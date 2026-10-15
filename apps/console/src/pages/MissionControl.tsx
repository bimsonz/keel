// Mission Control: the project drawn as an architecture diagram that grows
// outward as Keel works on it, live. A subject named in the address opens its
// panel beside it.

import { Suspense, lazy, useRef } from "react";
import { canvasOf } from "../engine/canvas.ts";
import { growthOf, keptAfresh } from "../engine/growth.ts";
import { useClock, useHolderCards, usePlayer, useSelected } from "../engine/react.tsx";
import { subjectDetailOf } from "../engine/subject.ts";
import type { Mode } from "../theme/mode.ts";
import { MissionCanvas } from "../views/later.tsx";
import { SubjectPanel } from "../views/SubjectPanel.tsx";

// Playback is for a test fixture's log. It is loaded only in development, so the built console does not have it.
const Transport = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import("../views/Transport.tsx")).Transport }))
  : null;

export function MissionControlPage({
  name,
  subject,
  mode,
}: {
  /** The project's `<namespace>/<name>`. */
  name: string;
  subject?: string;
  mode: Mode;
}) {
  const player = usePlayer();
  // A timer, a fork going quiet and a branch dissolving turn on the time as well as the log.
  const clock = useClock(1);
  // Where each fork and batch was put: kept while the reader is here, so nothing placed moves.
  const kept = useRef(keptAfresh());
  const canvas = useSelected((world, { t, cards }) => canvasOf(world, t, cards), [clock]);
  const growth = useSelected(
    (world, { t, cards }) => growthOf(world, t, name, kept.current, cards),
    [clock, name],
  );
  const detail = useSelected(
    (world, { cards }) => (subject === undefined ? null : subjectDetailOf(world, subject, cards)),
    [subject],
  );
  // A card is asked for each agent drawn, so it is named as its card names it.
  useHolderCards(growth.nodes.flatMap((node) => (node.kind === "fork" ? [node.changeId] : [])));
  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">Mission Control</h1>
      {Transport !== null && !player.live && (
        <div className="shrink-0 border-b border-kumo-line bg-kumo-base px-4">
          <Suspense fallback={null}>
            <Transport />
          </Suspense>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <MissionCanvas
            canvas={canvas}
            growth={growth}
            now={player.t}
            mode={mode}
            live={player.live}
            loaded={player.loaded}
          />
        </div>
        {detail !== null && <SubjectPanel detail={detail} />}
        {subject !== undefined && detail === null && (
          <aside className="a-subject px-5 py-4" aria-label={`Subject ${subject}`}>
            <h2 className="a-mono break-all text-lg font-semibold text-kumo-strong">{subject}</h2>
            <p className="mt-1 text-base text-kumo-subtle">No subject of this name.</p>
          </aside>
        )}
      </div>
    </div>
  );
}
