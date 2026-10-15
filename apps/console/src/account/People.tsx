// An org's people, as a code host's org People page lists them: its members and the agents in it in one
// bordered list, a row each, the invitations not yet answered in a second, and the dialogs that invite a person
// or an agent. Every move is Keel's own operation, and both lists are read again after each one.

import { Button, Input } from "@cloudflare/kumo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { AgentProfile, NamespaceAgent } from "../contract/keel/index.ts";
import { hrefOf } from "../places.ts";
import type { KeelOrgAgents, KeelSponsorship } from "../source/types.ts";
import type { Account, Invitation, Member, OrgPage, Who } from "./account.ts";
import { Named, useListed } from "./OrgAgents.tsx";
import {
  GRANTS,
  type Grant,
  SCOPES,
  givenOf,
  handleFor,
  inviterOf,
  mayRemove,
  removalOf,
  sponsoredMatching,
  standingOf,
} from "./orgAgents.ts";
import { Refusal, SELECT, type Said, go, useAsking } from "./parts.tsx";
import { ROLES, type Role, givable, manages } from "./roles.ts";
import {
  Avatar,
  Box,
  FormDialog,
  type MenuItem,
  Refused,
  Row,
  RowMenu,
  Rows,
  Tag,
} from "./rows.tsx";

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  maintainer: "Maintainer",
  member: "Member",
};

const joined = (parts: readonly (string | undefined)[]): string =>
  parts.filter((part) => part !== undefined && part !== "").join(" · ");

/** Whether a row is one the filter's words find: by handle, by name, or by the address an invitation was made to. */
const found = (typed: string, ...names: readonly (string | undefined)[]): boolean => {
  const wanted = typed.trim().toLowerCase().replace(/^@/, "");
  return (
    wanted === "" || names.some((name) => name !== undefined && name.toLowerCase().includes(wanted))
  );
};

function RoleSelect({
  label,
  value,
  among,
  disabled,
  onChange,
}: {
  label: string;
  value: Role;
  among: readonly Role[];
  disabled: boolean;
  onChange: (role: Role) => void;
}) {
  return (
    <select
      aria-label={label}
      className={SELECT}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const chosen = ROLES.find((role) => role === event.target.value);
        if (chosen !== undefined) onChange(chosen);
      }}
    >
      {among.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABEL[role]}
        </option>
      ))}
    </select>
  );
}

/** Invite member: one field for a handle or an address, the role, and Invite. */
function InviteMember({
  account,
  page,
  close,
  done,
}: {
  account: Account;
  page: OrgPage;
  close: () => void;
  done: () => Promise<void>;
}) {
  const [to, setTo] = useState("");
  const [role, setRole] = useState<Role>("member");
  const { busy, refused, ask } = useAsking();
  const invite = (event: FormEvent): void => {
    event.preventDefault();
    const typed = to.trim().replace(/^@/, "");
    void ask(async () => {
      // An address has an @ inside it; a handle has none, once a leading one is dropped.
      await account.invite(
        page.org,
        typed.includes("@") ? { email: typed } : { handle: typed },
        role,
      );
      setTo("");
      await done();
      close();
    });
  };
  return (
    <FormDialog
      open
      close={close}
      title="Invite member"
      action="Invite"
      busy={busy}
      ready={to.trim() !== ""}
      submit={invite}
    >
      <Input
        label="Handle or email"
        name="invitee"
        placeholder="@handle or name@example.com"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        value={to}
        onChange={(event) => setTo(event.target.value)}
      />
      <label className="flex flex-col gap-1.5 text-sm font-medium text-kumo-default">
        Role
        <select
          className={SELECT}
          value={role}
          disabled={busy}
          onChange={(event) => {
            const chosen = ROLES.find((offered) => offered === event.target.value);
            if (chosen !== undefined) setRole(chosen);
          }}
        >
          {givable(page.role).map((offered) => (
            <option key={offered} value={offered}>
              {ROLE_LABEL[offered]}
            </option>
          ))}
        </select>
      </label>
      <Refusal said={refused} />
    </FormDialog>
  );
}

/** The agents the reader sponsors, as Keel lists them to the reader alone: none until Keel has answered. */
export function useSponsored(
  sponsorship: Pick<KeelSponsorship, "listSponsored">,
): readonly AgentProfile[] {
  const [sponsored, setSponsored] = useState<readonly AgentProfile[]>([]);
  useEffect(() => {
    let here = true;
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const listed = await sponsorship.listSponsored(stop.signal);
        if (here) setSponsored(listed);
      } catch {
        // A list Keel did not give finds nothing: a handle typed whole is still invited.
      }
    };
    void read();
    return () => {
      here = false;
      stop.abort();
    };
  }, [sponsorship]);
  return sponsored;
}

/**
 * Invite agent: the agent's handle, or the name of one the reader sponsors, with those agents offered under the
 * field as a code host's "Add people" suggests people; its role; and Invite.
 */
export function InviteAgent({
  invite,
  sponsored,
  listed,
  busy,
  refused,
  again,
  close,
}: {
  invite: (handle: string, grant: Grant) => Promise<boolean>;
  sponsored: readonly AgentProfile[];
  /** The agents already invited here, which are not offered again. */
  listed: readonly NamespaceAgent[];
  busy: boolean;
  refused: Said | null;
  again: () => void;
  close: () => void;
}) {
  const [handle, setHandle] = useState("");
  const [grant, setGrant] = useState<Grant>("work");
  const typed = handle.trim().replace(/^@/, "");
  const suggested = sponsoredMatching(sponsored, typed, listed);
  const send = async (): Promise<void> => {
    if (await invite(handleFor(sponsored, typed), grant)) close();
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void send();
  };
  return (
    <FormDialog
      open
      close={close}
      title="Invite agent"
      action="Invite"
      busy={busy}
      ready={handle.trim() !== ""}
      submit={submit}
    >
      <div className="flex flex-col gap-1">
        <Input
          label="Agent handle or name"
          name="agent"
          placeholder="@agent-… or name"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
        />
        {suggested.length > 0 && (
          <ul
            aria-label="Agents you sponsor"
            className="flex max-h-48 flex-col overflow-y-auto rounded-md border border-kumo-line p-1"
          >
            {suggested.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-kumo-tint"
                  onClick={() => setHandle(agent.handle ?? "")}
                >
                  <Avatar name={agent.name} agent />
                  <span className="font-semibold text-kumo-strong">{agent.name}</span>
                  <span className="text-kumo-subtle">@{agent.handle}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-kumo-default">
        Role
        <select
          className={SELECT}
          value={grant}
          onChange={(event) => setGrant(event.target.value === "read" ? "read" : "work")}
        >
          {GRANTS.map((offered) => (
            <option key={offered.grant} value={offered.grant}>
              {offered.label}
            </option>
          ))}
        </select>
      </label>
      <Refused said={refused} busy={busy} again={again} />
    </FormDialog>
  );
}

/** A person by their name, their handle under it, linked to their page. Never by an address. */
export function PersonRow({
  member,
  side,
  menu,
}: {
  member: Member;
  side: ReactNode;
  menu?: ReactNode;
}) {
  const title = member.name === "" ? (member.handle ?? "A member") : member.name;
  return (
    <Row
      label={member.handle ?? member.name}
      avatar={<Avatar name={title} />}
      title={
        member.handle === undefined ? (
          <span className="font-semibold text-kumo-strong">{title}</span>
        ) : (
          <a
            className="a-link font-semibold"
            href={hrefOf({ at: "namespace", handle: member.handle })}
          >
            {title}
          </a>
        )
      }
      badges={member.you ? <Tag>You</Tag> : undefined}
      meta={member.handle === undefined ? undefined : `@${member.handle}`}
      side={side}
      menu={menu}
    />
  );
}

/** An agent: its name, its Agent badge, its handle (or, where Keel's row has none, its id), and its role. */
export function AgentRow({
  agent,
  members,
  menu,
}: {
  agent: NamespaceAgent;
  /** The org's members, to name who invited it; none where the list is not an org's. */
  members?: readonly Member[];
  menu?: ReactNode;
}) {
  return (
    <Row
      label={agent.handle ?? agent.name}
      avatar={<Avatar name={agent.name} agent />}
      title={<Named agent={agent} />}
      badges={<Tag>Agent</Tag>}
      meta={joined([
        agent.handle === undefined ? agent.id : `@${agent.handle}`,
        members === undefined ? undefined : inviterOf(agent, members),
        agent.state === "joined" ? standingOf(agent) : undefined,
      ])}
      side={givenOf(agent)}
      menu={menu}
    />
  );
}

/** An invitation to a person: who it is for, its role, its link to pass on, and its cancelling. */
function InvitationRow({ invitation, menu }: { invitation: Invitation; menu: ReactNode }) {
  const link = `${window.location.origin}${hrefOf({ at: "invite", id: invitation.id })}`;
  const [copied, setCopied] = useState(false);
  const to = invitation.to.includes("@") ? invitation.to : `@${invitation.to}`;
  return (
    <Row
      label={invitation.to}
      avatar={<Avatar name={invitation.to} />}
      title={<span className="font-semibold text-kumo-strong">{to}</span>}
      meta={
        <code className="a-mono text-xs" data-invitation-link>
          {link}
        </code>
      }
      side={
        <>
          <span>{ROLE_LABEL[invitation.role]}</span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </>
      }
      menu={menu}
    />
  );
}

export function People({
  account,
  agents,
  sponsorship,
  page,
  who,
  read,
}: {
  account: Account;
  agents: KeelOrgAgents;
  sponsorship: Pick<KeelSponsorship, "listSponsored">;
  page: OrgPage;
  who: Who;
  read: () => Promise<void>;
}) {
  const { org } = page;
  const listed = useListed(agents, org.handle);
  const sponsored = useSponsored(sponsorship);
  const { busy, refused, ask } = useAsking();
  const [typed, setTyped] = useState("");
  const [inviting, setInviting] = useState<"member" | "agent" | null>(null);
  /** What was last asked of Keel here: asked again, as it was, once the reader has signed in afresh. */
  const [last, setLast] = useState<{ asked: () => Promise<void> } | null>(null);

  const offered = givable(page.role);
  // An org is never left with no owner, so its only owner is offered no way out of it.
  const lastOwner =
    page.role === "owner" && page.members.filter((member) => member.role === "owner").length === 1;
  const move = (what: () => Promise<void>): Promise<void> => {
    const asked = async (): Promise<void> => {
      await what();
      await Promise.all([read(), listed.read()]);
    };
    setLast({ asked });
    return ask(asked);
  };
  const again = (): void =>
    void ask(async () => {
      const signedIn = await account.signInWithPasskey();
      // A passkey of another account signs that account in: the page is read again as whoever it is now.
      if (signedIn.id !== who.id) {
        window.location.assign(hrefOf({ at: "org", org: org.handle, tab: "members" }));
        return;
      }
      await last?.asked();
      setInviting(null);
    });
  const inviteAgent = async (handle: string, grant: Grant): Promise<boolean> => {
    let sent = false;
    await move(async () => {
      await agents.inviteAgent(org.handle, handle, SCOPES[grant]);
      sent = true;
    });
    return sent;
  };

  const agentsListed = listed.listed ?? [];
  const members = page.members.filter((member) => found(typed, member.handle, member.name));
  const inOrg = agentsListed.filter(
    (agent) => agent.state === "joined" && found(typed, agent.handle, agent.name),
  );
  const invitations = page.invitations.filter((invitation) => found(typed, invitation.to));
  const agentInvitations = agentsListed.filter(
    (agent) => agent.state === "invited" && found(typed, agent.handle, agent.name),
  );
  const agentMenu = (agent: NamespaceAgent): ReactNode => (
    <RowMenu
      label={`Actions for ${agent.handle ?? agent.name}`}
      disabled={busy}
      items={
        mayRemove(agent, page.role, who.id)
          ? [
              {
                label: removalOf(agent),
                danger: true,
                select: () =>
                  void move(async () => {
                    await agents.removeAgent(org.handle, agent.id);
                  }),
              },
            ]
          : []
      }
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex min-w-0 flex-1 basis-60 items-center">
          <MagnifyingGlassIcon
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-2.5 text-kumo-subtle"
          />
          <input
            type="search"
            aria-label="Find a member"
            placeholder="Find a member…"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base pr-2 pl-8 text-sm text-kumo-default placeholder:text-kumo-placeholder"
          />
        </label>
        <Button type="button" variant="secondary" onClick={() => setInviting("agent")}>
          Invite agent
        </Button>
        {manages(page.role) && (
          <Button type="button" variant="primary" onClick={() => setInviting("member")}>
            Invite member
          </Button>
        )}
      </div>

      <Box
        title="Members"
        count={page.members.length + agentsListed.filter((a) => a.state === "joined").length}
      >
        <Rows label="Members of this org">
          {members.map((member) => {
            // Nobody changes their own role here, and only an owner changes an owner's.
            const theirs = !member.you && offered.includes(member.role);
            const items: MenuItem[] = [];
            if (theirs)
              items.push({
                label: "Remove",
                danger: true,
                select: () => void move(() => account.removeMember(org, member)),
              });
            if (member.you && org.handle !== who.handle && !lastOwner)
              items.push({
                label: "Leave",
                danger: true,
                select: () =>
                  void ask(async () => {
                    await account.leave(org);
                    go(hrefOf({ at: "settings" }));
                  }),
              });
            return (
              <PersonRow
                key={member.id}
                member={member}
                side={
                  theirs ? (
                    <RoleSelect
                      label={`Role of ${member.handle ?? member.name}`}
                      value={member.role}
                      among={offered}
                      disabled={busy}
                      onChange={(role) => void move(() => account.setRole(org, member, role))}
                    />
                  ) : (
                    <span>{ROLE_LABEL[member.role]}</span>
                  )
                }
                menu={
                  <RowMenu
                    label={`Actions for ${member.handle ?? member.name}`}
                    disabled={busy}
                    items={items}
                  />
                }
              />
            );
          })}
          {inOrg.map((agent) => (
            <AgentRow key={agent.id} agent={agent} members={page.members} menu={agentMenu(agent)} />
          ))}
        </Rows>
      </Box>
      {listed.unread !== null && <Refusal said={listed.unread} />}
      {inviting === null && <Refused said={refused} busy={busy} again={again} />}

      {invitations.length + agentInvitations.length > 0 && (
        <Box title="Pending invitations" count={invitations.length + agentInvitations.length}>
          <Rows label="Invitations not yet answered">
            {invitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                menu={
                  <RowMenu
                    label={`Actions for the invitation to ${invitation.to}`}
                    disabled={busy}
                    items={
                      manages(page.role)
                        ? [
                            {
                              label: "Cancel invitation",
                              danger: true,
                              select: () =>
                                void move(() => account.cancelInvitation(invitation.id)),
                            },
                          ]
                        : []
                    }
                  />
                }
              />
            ))}
            {agentInvitations.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                members={page.members}
                menu={agentMenu(agent)}
              />
            ))}
          </Rows>
        </Box>
      )}

      {inviting === "member" && (
        <InviteMember account={account} page={page} close={() => setInviting(null)} done={read} />
      )}
      {inviting === "agent" && (
        <InviteAgent
          invite={inviteAgent}
          sponsored={sponsored}
          listed={agentsListed}
          busy={busy}
          refused={refused}
          again={again}
          close={() => setInviting(null)}
        />
      )}
    </div>
  );
}
