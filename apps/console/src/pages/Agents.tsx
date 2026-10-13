// The project's agents, listed: every agent Keel's log names as having written
// here or as holding a change, with its runs. What is shown of each is what
// Keel shows anyone.

import { RobotIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { type AgentRow, agentsOf } from "../engine/agents.ts";
import { usePlayer, useSelected } from "../engine/react.tsx";
import { hrefOf } from "../places.ts";
import { Link } from "../router.tsx";
import { Column, More, Nothing, Row, Rows } from "../views/List.tsx";
import { ChangeLink } from "../views/links.tsx";
import { dateTime } from "../views/parts.tsx";
import { InvitedAgents } from "./ProjectAgents.tsx";

/** How many of the changes an agent holds a row names before it counts the rest. */
const NAMED = 3;

/** How an agent comes to be here, in a line: nothing on this page makes one or gives one a credential. */
export function HowAnAgentJoins() {
  return (
    <p className="text-sm text-kumo-subtle">
      An agent signs itself up to Keel with a key of its own, and a person stands behind it at the
      link it hands them. No credential is made here.
    </p>
  );
}

/** The kind an agent declared. It is the agent's own word for itself, and is written as that. */
export function Declared({ kind }: { kind: string | undefined }) {
  return kind === undefined ? null : <span>declared as {kind}</span>;
}

/** An agent's handle, which is its own namespace: its page is at it. */
export function HandleLink({ handle }: { handle: string | undefined }) {
  return handle === undefined ? null : (
    <a className="a-mono a-link-quiet" href={hrefOf({ at: "namespace", handle })}>
      {handle}
    </a>
  );
}

function runsOf(row: AgentRow): string {
  if (row.runs === 0) return "no run named";
  return `${row.runs.toLocaleString("en-US")} ${row.runs === 1 ? "run" : "runs"} here`;
}

export function AgentsPage({ shown }: { shown: number }) {
  const player = usePlayer();
  const all = useSelected((world, from) => agentsOf(world, from.cards), []);
  const rows = all.slice(0, shown);
  // Its card is where an agent's declared kind is, and its name where the log has none: asked once for each row.
  const asked = rows.map((row) => row.id).join(" ");
  useEffect(() => player.wantCards(asked === "" ? [] : asked.split(" ")), [player, asked]);
  return (
    <Column>
      <h1 className="sr-only">Agents</h1>
      <HowAnAgentJoins />
      {/* An agent a person invited to this one project is here once it has joined, though it may have written nothing yet. */}
      {player.source.invited !== undefined && <InvitedAgents invited={player.source.invited} />}
      {rows.length === 0 ? (
        <Nothing title="No agent has written here yet">
          An agent is listed once Keel's log names it: on an entry its command committed, or as the
          holder of a change.
        </Nothing>
      ) : (
        <Rows label="Agents, the one that wrote last first">
          {rows.map((row) => (
            <Row
              key={row.id}
              mark={<RobotIcon size={18} />}
              title={<Link to={{ at: "agent", name: row.name }}>{row.label ?? "Agent"}</Link>}
              meta={
                <>
                  <HandleLink handle={row.handle} />
                  {/* Where Keel has given this reader no name for it, its id is what tells it from the next. */}
                  {row.handle === undefined && <span className="a-mono">{row.id}</span>}
                  <Declared kind={row.kind} />
                  <span>{runsOf(row)}</span>
                  {row.lastAt !== undefined && (
                    <span>
                      last wrote <time className="a-num">{dateTime(row.lastAt)}</time>
                    </span>
                  )}
                </>
              }
              tied={
                <>
                  {row.holds.slice(0, NAMED).map((change) => (
                    <ChangeLink
                      key={change.id}
                      id={change.id}
                      className="a-chip a-mono"
                      data-tone="quiet"
                      title={`Holds change ${change.label}`}
                    >
                      {change.label}
                    </ChangeLink>
                  ))}
                  {row.holds.length > NAMED && (
                    <span className="a-chip" data-tone="quiet">
                      +{(row.holds.length - NAMED).toLocaleString("en-US")}
                    </span>
                  )}
                  <span className="a-chip w-28 justify-center" data-tone="quiet">
                    {row.changes.toLocaleString("en-US")} {row.changes === 1 ? "change" : "changes"}
                  </span>
                </>
              }
            />
          ))}
        </Rows>
      )}
      <More
        shown={shown}
        total={all.length}
        more={all.length > shown}
        noun="agents"
        to={(next) => ({ at: "agents", shown: next })}
      />
    </Column>
  );
}
