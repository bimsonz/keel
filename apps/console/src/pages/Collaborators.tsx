// The agents on a project, as a code host lists a repository's collaborators: a row each. A project of a person's
// own namespace takes agents of its own, by Keel's list and its owner's Invite agent; an org's has the org's,
// whom the org's People page lists and invites.

import { Button, buttonVariants } from "@cloudflare/kumo";
import { useMemo, useState } from "react";
import { createAccount } from "../account/account.ts";
import { useListed } from "../account/OrgAgents.tsx";
import { SCOPES, type Grant, joinedOf, removalOf } from "../account/orgAgents.ts";
import { AgentRow, InviteAgent, useSponsored } from "../account/People.tsx";
import { Refusal, useAsking } from "../account/parts.tsx";
import { Box, Refused, RowMenu, Rows } from "../account/rows.tsx";
import type { NamespaceAgent, ProjectView } from "../contract/keel/index.ts";
import { hrefOf } from "../places.ts";
import { createHttpOrgAgents, createHttpSponsorship } from "../source/http.ts";
import type { KeelOrgAgents, KeelProjectAgents } from "../source/types.ts";

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
  const sponsorship = useMemo(() => createHttpSponsorship(), []);
  const sponsored = useSponsored(sponsorship);
  const { busy, refused, ask } = useAsking();
  const [inviting, setInviting] = useState(false);
  /** What was last asked of Keel here: asked again, as it was, once the reader has signed in afresh. */
  const [last, setLast] = useState<{ asked: () => Promise<void> } | null>(null);

  const move = (what: () => Promise<void>): Promise<void> => {
    const asked = async (): Promise<void> => {
      await what();
      await read();
    };
    setLast({ asked });
    return ask(asked);
  };
  const again = (): void =>
    void ask(async () => {
      const account = createAccount({ origin: window.location.origin });
      const before = await account.who();
      const signedIn = await account.signInWithPasskey();
      // A passkey of another account signs that account in: the page is read again as whoever it is now.
      if (before?.id !== signedIn.id) {
        window.location.reload();
        return;
      }
      await last?.asked();
      setInviting(false);
    });
  const invite = async (handle: string, grant: Grant): Promise<boolean> => {
    let sent = false;
    await move(async () => {
      await invited.inviteAgent(handle, SCOPES[grant]);
      sent = true;
    });
    return sent;
  };
  const menu = (agent: NamespaceAgent) => (
    <RowMenu
      label={`Actions for ${agent.handle ?? agent.name}`}
      disabled={busy}
      items={[
        {
          label: removalOf(agent),
          danger: true,
          select: () =>
            void move(async () => {
              await invited.removeAgent(agent.id);
            }),
        },
      ]}
    />
  );
  const joined = (listed ?? []).filter((agent) => agent.state === "joined");
  const pending = (listed ?? []).filter((agent) => agent.state === "invited");

  return (
    <>
      <Box
        title="Agents"
        {...(listed === null ? {} : { count: joined.length })}
        actions={
          <Button type="button" size="sm" variant="primary" onClick={() => setInviting(true)}>
            Invite agent
          </Button>
        }
      >
        <Rows label="Agents on this project">
          {joined.map((agent) => (
            <AgentRow key={agent.id} agent={agent} menu={menu(agent)} />
          ))}
        </Rows>
        {listed !== null && joined.length === 0 && (
          <p className="px-4 py-3 text-sm text-kumo-subtle">No agents</p>
        )}
      </Box>
      {pending.length > 0 && (
        <Box title="Pending invitations" count={pending.length}>
          <Rows label="Invitations not yet answered">
            {pending.map((agent) => (
              <AgentRow key={agent.id} agent={agent} menu={menu(agent)} />
            ))}
          </Rows>
        </Box>
      )}
      {unread !== null && <Refusal said={unread} />}
      {!inviting && <Refused said={refused} busy={busy} again={again} />}
      {inviting && (
        <InviteAgent
          invite={invite}
          sponsored={sponsored}
          listed={listed ?? []}
          busy={busy}
          refused={refused}
          again={again}
          close={() => setInviting(false)}
        />
      )}
    </>
  );
}

/** The agents on an org's project: the org's, as Keel lists them to a member, invited on the org's People page. */
export function OrgAgentsOf({ org }: { org: string }) {
  const agents = useMemo(() => createHttpOrgAgents(), []);
  const { listed, unread } = useListed(agents, org);
  const joined = listed === null ? [] : joinedOf(listed);
  return (
    <>
      <Box
        title="Agents"
        {...(listed === null ? {} : { count: joined.length })}
        actions={
          <a
            className={buttonVariants({ variant: "secondary", size: "sm" })}
            href={hrefOf({ at: "org", org, tab: "members" })}
          >
            Manage
          </a>
        }
      >
        <Rows label="Agents on this project">
          {joined.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </Rows>
        {listed !== null && joined.length === 0 && (
          <p className="px-4 py-3 text-sm text-kumo-subtle">No agents</p>
        )}
      </Box>
      {unread !== null && <Refusal said={unread} />}
    </>
  );
}
