// On a fork, the form that proposes one of its commits back to the project it was forked from, as a code host's
// Contribute → Open pull request does: the commit (the fork's trunk head unless another is named) and what it
// does. Keel waits for a maintainer of that project to approve it before verifying anything, and the page moves
// to the proposal there once Keel has made it.

import { Button } from "@cloudflare/kumo";
import { useRef, useState } from "react";
import { Refusal, useAsking } from "../account/parts.tsx";
import type { ProjectView } from "../contract/keel/index.ts";
import { proposalKeys } from "../source/http.ts";
import { usePlayer, useSelected } from "../engine/react.tsx";
import { hrefOf } from "../places.ts";
import { href } from "../route.ts";
import { useWhere } from "../router.tsx";
import type { ReaderMark } from "../views/Frame.tsx";
import { Notice } from "../views/Frame.tsx";
import { Column } from "../views/List.tsx";

export function NewProposalPage({
  project,
  reader,
}: {
  project: ProjectView;
  reader: ReaderMark | undefined;
}) {
  const proposals = usePlayer().source.proposals;
  const { to } = useWhere();
  const head = useSelected((world) => world.trunk.head);
  const [commit, setCommit] = useState<string>();
  const [goal, setGoal] = useState("");
  const { busy, refused, ask } = useAsking();
  // Asking again for the same commit and goal reaches the proposal its first attempt reserved.
  const keyOf = useRef(proposalKeys()).current;
  const upstream = project.forkedFrom;

  if (proposals === undefined)
    return (
      <Notice title="A test fixture takes no proposals">
        Keel holds a project's proposals, and this is not Keel.
      </Notice>
    );
  if (upstream === undefined)
    return (
      <Notice title="Only a fork proposes">
        This project was not forked from one you may read, so there is nowhere to propose to.
      </Notice>
    );
  if (reader?.name === undefined)
    return (
      <Notice title="Sign in to propose">
        <a className="a-link" href={hrefOf({ at: "login" }, to({ at: "new-proposal" }))}>
          Sign in
        </a>{" "}
        and you come back to this form.
      </Notice>
    );
  const chosen = (commit ?? head ?? "").trim();
  const said = goal.trim();
  return (
    <Column>
      <h1 className="text-2xl font-semibold text-kumo-strong">
        Propose to {upstream.namespace}/{upstream.name}
      </h1>
      <p className="text-sm text-kumo-subtle">
        A maintainer of {upstream.namespace}/{upstream.name} approves the commit before Keel
        verifies anything of it; once approved, it is verified and lands as any change there does.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen === "" || said === "") return;
          void ask(async () => {
            const proposal = { commit: chosen, goal: said };
            const proposed = await proposals.propose(upstream.id, proposal, keyOf(proposal));
            // The proposal is the other project's: a plain load of its page there.
            window.location.assign(
              href(upstream.namespace, upstream.name, {
                at: "change",
                name: proposed.id,
                tab: "overview",
              }),
            );
          });
        }}
      >
        <label htmlFor="proposal-commit" className="text-sm font-medium text-kumo-default">
          Commit of this fork's trunk
        </label>
        <input
          id="proposal-commit"
          value={commit ?? head ?? ""}
          onChange={(event) => setCommit(event.target.value)}
          pattern="[0-9a-f]{40}"
          required
          className="a-mono rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
        />
        <label htmlFor="proposal-goal" className="text-sm font-medium text-kumo-default">
          What it does
        </label>
        <textarea
          id="proposal-goal"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={4}
          required
          className="rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
        />
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={busy || chosen === "" || said === ""}
          >
            Propose
          </Button>
        </div>
        <Refusal said={refused} />
      </form>
    </Column>
  );
}
