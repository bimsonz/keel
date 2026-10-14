// A namespace's own page, and an org's: its home, its members and its settings, making one, and an invitation
// to one. As on a code host, the address names a handle, and each page asks Keel about that handle and no
// other. Whose the handle is (a person's, an agent's or an org's) is Keel's to say, and the page is worded
// from its answer.

import { AgentAbout } from "./AgentAbout.tsx";
import { isOwn } from "./accounts.ts";
import { Button, Input, buttonVariants } from "@cloudflare/kumo";
import {
  BookBookmarkIcon,
  BookOpenIcon,
  GearIcon,
  type Icon,
  KeyIcon,
  UsersIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { TabBar, TabFace, TabSlot } from "../views/TabBar.tsx";
import { hrefOf } from "../places.ts";
import { TRUNK, href } from "../route.ts";
import type {
  NamespaceKind,
  NamespaceRef,
  NamespaceView,
  ProjectView,
} from "../contract/keel/index.ts";
import type {
  KeelCredentials,
  KeelDirectory,
  KeelOrgAgents,
  KeelSponsorship,
} from "../source/types.ts";
import {
  type Account,
  type Closed,
  type Invitation,
  type Invited,
  type Member,
  type Org,
  type OrgPage,
  type Who,
  nameOf,
} from "./account.ts";
import { NamespaceCredentials } from "./Credentials.tsx";
import { JoinedAgents, OrgAgents } from "./OrgAgents.tsx";
import { Card, HANDLE, Refusal, SELECT, go, useAsking } from "./parts.tsx";
import { ROLES, type Role, givable, manages, mayDelete } from "./roles.ts";
import { type NamespaceTab, TAB_LABEL, tabHref, tabsOf } from "./namespaceTabs.ts";

/** What a page calls a namespace that is not a person's. */
const KIND: Record<Exclude<NamespaceKind, "user">, string> = { agent: "Agent", org: "Org" };

/** What a namespace's page says where Keel names this reader no project of it, and they may make none there. */
function none(namespace: NamespaceRef): string {
  return `${namespace.kind === "org" ? "This organization" : namespace.handle} has no public projects.`;
}

/** What a page calls a namespace's tab bar, by its kind. */
const TABS_OF: Record<NamespaceKind, string> = { user: "Account", agent: "Agent", org: "Org" };

/** Each tab's icon, as a code host marks an owner's sections. */
const TAB_ICON: Record<NamespaceTab, Icon> = {
  overview: BookOpenIcon,
  projects: BookBookmarkIcon,
  orgs: UsersThreeIcon,
  people: UsersIcon,
  credentials: KeyIcon,
  settings: GearIcon,
};

/**
 * A namespace's own sections, in the bar under the header that a project's places are in: the same bar, drawn in
 * the header's place for it. Each is a link, the one open marked.
 */
function NamespaceTabs({
  handle,
  kind,
  tabs,
  open,
  counts,
}: {
  handle: string;
  kind: NamespaceKind;
  tabs: readonly NamespaceTab[];
  open: NamespaceTab;
  /** How many each tab holds, where Keel has said. */
  counts: Partial<Record<NamespaceTab, number>>;
}) {
  const slot = useContext(TabSlot);
  if (slot === null) return null;
  return createPortal(
    <TabBar label={TABS_OF[kind]}>
      {tabs.map((tab) => (
        <a
          key={tab}
          href={tabHref(handle, kind, tab)}
          aria-current={tab === open ? "page" : undefined}
        >
          <TabFace
            Icon={TAB_ICON[tab]}
            label={TAB_LABEL[tab]}
            open={tab === open}
            count={
              counts[tab] === undefined ? undefined : (
                <span className="a-count">{counts[tab].toLocaleString("en-US")}</span>
              )
            }
          />
        </a>
      ))}
    </TabBar>,
    slot,
  );
}

/**
 * A namespace's projects where Keel names this reader none. Whoever may make one there (the person whose account
 * it is, or any member of an org, as Keel allows) is offered the two ways to start one and the quickstart; anyone
 * else is told there is none to see.
 */
function NoProjects({
  namespace,
  may,
  signedIn,
}: {
  namespace: NamespaceRef;
  may: boolean;
  signedIn: boolean;
}) {
  if (may)
    return (
      <div className="flex flex-col items-start gap-3 py-2" data-part="no-projects">
        <p className="text-base font-semibold text-kumo-strong">No projects yet</p>
        <div className="flex flex-wrap gap-2">
          <a
            className={buttonVariants({ variant: "primary" })}
            href={hrefOf({ at: "new-project", owner: namespace.handle })}
          >
            New project
          </a>
          <a
            className={buttonVariants({ variant: "secondary" })}
            href={hrefOf({ at: "new-project", owner: namespace.handle, start: "import" })}
          >
            Import a repository
          </a>
        </div>
        <a className="a-link text-sm" href="/start">
          Read the quickstart
        </a>
      </div>
    );
  return (
    <p className="text-sm text-kumo-subtle">
      {none(namespace)}
      {!signedIn && (
        <>
          {" "}
          <a className="a-link" href={hrefOf({ at: "login" }, `/${namespace.handle}`)}>
            Sign in
          </a>{" "}
          to see what you may.
        </>
      )}
    </p>
  );
}

/** A namespace's projects, as Keel names them to this reader, or the way to start one where there are none. */
function ProjectsPanel({
  namespace,
  projects,
  may,
  signedIn,
}: {
  namespace: NamespaceRef;
  projects: readonly ProjectView[] | undefined;
  may: boolean;
  signedIn: boolean;
}) {
  return (
    <section className="a-panel flex flex-col gap-2 p-4" aria-label="Projects">
      <h2 className="a-h">Projects</h2>
      {projects !== undefined &&
        (projects.length === 0 ? (
          <NoProjects namespace={namespace} may={may} signedIn={signedIn} />
        ) : (
          <>
            <ProjectList projects={projects} />
            {may && (
              <a
                className="a-link self-start text-sm"
                href={hrefOf({ at: "new-project", owner: namespace.handle })}
              >
                New project
              </a>
            )}
          </>
        ))}
    </section>
  );
}

/** An org as Keel reads it to this reader: undefined while it is asked for, null where there is none for them. */
function useOrg(
  account: Account,
  handle: string,
  who: Who,
): { held: OrgPage | null | undefined; read: () => Promise<void> } {
  const [held, setHeld] = useState<OrgPage | null>();
  const read = useCallback(
    async () => setHeld(await account.org(handle, who)),
    [account, handle, who],
  );
  useEffect(() => {
    let here = true;
    const first = async (): Promise<void> => {
      const answer = await account.org(handle, who);
      if (here) setHeld(answer);
    };
    void first();
    return () => {
      here = false;
    };
  }, [account, handle, who]);
  return { held, read };
}

function RoleSelect({
  label,
  value,
  among,
  disabled,
  onChange,
}: {
  label: string;
  value: Role;
  among: Role[];
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
          {role}
        </option>
      ))}
    </select>
  );
}

/** A person as a code host names one: by handle, with their name beside it. Never by an address. */
function Person({ member }: { member: Member }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="font-semibold text-kumo-strong">
        {member.handle ?? (member.name === "" ? "A member" : member.name)}
      </span>
      {member.handle !== undefined && member.name !== "" && member.name !== member.handle && (
        <span className="truncate text-sm text-kumo-subtle">{member.name}</span>
      )}
      {member.you && <span className="text-sm text-kumo-subtle">you</span>}
    </span>
  );
}

function OrgFrame({
  page,
  tab,
  projects,
  children,
}: {
  page: OrgPage;
  tab: NamespaceTab;
  projects: readonly ProjectView[] | undefined;
  children: ReactNode;
}) {
  const { org } = page;
  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-3 text-[22px] font-semibold text-kumo-strong">
          {org.name}
          <span className="a-chip" data-tone="quiet">
            {page.role}
          </span>
        </h1>
        <p className="a-mono text-sm text-kumo-subtle">{org.handle}</p>
      </header>
      {/* An org's credentials are its owners' alone, and its settings an owner's or a maintainer's: Keel says whose. */}
      <NamespaceTabs
        handle={org.handle}
        kind="org"
        tabs={tabsOf({ kind: "org", own: false, role: page.role })}
        open={tab}
        counts={{
          people: page.members.length,
          ...(projects === undefined ? {} : { projects: projects.length }),
        }}
      />
      {children}
    </div>
  );
}

/** The projects of a namespace that Keel names to this reader: undefined until it has answered. */
function useProjects(
  directory: KeelDirectory,
  namespace: string,
): readonly ProjectView[] | undefined {
  const [projects, setProjects] = useState<readonly ProjectView[]>();
  useEffect(() => {
    let here = true;
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      // A list Keel would not give is no list: the page says there is nothing to show.
      const listed = await directory.listProjects(stop.signal).catch(() => []);
      if (here) setProjects(listed.filter((project) => project.namespace.handle === namespace));
    };
    void read();
    return () => {
      here = false;
      stop.abort();
    };
  }, [directory, namespace]);
  return projects;
}

/**
 * Whose a handle is, as Keel answers anyone who asks: undefined until it has, null where nobody has the handle,
 * and Keel's own words where it would not say.
 */
function useNamespace(
  directory: KeelDirectory,
  handle: string,
): NamespaceView | { failed: string } | null | undefined {
  const [namespace, setNamespace] = useState<NamespaceView | { failed: string } | null>();
  useEffect(() => {
    let here = true;
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const found = await directory.findNamespace(handle, stop.signal);
        if (here) setNamespace(found);
      } catch (error) {
        if (here)
          setNamespace({ failed: error instanceof Error ? error.message : "Keel did not answer" });
      }
    };
    void read();
    return () => {
      here = false;
      stop.abort();
    };
  }, [directory, handle]);
  return namespace;
}

function ProjectList({ projects }: { projects: readonly ProjectView[] }) {
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Projects">
      {projects.map((project) => (
        <li key={project.id} className="flex items-center justify-between gap-3 text-sm">
          <a
            className="font-semibold text-kumo-strong hover:underline"
            href={href(project.namespace.handle, project.name, {
              at: "code",
              kind: "tree",
              ref: TRUNK,
              path: "",
            })}
          >
            {project.name}
          </a>
          <span className="a-chip" data-tone="quiet">
            {project.visibility}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Home({
  page,
  projects,
  agents,
}: {
  page: OrgPage;
  projects: readonly ProjectView[] | undefined;
  agents: KeelOrgAgents;
}) {
  return (
    <>
      {/* Keel lets any member of an org make a project in it, and says so where it refuses. */}
      <ProjectsPanel
        namespace={{ handle: page.org.handle, kind: "org" }}
        projects={projects}
        may
        signedIn
      />
      <section className="a-panel flex flex-col gap-3 p-4" aria-label="Members">
        <h2 className="a-h">Members</h2>
        <ul className="flex flex-col gap-1.5">
          {page.members.map((member) => (
            <li key={member.id} className="flex items-center justify-between gap-3 text-sm">
              <Person member={member} />
              <span className="text-kumo-subtle">{member.role}</span>
            </li>
          ))}
        </ul>
        <a
          className="a-link self-start text-sm"
          href={hrefOf({ at: "org", org: page.org.handle, tab: "members" })}
        >
          Members and invitations
        </a>
      </section>
      <JoinedAgents agents={agents} org={page.org.handle} />
    </>
  );
}

/** An invitation's own address, which whoever made it passes on: Keel sends no email yet. */
function InvitationRow({
  invitation,
  cancel,
}: {
  invitation: Invitation;
  cancel?: (() => void) | undefined;
}) {
  const link = `${window.location.origin}${hrefOf({ at: "invite", id: invitation.id })}`;
  const [copied, setCopied] = useState(false);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
      <span className="flex items-baseline gap-2">
        <span className="font-semibold text-kumo-strong">{invitation.to}</span>
        <span className="text-kumo-subtle">invited as {invitation.role}</span>
      </span>
      <span className="flex items-center gap-3">
        <code className="a-mono text-kumo-default" data-invitation-link>
          {link}
        </code>
        <button
          type="button"
          className="a-link"
          onClick={() => {
            void navigator.clipboard.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        {cancel !== undefined && (
          <button type="button" className="a-link" onClick={cancel}>
            Withdraw
          </button>
        )}
      </span>
    </li>
  );
}

function InviteForm({
  account,
  page,
  done,
}: {
  account: Account;
  page: OrgPage;
  done: () => Promise<void>;
}) {
  const [by, setBy] = useState<"handle" | "email">("handle");
  const [to, setTo] = useState("");
  const [role, setRole] = useState<Role>("member");
  const { busy, refused, ask } = useAsking();
  const invite = (event: FormEvent) => {
    event.preventDefault();
    void ask(async () => {
      const typed = to.trim();
      await account.invite(page.org, by === "handle" ? { handle: typed } : { email: typed }, role);
      setTo("");
      await done();
    });
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={invite}>
      <div className="flex flex-wrap items-end gap-2">
        <Input
          label={by === "handle" ? "Invite by handle" : "Invite by email"}
          name={by}
          type={by === "handle" ? "text" : "email"}
          autoCapitalize="none"
          spellCheck={false}
          required
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
        <RoleSelect
          label="Role for the invitation"
          value={role}
          among={givable(page.role)}
          disabled={busy}
          onChange={setRole}
        />
        <Button type="submit" variant="secondary" disabled={busy}>
          Invite
        </Button>
      </div>
      <button
        type="button"
        className="a-link self-start text-sm"
        onClick={() => {
          setBy(by === "handle" ? "email" : "handle");
          setTo("");
        }}
      >
        {by === "handle" ? "Invite by email instead" : "Invite by handle instead"}
      </button>
      <Refusal said={refused} />
    </form>
  );
}

function Members({
  account,
  agents,
  page,
  who,
  read,
}: {
  account: Account;
  agents: KeelOrgAgents;
  page: OrgPage;
  who: Who;
  read: () => Promise<void>;
}) {
  const { busy, refused, ask } = useAsking();
  const { org } = page;
  const offered = givable(page.role);
  // An org is never left with no owner, so its only owner is offered no way out of it.
  const lastOwner =
    page.role === "owner" && page.members.filter((member) => member.role === "owner").length === 1;
  const change = (what: () => Promise<void>) =>
    void ask(async () => {
      await what();
      await read();
    });
  return (
    <>
      <section className="a-panel flex flex-col gap-3 p-4" aria-label="Members">
        <h2 className="a-h">Members</h2>
        <ul className="flex flex-col gap-2" aria-label="Members of this org">
          {page.members.map((member) => {
            // Nobody changes their own role here, and only an owner changes an owner's.
            const theirs = !member.you && offered.includes(member.role);
            return (
              <li key={member.id} className="flex items-center justify-between gap-3 text-sm">
                <Person member={member} />
                <span className="flex items-center gap-3">
                  {theirs ? (
                    <RoleSelect
                      label={`Role of ${member.handle ?? member.name}`}
                      value={member.role}
                      among={offered}
                      disabled={busy}
                      onChange={(role) => change(() => account.setRole(org, member, role))}
                    />
                  ) : (
                    <span className="text-kumo-subtle">{member.role}</span>
                  )}
                  {theirs && (
                    <button
                      type="button"
                      className="a-link"
                      disabled={busy}
                      onClick={() => change(() => account.removeMember(org, member))}
                    >
                      Remove
                    </button>
                  )}
                  {member.you && org.handle !== who.handle && !lastOwner && (
                    <button
                      type="button"
                      className="a-link"
                      disabled={busy}
                      onClick={() =>
                        void ask(async () => {
                          await account.leave(org);
                          go(hrefOf({ at: "settings" }));
                        })
                      }
                    >
                      Leave
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <Refusal said={refused} />
      </section>
      <section className="a-panel flex flex-col gap-3 p-4" aria-label="Invitations">
        <h2 className="a-h">Invitations</h2>
        {manages(page.role) ? (
          <>
            <p className="text-sm text-kumo-subtle">
              Keel sends no email yet. An invitation has a link: pass it to the person it is for,
              and it is theirs alone to accept.
            </p>
            <InviteForm account={account} page={page} done={read} />
          </>
        ) : (
          <p className="text-sm text-kumo-subtle">An owner or a maintainer invites people.</p>
        )}
        {page.invitations.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="Invitations not yet answered">
            {page.invitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                cancel={
                  manages(page.role)
                    ? () => change(() => account.cancelInvitation(invitation.id))
                    : undefined
                }
              />
            ))}
          </ul>
        )}
      </section>
      <OrgAgents account={account} agents={agents} page={page} who={who} />
    </>
  );
}

function OrgSettings({
  account,
  page,
  read,
}: {
  account: Account;
  page: OrgPage;
  read: () => Promise<void>;
}) {
  const { org } = page;
  const [name, setName] = useState(org.name);
  const [typed, setTyped] = useState("");
  const { busy, refused, ask } = useAsking();
  if (!manages(page.role))
    return (
      <section className="a-panel p-4">
        <p className="text-sm text-kumo-subtle">
          An owner or a maintainer changes an org's settings.
        </p>
      </section>
    );
  return (
    <>
      <section className="a-panel flex flex-col gap-3 p-4" aria-label="Name">
        <h2 className="a-h">Name</h2>
        <p className="text-sm text-kumo-subtle">
          The handle, <span className="a-mono text-kumo-default">{org.handle}</span>, is in every
          address under this org and does not change.
        </p>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(async () => {
              await account.renameOrg(org, name.trim());
              await read();
            });
          }}
        >
          <Input
            label="Name"
            name="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={busy || name.trim() === org.name}>
            Rename
          </Button>
        </form>
      </section>
      <section className="a-panel flex flex-col gap-3 p-4" aria-label="Delete this org">
        <h2 className="a-h">Delete this org</h2>
        {page.role === "owner" ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!mayDelete(org, { role: page.role }, typed)) return;
              void ask(async () => {
                await account.deleteOrg(org);
                go(hrefOf({ at: "settings" }));
              });
            }}
          >
            <Input
              label={`Type ${org.handle} to delete it, with its members and invitations`}
              name="confirm"
              autoCapitalize="none"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={busy || !mayDelete(org, { role: page.role }, typed)}
            >
              Delete this org
            </Button>
          </form>
        ) : (
          <p className="text-sm text-kumo-subtle">Only an owner deletes an org.</p>
        )}
      </section>
      <Refusal said={refused} />
    </>
  );
}

/**
 * A namespace as anyone may see it: its handle, whose Keel says it is, and the projects of it that Keel names
 * to this reader. For a visitor those are its public ones. That a handle is someone's is no secret, so one with
 * no project to show is still there, and a page says so; a handle nobody has is told as that.
 */
export function NamespacePublic({
  directory,
  sponsorship,
  agents,
  handle,
  signedIn,
  tab = "overview",
}: {
  directory: KeelDirectory;
  sponsorship: KeelSponsorship;
  agents: KeelOrgAgents;
  handle: string;
  signedIn: boolean;
  /** Which of the namespace's tabs is open: its overview, or its projects. */
  tab?: NamespaceTab;
}) {
  const namespace = useNamespace(directory, handle);
  const projects = useProjects(directory, handle);
  if (namespace === undefined || projects === undefined) return null;
  if (namespace === null)
    return (
      <Card
        title={`There is no ${handle} here`}
        lede={`Nobody and no org is called ${handle} on this Keel.`}
      >
        <a className="a-link" href="/">
          See the projects Keel has
        </a>
      </Card>
    );
  if ("failed" in namespace)
    return (
      <Card title={`Keel did not say whose ${handle} is`} lede={`${namespace.failed}.`}>
        <a className="a-link" href="/">
          See the projects Keel has
        </a>
      </Card>
    );
  const open = tab === "projects" ? "projects" : "overview";
  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-6 py-8">
      <header className="flex flex-wrap items-center gap-2.5">
        <h1 className="text-[22px] font-semibold text-kumo-strong">{namespace.handle}</h1>
        {/* A person's handle is their account and needs no label; an agent's and an org's are named as that. */}
        {namespace.kind !== "user" && (
          <span className="a-chip" data-tone="quiet">
            {KIND[namespace.kind]}
          </span>
        )}
      </header>
      <NamespaceTabs
        handle={namespace.handle}
        kind={namespace.kind}
        tabs={tabsOf({ kind: namespace.kind, own: false })}
        open={open}
        counts={{ projects: projects.length }}
      />
      {/* An agent's handle is its own namespace: its page is what Keel shows anyone of the agent. */}
      {open === "overview" && namespace.kind === "agent" && (
        <AgentAbout sponsorship={sponsorship} agentId={namespace.id} signedIn={signedIn} />
      )}
      <ProjectsPanel namespace={namespace} projects={projects} may={false} signedIn={signedIn} />
      {/* Keel reads anyone the agents that have joined an org. No other kind of namespace has any. */}
      {open === "overview" && namespace.kind === "org" && (
        <JoinedAgents agents={agents} org={namespace.handle} />
      )}
    </div>
  );
}

/**
 * A person's own namespace, to that person: their projects, under their handle, their orgs and their settings
 * beside them. It is their account and no org: it has no members to manage and no settings of an org's, and the
 * page never calls it one.
 */
function Own({
  directory,
  who,
  tab,
  orgs,
}: {
  directory: KeelDirectory;
  who: Who;
  tab: NamespaceTab;
  /** The orgs Keel lists this person in: null until it has. */
  orgs: readonly Org[] | null;
}) {
  const handle = who.handle ?? "";
  const projects = useProjects(directory, handle);
  if (tab !== "overview" && tab !== "projects" && tab !== "orgs")
    return (
      <Card
        title="This is your own account"
        lede={`${handle} is yours alone: it has no members and is not an org. An org is for projects you work on with other people.`}
      >
        <a className="a-link" href={hrefOf({ at: "namespace", handle })}>
          Your projects
        </a>
        <a className="a-link" href={hrefOf({ at: "new-org" })}>
          Make an org
        </a>
      </Card>
    );
  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] font-semibold text-kumo-strong">{handle}</h1>
        <p className="text-sm text-kumo-subtle">Your account</p>
      </header>
      <NamespaceTabs
        handle={handle}
        kind="user"
        tabs={tabsOf({ kind: "user", own: true })}
        open={tab}
        counts={{
          ...(projects === undefined ? {} : { projects: projects.length }),
          ...(orgs === null ? {} : { orgs: orgs.length }),
        }}
      />
      {tab === "orgs" ? (
        <section className="a-panel flex flex-col gap-2 p-4" aria-label="Organizations">
          <h2 className="a-h">Organizations</h2>
          {orgs !== null &&
            (orgs.length === 0 ? (
              <p className="text-sm text-kumo-subtle">You are in no organization.</p>
            ) : (
              <ul className="flex flex-col gap-1.5" aria-label="Your organizations">
                {orgs.map((org) => (
                  <li key={org.id} className="flex items-center justify-between gap-3 text-sm">
                    <a
                      className="font-semibold text-kumo-strong hover:underline"
                      href={hrefOf({ at: "namespace", handle: org.handle })}
                    >
                      {org.handle}
                    </a>
                    {org.name !== org.handle && (
                      <span className="text-kumo-subtle">{org.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            ))}
          <a className="a-link self-start text-sm" href={hrefOf({ at: "new-org" })}>
            New organization
          </a>
        </section>
      ) : (
        <ProjectsPanel namespace={{ handle, kind: "user" }} projects={projects} may signedIn />
      )}
    </div>
  );
}

/**
 * The pages at a handle, to someone signed in. Their own handle is their account. Another's is what anyone may
 * see of that namespace, unless it is an org they are a member of: then it is the org's home, and its people
 * and settings beside it. To anyone else an org's members' pages are told as an org that is not there.
 */
export function NamespacePages({
  account,
  directory,
  sponsorship,
  agents,
  credentials,
  who,
  handle,
  tab,
  orgs,
}: {
  account: Account;
  directory: KeelDirectory;
  sponsorship: KeelSponsorship;
  agents: KeelOrgAgents;
  credentials: KeelCredentials;
  who: Who;
  handle: string;
  tab: NamespaceTab;
  /** The orgs Keel lists the reader in: null until it has. */
  orgs: readonly Org[] | null;
}) {
  const { held, read } = useOrg(account, handle, who);
  const projects = useProjects(directory, handle);
  // A person needs no org: their own handle is their account, and reads as that.
  if (isOwn({ handle }, who)) return <Own directory={directory} who={who} tab={tab} orgs={orgs} />;
  if (held === undefined) return null;
  if (held === null && (tab === "overview" || tab === "projects" || tab === "orgs"))
    return (
      <NamespacePublic
        directory={directory}
        sponsorship={sponsorship}
        agents={agents}
        handle={handle}
        signedIn
        tab={tab}
      />
    );
  if (held === null)
    return (
      <Card
        title={`There is no org ${handle} here`}
        lede={`Either there is no org called ${handle} on this Keel, or you are not a member of it.`}
      >
        <a className="a-link" href={hrefOf({ at: "new-org" })}>
          Make an org
        </a>
      </Card>
    );
  const open = tab === "orgs" ? "overview" : tab;
  return (
    <OrgFrame page={held} tab={open} projects={projects}>
      {open === "overview" && <Home page={held} projects={projects} agents={agents} />}
      {open === "projects" && (
        <ProjectsPanel
          namespace={{ handle: held.org.handle, kind: "org" }}
          projects={projects}
          may
          signedIn
        />
      )}
      {open === "people" && (
        <Members account={account} agents={agents} page={held} who={who} read={read} />
      )}
      {open === "credentials" && (
        <NamespaceCredentials
          credentials={credentials}
          handle={held.org.handle}
          readerId={who.id}
          owner={held.role === "owner"}
          whose={`${held.org.handle}'s`}
        />
      )}
      {open === "settings" && (
        // The name typed starts from the org's own, whichever org the address goes on to name.
        <OrgSettings key={held.org.id} account={account} page={held} read={read} />
      )}
    </OrgFrame>
  );
}

export function NewOrg({ account }: { account: Account }) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [taken, setTaken] = useState(false);
  const { busy, refused, ask } = useAsking();
  const wellFormed = HANDLE.test(handle);
  const make = (event: FormEvent) => {
    event.preventDefault();
    void ask(async () => {
      if (!(await account.orgHandleIsFree(handle))) {
        setTaken(true);
        return;
      }
      const org: Org = await account.createOrg(name.trim(), handle);
      go(hrefOf({ at: "namespace", handle: org.handle }));
    });
  };
  return (
    <Card
      title="Make an org"
      lede="An org holds projects and the people who work on them. You will be its owner."
    >
      <form className="flex flex-col gap-3" onSubmit={make}>
        <Input
          label="Name"
          name="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          label="Handle"
          name="handle"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={handle}
          description={`${window.location.host}/${handle === "" ? "its-handle" : handle}`}
          {...(taken
            ? { error: "That handle is taken." }
            : handle !== "" && !wellFormed
              ? {
                  error:
                    "Lower-case letters, digits and single hyphens, and no hyphen at either end.",
                }
              : {})}
          onChange={(event) => {
            setTaken(false);
            setHandle(event.target.value.toLowerCase());
          }}
        />
        <Button
          className="w-full justify-center"
          type="submit"
          variant="primary"
          disabled={busy || !wellFormed || name.trim() === ""}
        >
          Make the org
        </Button>
      </form>
      <Refusal said={refused} />
    </Card>
  );
}

/** An invitation, opened by whoever has its link. Keel reads it only to the person it was made to. */
export function Invite({ account, who, id }: { account: Account; who: Who; id: string }) {
  const [invited, setInvited] = useState<Invited | Closed | null>();
  const [declined, setDeclined] = useState(false);
  const { busy, refused, ask } = useAsking();
  useEffect(() => {
    let here = true;
    const read = async (): Promise<void> => {
      const answer = await account.invitation(id);
      if (here) setInvited(answer);
    };
    void read();
    return () => {
      here = false;
    };
  }, [account, id]);
  if (invited === undefined) return null;
  if (declined)
    return (
      <Card title="Invitation declined" lede="Nothing was joined. The link is of no more use.">
        {null}
      </Card>
    );
  if (invited === null)
    return (
      <Card
        title="This invitation is not open to you"
        lede={`It was made to someone else, or Keel holds no such invitation. You are signed in as ${nameOf(who)}.`}
      >
        {null}
      </Card>
    );
  // Keel tells the person it was made to what became of it, and the page says that in Keel's words.
  if ("closed" in invited)
    return (
      <Card
        title={
          invited.closed === "answered"
            ? "This invitation has been answered"
            : "This invitation has lapsed"
        }
        lede={invited.said}
      >
        {null}
      </Card>
    );
  return (
    <Card
      title={`Join ${invited.org.name}?`}
      lede={`${invited.by === undefined ? "You are invited" : `${invited.by} invites you`} to the org ${invited.org.handle} on this Keel, as ${invited.role === "owner" ? "an owner" : `a ${invited.role}`}. You would join as ${nameOf(who)}.`}
    >
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={busy}
          onClick={() =>
            void ask(async () => {
              await account.acceptInvitation(invited.id);
              go(hrefOf({ at: "namespace", handle: invited.org.handle }));
            })
          }
        >
          Join
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void ask(async () => {
              await account.declineInvitation(invited.id);
              setDeclined(true);
            })
          }
        >
          Decline
        </Button>
      </div>
      <Refusal said={refused} />
    </Card>
  );
}
