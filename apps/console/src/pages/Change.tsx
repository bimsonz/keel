// One change.

import { useEffect } from "react";
import { changeNamed } from "../engine/lists.ts";
import { useHolderCards, usePlayer, useSelected, useWorldVersion } from "../engine/react.tsx";
import { changePageOf } from "../engine/select.ts";
import type { ChangeTab } from "../route.ts";
import type { Mode } from "../theme/mode.ts";
import { Change } from "../views/Change.tsx";
import { Notice } from "../views/Frame.tsx";

export function ChangePage({ name, tab, mode }: { name: string; tab: ChangeTab; mode: Mode }) {
  const player = usePlayer();
  const version = useWorldVersion();
  const id = useSelected((world) => changeNamed(world, name)?.id, [name]);
  // Its diff and its verdict's evidence are read from Keel when someone looks, and again as the change moves on.
  useEffect(() => {
    if (id === undefined) return;
    player.wantDiff(id);
    player.wantVerdict(id);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `version` stands for the world's contents: a change gains a commit, and then a verdict
  }, [player, id, version]);
  const state = useSelected(
    (world, resources) => (id === undefined ? null : changePageOf(world, id, resources)),
    [id],
  );
  // The change's own agent, and the agent of each change Keel told it has its intent.
  useHolderCards(
    id === undefined ? [] : [id, ...(state?.sameIntent?.others.map((row) => row.id) ?? [])],
  );
  if (state === null)
    return (
      <Notice title={`There is no change ${name} in what Keel has said so far`}>
        A change is here once an agent has declared its intent.
      </Notice>
    );
  return <Change state={state} mode={mode} tab={tab} />;
}
