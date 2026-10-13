// One agent in this project: its runs here, each with the changes it holds.
// A run is a part of this page, with a place of its own on it that a change's
// page links to.

import { useEffect } from "react";
import { type HeldChange, type RunSection, agentPageOf } from "../engine/agents.ts";
import { PAGE } from "../engine/lists.ts";
import { usePlayer, useSelected } from "../engine/react.tsx";
import { Link } from "../router.tsx";
import { Notice } from "../views/Frame.tsx";
import { CHANGE_TONE, ChangeMark, Column } from "../views/List.tsx";
import { ChangeLink } from "../views/links.tsx";
import { dateTime } from "../views/parts.tsx";
import { Declared, HandleLink } from "./Agents.tsx";

function entriesOf(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "entry" : "entries"} of the log`;
}

function Held({ changes, none }: { changes: HeldChange[]; none: string }) {
  if (changes.length === 0) return <p className="text-sm text-kumo-subtle">{none}</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {changes.map((change) => (
        <li key={change.id} className="flex flex-wrap items-center gap-2 text-sm">
          <ChangeMark state={change.state} size={16} />
          <b className="a-mono font-semibold text-kumo-default">{change.label}</b>
          <ChangeLink id={change.id} className="a-link min-w-0">
            {change.goal}
          </ChangeLink>
          <span className="a-chip ml-auto" data-tone={CHANGE_TONE[change.state] ?? "quiet"}>
            {change.state}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Run({ run }: { run: RunSection }) {
  return (
    <section
      id={run.anchor}
      className="a-panel flex flex-col gap-3 p-4"
      aria-label={`Run ${run.id}`}
    >
      <header className="flex flex-col gap-1">
        {/* The label is the agent's own word for its run: it is quoted, and said to be the agent's. */}
        <h2 className="a-h">
          {run.label === undefined ? "A run it gave no name" : `“${run.label}”`}
        </h2>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-kumo-subtle">
          {run.label !== undefined && <span>as the agent named it</span>}
          <span className="a-mono">{run.id}</span>
          <span>
            first wrote <time className="a-num">{dateTime(run.firstAt)}</time>
          </span>
          <span>
            last wrote <time className="a-num">{dateTime(run.lastAt)}</time>
          </span>
          <span>{entriesOf(run.entries)}</span>
        </p>
      </header>
      <Held changes={run.changes} none="This run holds no change now." />
    </section>
  );
}

export function AgentPage({ name }: { name: string }) {
  const player = usePlayer();
  const page = useSelected((world, from) => agentPageOf(world, from.cards, name), [name]);
  const agentId = page?.agent.id;
  // The log names an agent by its id. At its id the page asks for its card; at a handle it asks Keel whose the
  // handle is, and says nothing until Keel has answered.
  useEffect(() => {
    if (agentId !== undefined) player.wantCards([agentId]);
    else player.wantAgentAt(name);
  }, [player, agentId, name]);
  const sought = useSelected((_, from) => from.sought.has(name), [name]);
  // A link to one run arrives with its place on the page: the run is brought into view once it is drawn.
  const drawn = page !== null;
  const place = window.location.hash.slice(1);
  useEffect(() => {
    if (drawn && place !== "") document.getElementById(place)?.scrollIntoView();
  }, [drawn, place]);
  if (page === null && !sought) return null;
  if (page === null)
    return (
      <Notice title={`Keel's log names no agent ${name} in this project`}>
        An agent is listed here once it has written in the project or holds one of its changes.{" "}
        <Link to={{ at: "agents", shown: PAGE }} className="a-link">
          See the project's agents
        </Link>
      </Notice>
    );
  const { agent, runs, unnamed } = page;
  return (
    <Column>
      <header className="flex flex-col gap-1.5">
        <h1 className="text-[22px] font-semibold text-kumo-strong">{agent.label ?? "Agent"}</h1>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-kumo-subtle">
          <HandleLink handle={agent.handle} />
          <span className="a-mono">{agent.id}</span>
          <Declared kind={agent.kind} />
          {agent.namespace !== undefined && <span>works in {agent.namespace}</span>}
          {page.lastAt !== undefined && (
            <span>
              last wrote here <time className="a-num">{dateTime(page.lastAt)}</time>
            </span>
          )}
        </p>
      </header>
      {runs.length === 0 && unnamed === undefined && (
        <p className="text-sm text-kumo-subtle">
          Keel's log names this agent here, and no run or change of its yet.
        </p>
      )}
      {runs.map((run) => (
        <Run key={run.id} run={run} />
      ))}
      {unnamed !== undefined && (
        <section className="a-panel flex flex-col gap-3 p-4" aria-label="No run named">
          <header className="flex flex-col gap-1">
            <h2 className="a-h">No run named</h2>
            <p className="text-sm text-kumo-subtle">
              Work under a token that named no run: {entriesOf(unnamed.entries)}.
            </p>
          </header>
          <Held changes={unnamed.changes} none="No change is held that way now." />
        </section>
      )}
    </Column>
  );
}
