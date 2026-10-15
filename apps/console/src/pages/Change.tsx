// One change.

import { useEffect, useState } from "react";
import type { ChangeSummary } from "../contract/keel/index.ts";
import { useWhere } from "../router.tsx";
import { readChangeByNumber } from "../source/changes.ts";
import { Detail, Head } from "../views/Detail.tsx";
import { changeNamed } from "../engine/lists.ts";
import { useHolderCards, usePlayer, useSelected, useWorldVersion } from "../engine/react.tsx";
import { rulingWords } from "../engine/ruling.ts";
import { changePageOf } from "../engine/select.ts";
import type { ChangeTab } from "../route.ts";
import type { Mode } from "../theme/mode.ts";
import { Change, StatePill } from "../views/Change.tsx";
import { Notice } from "../views/Frame.tsx";

/** A change's page before the project's log brings it: its head, from Keel's list of the project's changes. */
function EarlyChange({ name }: { name: string }) {
  const player = usePlayer();
  const { project } = useWhere();
  const projectId = player.projects.named(project)?.id;
  const [summary, setSummary] = useState<ChangeSummary | null>(null);
  useEffect(() => {
    const number = Number(name);
    if (projectId === undefined || !Number.isInteger(number) || !player.live) return undefined;
    const stop = new AbortController();
    readChangeByNumber(projectId, number, stop.signal)
      .then(setSummary)
      .catch(() => setSummary(null));
    return () => stop.abort();
  }, [player, projectId, name]);
  if (summary === null) return null;
  return (
    <Detail>
      <Head
        title={summary.goal}
        label={`#${summary.number}`}
        state={
          <>
            <StatePill state={summary.state} />
            <span className="a-chip" data-tone="quiet">
              {summary.state}
            </span>
          </>
        }
        meta={<span>Loading the conversation</span>}
      />
    </Detail>
  );
}

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
  // While the log is still being read, a change not read yet is drawn from Keel's read model of the project's
  // changes: its goal, its number and where it stands, with the rest to come.
  if (state === null && !player.loaded) return <EarlyChange name={name} />;
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
