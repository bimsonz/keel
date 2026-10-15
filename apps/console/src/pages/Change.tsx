// One change.

import { useEffect } from "react";
import { shownAgent } from "../engine/audience.ts";
import { changeDrawn } from "../engine/seed.ts";
import { changeNamed } from "../engine/lists.ts";
import { useHolderCards, usePlayer, useSelected, useWorldVersion } from "../engine/react.tsx";
import { rulingWords } from "../engine/ruling.ts";
import { changePageOf } from "../engine/select.ts";
import type { ChangeTab } from "../route.ts";
import type { Mode } from "../theme/mode.ts";
import { Change, EarlyChange } from "../views/Change.tsx";
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
  // A question this change waits on, in words, and whether this reader may rule on it here.
  const escalationId = state?.escalation?.state === "open" ? state.escalation.id : undefined;
  useEffect(() => {
    if (escalationId !== undefined) player.wantAsked();
  }, [player, escalationId]);
  const words = useSelected(
    (world) => {
      const entry = escalationId === undefined ? undefined : world.escalations.get(escalationId);
      return entry === undefined ? undefined : rulingWords(world, entry);
    },
    [escalationId],
  );
  // While the log is read, where the change stands now is asked of Keel's read model, and its holder's card.
  const number = Number(name);
  const reading = !player.loaded;
  useEffect(() => {
    if (reading && Number.isInteger(number)) player.wantSummary(number);
  }, [player, reading, number]);
  const summary = player.summaries.get(number);
  const holder = summary?.agentId;
  useEffect(() => {
    if (holder !== undefined) player.wantCards([holder]);
  }, [player, holder]);
  const drawn = changeDrawn(player, state !== null, summary);
  if (drawn.by === "waiting") return null;
  if (drawn.by === "early") {
    const card = player.cards.get(drawn.summary.agentId);
    const agent = shownAgent(player.world.agents.get(drawn.summary.agentId), card);
    return (
      <EarlyChange
        summary={drawn.summary}
        agent={{ ...agent, ...(card?.handle === undefined ? {} : { handle: card.handle }) }}
        tab={tab}
      />
    );
  }
  if (state === null) return <Notice title={`Change #${name} not found`} />;
  return (
    <Change
      state={state}
      mode={mode}
      tab={tab}
      {...(escalationId === undefined || words === undefined
        ? {}
        : {
            ruling: {
              words,
              answerable: player.canRule(escalationId),
              onRule: (option: string, rationale?: string) =>
                player.rule(escalationId, option, rationale),
            },
          })}
    />
  );
}
