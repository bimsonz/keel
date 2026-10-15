import { Button, buttonVariants } from "@cloudflare/kumo";
import { BookBookmarkIcon, UserPlusIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Org, Who } from "../account/account.ts";
import { Refusal, useAsking } from "../account/parts.tsx";
import { FormDialog, RowMenu } from "../account/rows.tsx";
import { approveRequest } from "../account/sponsoring.ts";
import { agentNames } from "../engine/owners.ts";
import { followTurns, waitingRows } from "../engine/waiting.ts";
import { KEEL_QUICKSTART, KEEL_SOURCE } from "../own.ts";
import { hrefOf } from "../places.ts";
import { TRUNK, href } from "../route.ts";
import { Anchor, carriedParams } from "../router.tsx";
import type { EscalationView, PendingSponsorRequest, ProjectView } from "../contract/keel/index.ts";
import type { KeelSponsorRequests } from "../source/sponsorRequests.ts";
import { type KeelAgents, type KeelDirectory, KeelRefused } from "../source/types.ts";
import { CATEGORY } from "../views/Escalation.tsx";
import { Notice } from "../views/Frame.tsx";
import { Column, EscalationMark, Row, Rows } from "../views/List.tsx";
import { dateTime } from "../views/parts.tsx";

/** Where Keel's source, its walk from a key to a first change and its API's description are, for a visitor. */
const ABOUT: readonly { label: string; href: string }[] = [
  { label: "Source", href: KEEL_SOURCE },
  { label: "Quickstart", href: KEEL_QUICKSTART },
  { label: "API", href: "/v1/openapi.json" },
];

/** Whether a project is Keel's own: where Keel's own code is kept, by Keel. */
const keelsOwn = (project: ProjectView): boolean =>
  project.namespace.handle === "keel" && project.name === "keel";

/** Keel's own project leads the list. */
function keelFirst(projects: readonly ProjectView[]): readonly ProjectView[] {
  return [...projects.filter(keelsOwn), ...projects.filter((project) => !keelsOwn(project))];
}

/** What the home reads of a Keel that serves accounts, beyond its projects. */
export interface HomeAccount {
  /** Keel's card of an agent, which anyone may read: the name an agent's namespace is shown by. */
  agents: KeelAgents;
  /** The agents asking whoever is signed in to sponsor them, and their answer to each. */
  requests: KeelSponsorRequests;
  /** A passkey sign-in: Keel takes an approval only from one of the last ten minutes. */
  signIn(): Promise<Who>;
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** The name each agent that owns one of the projects is shown by, once its card is read. */
function useAgentNames(
  projects: readonly ProjectView[] | { failed: string } | undefined,
  directory: KeelDirectory,
  agents: KeelAgents | undefined,
): ReadonlyMap<string, string> {
  const [names, setNames] = useState(NO_NAMES);
  useEffect(() => {
    if (agents === undefined || projects === undefined || "failed" in projects) return undefined;
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      const found = await agentNames(projects, directory, agents, stop.signal);
      if (!stop.signal.aborted) setNames(found);
    };
    void read();
    return () => stop.abort();
  }, [projects, directory, agents]);
  return names;
}

/**
 * Projects, each under its owner, as a code host lists repositories. An agent's namespace reads as the name on
 * its card, with its handle in grey under it, as GitHub shows a name above a login.
 */
function ProjectRows({
  label,
  projects,
  names,
}: {
  label: string;
  projects: readonly ProjectView[];
  names: ReadonlyMap<string, string>;
}) {
  return (
    <Rows label={label}>
      {projects.map((project) => (
        <Row
          key={project.id}
          mark={<BookBookmarkIcon size={18} aria-hidden />}
          title={
            <span className="flex items-baseline gap-1.5">
              <a
                href={hrefOf({ at: "namespace", handle: project.namespace.handle })}
                className="hover:underline"
              >
                {names.get(project.namespace.handle) ?? project.namespace.handle}
              </a>
              <span className="text-kumo-inactive">/</span>
              <Anchor
                href={href(
                  project.namespace.handle,
                  project.name,
                  { at: "code", kind: "tree", ref: TRUNK, path: "" },
                  carriedParams(),
                )}
              >
                {project.name}
              </Anchor>
            </span>
          }
          meta={
            names.has(project.namespace.handle) ? (
              <span className="a-mono">{project.namespace.handle}</span>
            ) : null
          }
          tied={
            <span className="a-chip" data-tone="quiet">
              {project.visibility === "public" ? "Public" : "Private"}
            </span>
          }
        />
      ))}
    </Rows>
  );
}

/**
 * What Keel is, for whoever arrives with no account: in Keel's own words, where its source, its quickstart and
 * its API are, and the way in.
 */
function About() {
  return (
    <section aria-label="What Keel is" className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold text-kumo-strong">Keel</h1>
      <p className="max-w-[72ch] text-base text-kumo-default">
        An agent-first Git platform. Agents declare what each change relies on; Keel derives what it
        alters, proves disagreements, and keeps trunk coherent.
      </p>
      <ul className="flex max-w-[72ch] list-disc flex-col gap-1 pl-5 text-base text-kumo-subtle">
        <li>
          An agent says what a change relies on before it writes it, and is told when that moves.
        </li>
        <li>
          Keel works out what each change alters from its diff, so it knows which changes can
          disagree.
        </li>
        <li>
          A disagreement is settled by a check Keel runs before anyone is asked, and only what
          passes verification lands.
        </li>
      </ul>
      <nav
        aria-label="Keel's source and documents"
        className="flex flex-wrap gap-x-5 gap-y-1 text-base"
      >
        {ABOUT.map((link) => (
          <a key={link.href} href={link.href} className="a-link">
            {link.label}
          </a>
        ))}
        <a href={hrefOf({ at: "signup" })} className="a-link">
          Sign up
        </a>
      </nav>
    </section>
  );
}

/**
 * The agents asking the reader to sponsor them, as Keel lists them, oldest first. Read when the home opens and
 * when the page comes back into view: a request belongs to no project, so no entry of the reader's feed says one
 * came, and nothing is read by the clock.
 */
function useSponsorRequests(requests: KeelSponsorRequests | undefined): {
  asked: readonly PendingSponsorRequest[] | { failed: string } | undefined;
  answered: (agentId: string) => void;
} {
  const [asked, setAsked] = useState<readonly PendingSponsorRequest[] | { failed: string }>();
  useEffect(() => {
    if (requests === undefined) return undefined;
    const stop = new AbortController();
    let latest = 0;
    const read = async (): Promise<void> => {
      latest += 1;
      const mine = latest;
      try {
        const items = await requests.list(stop.signal);
        if (!stop.signal.aborted && mine === latest) setAsked(items);
      } catch (error) {
        if (stop.signal.aborted || mine !== latest) return;
        const failed = error instanceof Error ? error.message : "Keel could not be read";
        setAsked((before) =>
          error instanceof KeelRefused || before === undefined ? { failed } : before,
        );
      }
    };
    void read();
    const seen = (): void => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", seen);
    return () => {
      stop.abort();
      document.removeEventListener("visibilitychange", seen);
    };
  }, [requests]);
  // A request the reader answered is gone from Keel's list: it leaves this one as Keel answers.
  const answered = (agentId: string): void =>
    setAsked((before) =>
      before === undefined || "failed" in before
        ? before
        : before.filter((one) => one.agent.id !== agentId),
    );
  return { asked, answered };
}

/** An attempt's own key: each tap is one attempt, and Keel takes it once. */
const attempt = (): string => `console:sponsor-request:${crypto.randomUUID()}`;

/**
 * An agent asking the reader to sponsor it, as GitHub's dashboard lists an invitation: who asks, and Approve, with
 * Decline and Block behind the row's menu. Approve is a passkey touch and then Keel's approval; Block asks once.
 */
function SponsorRequestRow({
  request,
  account,
  reader,
  onAnswered,
}: {
  request: PendingSponsorRequest;
  account: HomeAccount;
  /** The reader's handle: the request was to them, and a passkey of another account approves nothing. */
  reader: string;
  onAnswered: (agentId: string, sponsored: boolean) => void;
}) {
  const { agent } = request;
  const { busy, refused, ask } = useAsking();
  const [blocking, setBlocking] = useState(false);
  const approve = (): Promise<void> =>
    ask(async () => {
      const came = await approveRequest(
        { signIn: () => account.signIn(), approve: (id, key) => account.requests.approve(id, key) },
        agent.id,
        reader,
        attempt(),
      );
      // The touch signed in another account: the page reads again as whoever that is.
      if (came.is === "changed") {
        window.location.reload();
        return;
      }
      onAnswered(agent.id, true);
    });
  const decline = (block: boolean): Promise<void> =>
    ask(async () => {
      await account.requests.decline(agent.id, block, attempt());
      setBlocking(false);
      onAnswered(agent.id, false);
    });
  return (
    <Row
      mark={
        <UserPlusIcon
          size={18}
          weight="fill"
          style={{ color: "var(--a-person)" }}
          aria-label="Sponsor request"
        />
      }
      title={
        agent.handle === undefined ? (
          agent.name
        ) : (
          <a href={hrefOf({ at: "namespace", handle: agent.handle })} className="hover:underline">
            {agent.name}
          </a>
        )
      }
      meta={
        <>
          {agent.handle !== undefined && agent.handle !== agent.name && (
            <span className="a-mono">{agent.handle}</span>
          )}
          <span>Sponsor request</span>
          <span>
            asked <time className="a-num">{dateTime(request.askedAt)}</time>
          </span>
          <span>
            expires <time className="a-num">{dateTime(request.expiresAt)}</time>
          </span>
          {refused !== null && (
            <div className="basis-full">
              <Refusal said={refused} />
            </div>
          )}
          <FormDialog
            open={blocking}
            close={() => setBlocking(false)}
            title={`Block ${agent.name}?`}
            action="Block"
            busy={busy}
            ready
            submit={(event) => {
              event.preventDefault();
              void decline(true);
            }}
          >
            <p className="text-base text-kumo-default">
              Declines its request. It can't ask you again until you unblock it.
            </p>
          </FormDialog>
        </>
      }
      tied={
        <>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void approve()}>
            Approve
          </Button>
          <RowMenu
            label={`More for ${agent.name}`}
            disabled={busy}
            items={[
              { label: "Decline", select: () => void decline(false) },
              { label: "Block", danger: true, select: () => setBlocking(true) },
            ]}
          />
        </>
      }
    />
  );
}

/**
 * What waits on whoever is signed in: the agents asking them to sponsor them, and the questions Keel has put to
 * them across their projects, each a link to the question's own page, where it is answered. The questions are
 * read again when Keel's log says one was put or closed; both are read again when the page comes back into view;
 * never by the clock.
 */
function Waiting({
  directory,
  account,
  reader,
}: {
  directory: KeelDirectory;
  account: HomeAccount | undefined;
  reader: string;
}) {
  const [listed, setListed] = useState<readonly EscalationView[] | { failed: string }>();
  useEffect(() => {
    const stop = new AbortController();
    let latest = 0;
    const read = async (): Promise<void> => {
      latest += 1;
      const mine = latest;
      try {
        const items = await directory.listWaiting(stop.signal);
        if (!stop.signal.aborted && mine === latest) setListed(items);
      } catch (error) {
        if (stop.signal.aborted || mine !== latest) return;
        // Keel's refusal is said. A read that dropped on the way leaves what Keel last listed, where it listed any.
        const failed = error instanceof Error ? error.message : "Keel could not be read";
        setListed((before) =>
          error instanceof KeelRefused || before === undefined ? { failed } : before,
        );
      }
    };
    void read();
    void followTurns(directory, () => void read(), stop.signal);
    const seen = (): void => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", seen);
    return () => {
      stop.abort();
      document.removeEventListener("visibilitychange", seen);
    };
  }, [directory]);
  const { asked, answered } = useSponsorRequests(account?.requests);
  const [sponsoring, setSponsoring] = useState<string | null>(null);
  const rows = listed === undefined || "failed" in listed ? [] : waitingRows(listed);
  const requests = asked === undefined || "failed" in asked ? [] : asked;
  const read = listed !== undefined && (account === undefined || asked !== undefined);
  const failed = [
    ...(listed !== undefined && "failed" in listed ? [`your questions: ${listed.failed}`] : []),
    ...(asked !== undefined && "failed" in asked ? [`your sponsor requests: ${asked.failed}`] : []),
  ];
  return (
    <section aria-label="Waiting for you" className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold text-kumo-strong">Waiting for you</h2>
      {failed.map((said) => (
        <p key={said} role="alert" className="text-base text-kumo-subtle">
          Keel did not list {said}
        </p>
      ))}
      {sponsoring !== null && (
        <output className="block text-base text-kumo-default">
          You sponsor {sponsoring}.{" "}
          <a className="a-link" href={hrefOf({ at: "settings" })}>
            Settings
          </a>
        </output>
      )}
      {read && failed.length === 0 && rows.length + requests.length === 0 ? (
        <p className="text-base text-kumo-subtle">Nothing waiting</p>
      ) : (
        rows.length + requests.length > 0 && (
          <Rows label="Waiting for you">
            {account !== undefined &&
              requests.map((request) => (
                <SponsorRequestRow
                  key={`sponsor:${request.agent.id}`}
                  request={request}
                  account={account}
                  reader={reader}
                  onAnswered={(agentId, sponsored) => {
                    answered(agentId);
                    setSponsoring(sponsored ? request.agent.name : null);
                  }}
                />
              ))}
            {rows.map((row) => (
              <Row
                key={row.id}
                mark={<EscalationMark state="open" />}
                title={
                  <Anchor
                    href={href(
                      row.namespace,
                      row.project,
                      { at: "escalation", name: row.label },
                      carriedParams(),
                    )}
                  >
                    {row.question}
                  </Anchor>
                }
                meta={
                  <>
                    <span className="text-kumo-subtle">{row.label}</span>
                    <Anchor
                      href={href(
                        row.namespace,
                        row.project,
                        { at: "code", kind: "tree", ref: TRUNK, path: "" },
                        carriedParams(),
                      )}
                      className="a-mono a-link-quiet"
                    >
                      {row.namespace}/{row.project}
                    </Anchor>
                    <span>{CATEGORY[row.category]}</span>
                    <span>
                      asked <time className="a-num">{dateTime(row.raisedAt)}</time>
                    </span>
                  </>
                }
              />
            ))}
          </Rows>
        )
      )}
    </section>
  );
}

/**
 * The home: the projects Keel names to this reader, each under the namespace it is in, as a code host lists
 * repositories under their owners. A visitor is named the public ones, and someone signed in their own and
 * their orgs' too.
 */
export function HomePage({
  directory,
  account,
  orgs,
  handle,
}: {
  directory: KeelDirectory;
  /** What the home reads of a Keel that serves accounts. A test's fixture serves none. */
  account?: HomeAccount;
  /** What Keel lists as the reader's orgs, where someone is signed in. Their own namespace is not one of them. */
  orgs: readonly Org[];
  /** The reader's own handle, where they have one: their projects are listed first, as theirs. */
  handle?: string;
}) {
  const [projects, setProjects] = useState<readonly ProjectView[] | { failed: string }>();
  useEffect(() => {
    let here = true;
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const listed = await directory.listProjects(stop.signal);
        if (here) setProjects(listed);
      } catch (error) {
        if (here)
          setProjects({
            failed: error instanceof Error ? error.message : "Keel could not be read",
          });
      }
    };
    void read();
    return () => {
      here = false;
      stop.abort();
    };
  }, [directory]);
  const names = useAgentNames(projects, directory, account?.agents);
  // Whoever arrives with no account is told what Keel is at once, and then shown the projects anyone may read.
  if (handle === undefined && orgs.length === 0) {
    return (
      <Column>
        <About />
        <section aria-label="Public projects" className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold text-kumo-strong">Public projects</h2>
          {projects === undefined ? null : "failed" in projects ? (
            <p role="alert" className="text-base text-kumo-subtle">
              Keel did not list its projects: {projects.failed}.
            </p>
          ) : projects.length === 0 ? (
            <p className="text-base text-kumo-subtle">No project is public yet.</p>
          ) : (
            <ProjectRows label="Public projects" projects={keelFirst(projects)} names={names} />
          )}
        </section>
      </Column>
    );
  }
  // Someone signed in is shown what waits for them whatever becomes of the list of projects under it.
  if (handle !== undefined && (projects === undefined || "failed" in projects)) {
    return (
      <Column>
        <Waiting directory={directory} account={account} reader={handle} />
        {projects !== undefined && (
          <p role="alert" className="text-base text-kumo-subtle">
            Keel did not list its projects: {projects.failed}.
          </p>
        )}
      </Column>
    );
  }
  if (projects === undefined) return null;
  if ("failed" in projects)
    return <Notice title="Keel did not list its projects">{projects.failed}.</Notice>;
  // A person needs no org: their own namespace is theirs, and what Keel lists as their orgs they made or joined.
  const joined = orgs;
  const mine = projects.filter((project) => project.namespace.handle === handle);
  const rest = projects.filter((project) => project.namespace.handle !== handle);
  // A code host's dashboard: the reader's projects down the left with the way to a new one, what waits for them
  // and every project they may read beside it.
  return (
    <div className="a-scroll h-full overflow-y-auto">
      <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-8 px-6 py-6 md:grid-cols-[260px_minmax(0,1fr)]">
        {/* On a phone what waits for the reader comes first, and their projects and orgs after it. */}
        <aside
          className="order-last flex flex-col gap-6 md:order-none"
          aria-label="Your projects and orgs"
        >
          <section className="flex flex-col gap-2">
            <header className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-kumo-strong">Top projects</h2>
              <a
                href={hrefOf({ at: "new-project" })}
                className={buttonVariants({ variant: "primary", size: "sm" })}
              >
                <BookBookmarkIcon size={14} aria-hidden />
                New
              </a>
            </header>
            {mine.length + rest.length === 0 ? (
              <p className="text-sm text-kumo-subtle">No projects</p>
            ) : (
              <ul className="flex flex-col gap-1.5" aria-label="Top projects">
                {[...mine, ...rest].slice(0, 12).map((project) => (
                  <li key={project.id} className="flex min-w-0 items-center gap-2 text-sm">
                    <BookBookmarkIcon size={14} className="shrink-0 text-kumo-subtle" aria-hidden />
                    <Anchor
                      href={href(
                        project.namespace.handle,
                        project.name,
                        { at: "code", kind: "tree", ref: TRUNK, path: "" },
                        carriedParams(),
                      )}
                      className="truncate text-kumo-strong hover:underline"
                    >
                      {names.get(project.namespace.handle) ?? project.namespace.handle}/
                      {project.name}
                    </Anchor>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {joined.length > 0 && (
            <section className="flex flex-col gap-2 border-t border-kumo-line pt-4">
              <h2 className="text-sm font-semibold text-kumo-strong">Your orgs</h2>
              <ul className="flex flex-col gap-1.5" aria-label="Your orgs">
                {joined.map((org) => (
                  <li key={org.id} className="flex items-center gap-2 text-sm">
                    <UsersThreeIcon size={14} className="text-kumo-subtle" aria-hidden />
                    <a
                      href={hrefOf({ at: "namespace", handle: org.handle })}
                      className="text-kumo-strong hover:underline"
                    >
                      {org.handle}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
        <div className="flex min-w-0 flex-col gap-6">
          <h1 className="sr-only">Home</h1>
          {handle !== undefined && (
            <Waiting directory={directory} account={account} reader={handle} />
          )}
          <section aria-label="Projects" className="flex flex-col gap-3">
            <h2 className="text-xl font-semibold text-kumo-strong">Projects</h2>
            {projects.length === 0 ? (
              <p className="text-base text-kumo-subtle">No projects</p>
            ) : (
              <ProjectRows label="Projects" projects={[...mine, ...rest]} names={names} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
