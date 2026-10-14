// Who has access to a project, as a code host lists a repository's collaborators on its settings: people and
// agents in one list, an agent marked as one. A project of a person's own namespace is theirs and the agents'
// they add to it, by Keel's list and its owner's form; an org's is its members', people and agents, whom the
// org's members page lists and adds.

import { Button, Input } from "@cloudflare/kumo";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { createAccount } from "../account/account.ts";
import { Named, declared, said, useListed } from "../account/OrgAgents.tsx";
import {
  GRANTS,
  type Grant,
  SCOPES,
  givenOf,
  removalOf,
  standingOf,
} from "../account/orgAgents.ts";
import { Refusal, SELECT, useAsking } from "../account/parts.tsx";
import type { ProjectView } from "../contract/keel/index.ts";
import { hrefOf } from "../places.ts";
import type { KeelOrgAgents, KeelProjectAgents } from "../source/types.ts";

/** Keel's code, on `/v1`, for a move that wants a passkey sign-in from the last ten minutes. */
const FRESH_SIGN_IN = "auth.fresh_sign_in_required";

/**
 * The project's three calls, under the shape the list's hook reads: it names a place, and here the place is the
 * one project the source is of.
 */
function listedBy(invited: KeelProjectAgents): KeelOrgAgents {
  return {
    listAgents: (_project, signal) => invited.listAgents(signal),
    inviteAgent: (_project, agent, scopes) => invited.inviteAgent(agent, scopes),
    removeAgent: (_project, agentId) => invited.removeAgent(agentId),
  };
}

/** Whether a project takes an invitation of its own, and from this reader: a person's own, read by its owner. */
export function invitesHere(project: ProjectView): boolean {
  return project.namespace.kind === "user" && project.viewer?.role === "owner";
}

export function Collaborators({
  project,
  invited,
}: {
  project: ProjectView;
  invited: KeelProjectAgents;
}) {
  const agents = useMemo(() => listedBy(invited), [invited]);
  const { listed, unread, read } = useListed(agents, project.id);
  const [handle, setHandle] = useState("");
  const [grant, setGrant] = useState<Grant>("work");
  const { busy, refused, ask } = useAsking();
  /** What was last asked of Keel here: asked again, as it was, once the reader has signed in afresh. */
  const last = useRef<(() => Promise<void>) | null>(null);

  const move = (what: () => Promise<void>): Promise<void> => {
    const asked = async (): Promise<void> => {
      await what();
      await read();
    };
    last.current = asked;
    return ask(asked);
  };
  const invite = (event: FormEvent): void => {
    event.preventDefault();
    const named = handle.trim();
    void move(async () => {
      await invited.inviteAgent(named, SCOPES[grant]);
      setHandle("");
    });
  };
  const again = (): Promise<void> =>
    ask(async () => {
      const account = createAccount({ origin: window.location.origin });
      const before = await account.who();
      const signedIn = await account.signInWithPasskey();
      // A passkey of another account signs that account in: the page is read again as whoever it is now.
      if (before?.id !== signedIn.id) {
        window.location.reload();
        return;
      }
      await last.current?.();
    });

  const owner = project.namespace.handle;
  return (
    <section className="a-panel flex flex-col gap-3 p-4" aria-label="Collaborators">
      <h2 className="a-h">Collaborators</h2>
      <ul className="flex flex-col gap-2" aria-label="Who has access to this project">
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <a className="a-link font-semibold" href={hrefOf({ at: "namespace", handle: owner })}>
            {owner}
          </a>
          <span className="a-chip" data-tone="quiet">
            owner
          </span>
        </li>
        {(listed ?? []).map((agent) => (
          <li
            key={agent.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"
          >
            <div className="flex min-w-0 flex-col">
              <span className="flex flex-wrap items-center gap-x-2">
                <Named agent={agent} />
                <span className="a-chip" data-tone="quiet">
                  agent
                </span>
              </span>
              {/* Only the project's owner adds one, so a row has nobody's name to tell apart. */}
              <span className="text-kumo-subtle">
                {said([declared(agent), givenOf(agent), standingOf(agent)])}
              </span>
            </div>
            <button
              type="button"
              className="a-link"
              disabled={busy}
              aria-label={`${removalOf(agent)} ${agent.name}`}
              onClick={() =>
                void move(async () => {
                  await invited.removeAgent(agent.id);
                })
              }
            >
              {removalOf(agent)}
            </button>
          </li>
        ))}
      </ul>
      {unread !== null && <Refusal said={unread} />}
      {listed !== null && listed.length === 0 && (
        <p className="text-sm text-kumo-default">No agent has been invited to this project.</p>
      )}
      <p className="text-sm text-kumo-subtle">
        You add an agent by its handle. It reads, or reads and works, on this project and on no
        other of yours, and its questions come to you. It gets nothing until it accepts.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={invite}
        aria-label="Add an agent to this project"
      >
        <Input
          aria-label="The agent's handle"
          name="agent"
          placeholder="its-handle"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
        />
        <select
          className={SELECT}
          aria-label="What the agent may do on this project"
          value={grant}
          onChange={(event) => setGrant(event.target.value === "read" ? "read" : "work")}
        >
          {GRANTS.map((offered) => (
            <option key={offered.grant} value={offered.grant}>
              {offered.label}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" disabled={busy || handle.trim() === ""}>
          Add agent
        </Button>
      </form>
      <Refusal said={refused} />
      {refused?.code === FRESH_SIGN_IN && (
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void again()}>
            Sign in again with a passkey
          </Button>
        </div>
      )}
    </section>
  );
}

/** Who has access to an org's project: its members, people and agents alike, whom its members page lists and adds. */
export function OrgCollaborators({ org }: { org: string }) {
  return (
    <section className="a-panel flex flex-col gap-2 p-4" aria-label="Collaborators">
      <h2 className="a-h">Collaborators</h2>
      <p className="text-sm text-kumo-default">
        Everyone in {org} has access to this project, its people and its agents alike.{" "}
        <a className="a-link" href={hrefOf({ at: "org", org, tab: "members" })}>
          See who, and add an agent, on {org}'s members page
        </a>
      </p>
    </section>
  );
}
