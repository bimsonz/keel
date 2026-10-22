// One change.

import { useEffect } from "react";
import type { ProjectView } from "../contract/keel/index.ts";
import { shownAgent } from "../engine/audience.ts";
import { changeDrawn } from "../engine/seed.ts";
import { PAGE, changeNamed } from "../engine/lists.ts";
import { useHolderCards, usePlayer, useSelected, useWorldVersion } from "../engine/react.tsx";
import { rulingWords } from "../engine/ruling.ts";
import { maintains } from "../engine/settings.ts";
import { changePageOf } from "../engine/select.ts";
import type { ChangeTab } from "../route.ts";
import { Link } from "../router.tsx";
import type { Mode } from "../theme/mode.ts";
import { Change, EarlyChange } from "../views/Change.tsx";
import { Notice, type ReaderMark } from "../views/Frame.tsx";

export function ChangePage({
  name,
  tab,
  mode,
  project,
  reader,
}: {
  name: string;
  tab: ChangeTab;
  mode: Mode;
  /** The project as Keel shows it to this reader: whether they maintain it decides who reviews a proposal. */
  project?: ProjectView;
  reader?: ReaderMark;
}) {
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
    const { agentId } = drawn.summary;
    const card = agentId === undefined ? undefined : player.cards.get(agentId);
    const agent = shownAgent(
      agentId === undefined ? undefined : player.world.agents.get(agentId),
      card,
    );
    return (
      <EarlyChange
        summary={drawn.summary}
        agent={{ ...agent, ...(card?.handle === undefined ? {} : { handle: card.handle }) }}
        tab={tab}
      />
    );
  }
  if (state === null)
    return (
      <Notice title={`Change #${name} not found`}>
        <Link to={{ at: "changes", filter: "open", shown: PAGE }} className="a-link">
          All changes
        </Link>
      </Notice>
    );
  // A proposal waiting for approval is reviewed here: a maintainer approves it or asks for changes, and its
  // proposer may close it. Keel decides who may: the page offers what the reader's role allows.
  const proposals = player.source.proposals;
  const proposal = state.proposal;
  const review =
    proposals === undefined || proposal === undefined
      ? undefined
      : {
          reader:
            project !== undefined && maintains(project)
              ? ("maintainer" as const)
              : reader?.id !== undefined && proposal.proposer === `user:${reader.id}`
                ? ("proposer" as const)
                : ("reader" as const),
          onApprove: async (commit: string) => {
            await proposals.approve(state.change.id, commit);
            await player.moved();
          },
          onRequestChanges: async (commit: string, comment: string) => {
            await proposals.requestChanges(state.change.id, commit, comment);
            await player.moved();
          },
          onClose: async () => {
            await proposals.close(state.change.id);
            await player.moved();
          },
        };
  return (
    <Change
      state={state}
      mode={mode}
      tab={tab}
      {...(review === undefined ? {} : { review })}
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
