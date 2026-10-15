// One conflict.

import { useEffect } from "react";
import { conflictNamed } from "../engine/lists.ts";
import { useHolderCards, usePlayer, useSelected } from "../engine/react.tsx";
import { conflictPageOf } from "../engine/select.ts";
import type { ConflictTab } from "../route.ts";
import type { Mode } from "../theme/mode.ts";
import { Notice } from "../views/Frame.tsx";
import { Conflict } from "../views/Conflict.tsx";

export function ConflictPage({ name, tab, mode }: { name: string; tab: ConflictTab; mode: Mode }) {
  const id = useSelected((world) => conflictNamed(world, name)?.id, [name]);
  const state = useSelected(
    (world, resources) => (id === undefined ? null : conflictPageOf(world, id, resources)),
    [id],
  );
  useHolderCards(
    state?.parties === undefined ? [] : [state.parties.A.changeId, state.parties.B.changeId],
  );
  // The probe's source is read from Keel when someone looks at it, once Keel has named the probe.
  const player = usePlayer();
  const probeId = tab === "probe" ? state?.probe?.id : undefined;
  useEffect(() => {
    if (probeId !== undefined) player.wantProbe(probeId);
  }, [player, probeId]);
  if (id === undefined) {
    return <Notice title={`Conflict ${name} not found`} />;
  }
  // Every conflict Keel names has a page. The address was resolved a moment before the page was read.
  if (state === null) return null;
  return <Conflict state={state} mode={mode} tab={tab} />;
}
