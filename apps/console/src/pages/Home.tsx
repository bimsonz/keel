import { BookBookmarkIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Org } from "../account/account.ts";
import { orgsOf } from "../account/accounts.ts";
import { hrefOf } from "../places.ts";
import { TRUNK, href } from "../route.ts";
import { Anchor, carriedParams } from "../router.tsx";
import type { ProjectView } from "../contract/keel/index.ts";
import type { KeelDirectory } from "../source/types.ts";
import { Notice } from "../views/Frame.tsx";
import { Column, Row, Rows } from "../views/List.tsx";

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
              <a href={`/${encodeURIComponent(project.org)}`} className="hover:underline">
                {project.org}
              </a>
              <span className="text-kumo-inactive">/</span>
              <Anchor
                href={href(
                  project.org,
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
 * The home: the projects Keel names to this reader, each under the org it is in, as a code host lists
 * repositories under their owners. A visitor is named the public ones, and someone signed in their orgs' too.
 */
export function HomePage({
  directory,
  orgs,
  handle,
}: {
  directory: KeelDirectory;
  /** What Keel lists as the reader's orgs, where someone is signed in: their own namespace is one of them. */
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
  if (projects === undefined) return null;
  if ("failed" in projects)
    return <Notice title="Keel did not list its projects">{projects.failed}.</Notice>;
  // A person needs no org: their own namespace is theirs, and only what they made or joined is listed as an org.
  const joined = orgsOf(orgs, { handle });
  const mine = projects.filter((project) => project.org === handle);
  const rest = projects.filter((project) => project.org !== handle);
  if (projects.length === 0 && orgs.length === 0) {
    return (
      <Notice title="Keel has no project to show you yet">
        A visitor is shown the public projects, and someone signed in the projects of their orgs as
        well.{" "}
        <a href="/login" className="a-link">
          Sign in
        </a>{" "}
        to see yours.
      </Notice>
    );
  }
  return (
    <Column>
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
                    href={hrefOf({ at: "org", org: org.handle, tab: "home" })}
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
