// The pipeline: every change in this project where Keel has it, stage by
// stage, with the batches in flight, what verification said of each, and what
// trunk took. The clear view of runs.

import { canvasOf } from "../engine/canvas.ts";
import { useClock, usePlayer, useSelected } from "../engine/react.tsx";
import type { Mode } from "../theme/mode.ts";
import { Pipeline } from "../views/later.tsx";

export function PipelinePage({ mode }: { mode: Mode }) {
  const player = usePlayer();
  // A batch's timer, a change gone quiet and a rate over the last minutes turn on the time as well as the log.
  const clock = useClock(1);
  const canvas = useSelected((world, { t, cards }) => canvasOf(world, t, cards), [clock]);
  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">Pipeline</h1>
      <div className="min-h-0 flex-1">
        <Pipeline
          canvas={canvas}
          now={player.t}
          mode={mode}
          live={player.live}
          loaded={player.loaded}
        />
      </div>
    </div>
  );
}
