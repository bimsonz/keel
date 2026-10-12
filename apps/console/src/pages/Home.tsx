import { BookBookmarkIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Org } from "../account/account.ts";
import { hrefOf } from "../places.ts";
import { TRUNK, href } from "../route.ts";
import { Anchor, carriedParams } from "../router.tsx";
import type { ProjectView } from "../contract/keel/index.ts";
import type { KeelDirectory } from "../source/types.ts";
import { Notice } from "../views/Frame.tsx";
import { Column, Row, Rows } from "../views/List.tsx";

/**
 * The home: the projects Keel names to this reader, each under the org it is in, as a code host lists
 * repositories under their owners. A visitor is named the public ones, and someone signed in their orgs' too.
 */
export function HomePage({
  directory,
  orgs,
}: {
  directory: KeelDirectory;
  /** The reader's own orgs, where someone is signed in and Keel has listed them. */
  orgs: readonly Org[];
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
      {orgs.length > 0 && (
        <>
          <h1 className="text-xl font-semibold text-kumo-strong">Your orgs</h1>
          <Rows label="Your orgs">
            {orgs.map((org) => (
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
      <h2 className="text-xl font-semibold text-kumo-strong">Projects</h2>
      {projects.length === 0 && (
        <p className="text-base text-kumo-subtle">None of your orgs has a project yet.</p>
      )}
      <Rows label="Projects">
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
    </Column>
  );
}
