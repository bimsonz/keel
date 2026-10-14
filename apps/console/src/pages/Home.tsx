import { BookBookmarkIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Org } from "../account/account.ts";
import { followTurns, waitingRows } from "../engine/waiting.ts";
import { hrefOf } from "../places.ts";
import { TRUNK, href } from "../route.ts";
import { Anchor, carriedParams } from "../router.tsx";
import type { EscalationView, ProjectView } from "../contract/keel/index.ts";
import { type KeelDirectory, KeelRefused } from "../source/types.ts";
import { CATEGORY } from "../views/Escalation.tsx";
import { Notice } from "../views/Frame.tsx";
import { ABOUT } from "../views/Footer.tsx";
import { Column, EscalationMark, Row, Rows } from "../views/List.tsx";
import { dateTime } from "../views/parts.tsx";

/** Projects, each under its owner, as a code host lists repositories. */
function ProjectRows({ label, projects }: { label: string; projects: readonly ProjectView[] }) {
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
                {project.namespace.handle}
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
            <span className="a-chip" data-tone="quiet">
              {project.visibility}
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
 * The questions Keel has put to whoever is signed in, across their projects: what Keel lists, in its order,
 * each a link to the question's own page, where it is answered. The list is read again when Keel's log says a
 * question was put or closed, and when the page comes back into view; never by the clock.
 */
function Waiting({ directory }: { directory: KeelDirectory }) {
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
  const rows = listed === undefined || "failed" in listed ? [] : waitingRows(listed);
  return (
    <section aria-label="Waiting for you" className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold text-kumo-strong">Waiting for you</h2>
      {listed !== undefined && "failed" in listed ? (
        <p role="alert" className="text-base text-kumo-subtle">
          Keel did not list your questions: {listed.failed}
        </p>
      ) : listed !== undefined && rows.length === 0 ? (
        <p className="text-base text-kumo-subtle">No question is waiting for you.</p>
      ) : (
        rows.length > 0 && (
          <Rows label="Questions waiting for you, newest first">
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
                    <b className="font-semibold text-kumo-default">{row.label}</b>
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
  orgs,
  handle,
}: {
  directory: KeelDirectory;
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
            <ProjectRows label="Public projects" projects={projects} />
          )}
        </section>
      </Column>
    );
  }
  // Someone signed in is shown what waits for them whatever becomes of the list of projects under it.
  if (handle !== undefined && (projects === undefined || "failed" in projects)) {
    return (
      <Column>
        <Waiting directory={directory} />
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
  return (
    <Column>
      {handle !== undefined && <Waiting directory={directory} />}
      {handle !== undefined && (
        <>
          <h1 className="text-xl font-semibold text-kumo-strong">Your projects</h1>
          {mine.length === 0 ? (
            <p className="text-base text-kumo-subtle">You have no project yet.</p>
          ) : (
            <ProjectRows label="Your projects" projects={mine} />
          )}
        </>
      )}
      {joined.length > 0 && (
        <>
          <h2 className="text-xl font-semibold text-kumo-strong">Your orgs</h2>
          <Rows label="Your orgs">
            {joined.map((org) => (
              <Row
                key={org.id}
                mark={<UsersThreeIcon size={18} aria-hidden />}
                title={
                  <a
                    href={hrefOf({ at: "namespace", handle: org.handle })}
                    className="hover:underline"
                  >
                    {org.handle}
                  </a>
                }
                meta={org.name === org.handle ? null : org.name}
              />
            ))}
          </Rows>
        </>
      )}
      {(handle === undefined || rest.length > 0) && (
        <>
          <h2 className="text-xl font-semibold text-kumo-strong">Projects</h2>
          <ProjectRows label="Projects" projects={rest} />
        </>
      )}
    </Column>
  );
}
