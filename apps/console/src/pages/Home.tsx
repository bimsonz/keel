import { BookBookmarkIcon } from "@phosphor-icons/react";
import { usePlayer, useWorldVersion } from "../engine/react.tsx";
import { TRUNK, href } from "../route.ts";
import { Anchor, carriedParams } from "../router.tsx";
import { Notice } from "../views/Frame.tsx";
import { Column, Row, Rows } from "../views/List.tsx";

/**
 * The instance's own page: its projects. One Keel is one organisation's, so this is where an organisation's
 * page would be on a code host. The projects are the ones Keel's log has named to this reader.
 */
export function HomePage() {
  const player = usePlayer();
  useWorldVersion();
  if (player.source.descriptor.log === "closed") {
    return (
      <Notice title="Keel's projects are not listed to visitors yet">
        A project is at its own address, under its name. The list of them is read from Keel's log,
        and Keel reads its log only to an observer: this console reads it for whoever opens it with
        the presenter's key.
      </Notice>
    );
  }
  const projects = player.projects.list;
  if (projects.length === 0) {
    return (
      <Notice title="Keel has no project yet">
        When a project is created in Keel, it is listed here.
      </Notice>
    );
  }
  return (
    <Column>
      <h1 className="text-xl font-semibold text-kumo-strong">Projects</h1>
      <Rows label="Projects">
        {projects.map((project) => (
          <Row
            key={project.id}
            mark={<BookBookmarkIcon size={18} aria-hidden />}
            title={
              <Anchor
                href={href(
                  project.name,
                  { at: "code", kind: "tree", ref: TRUNK, path: "" },
                  carriedParams(),
                )}
              >
                {project.name}
              </Anchor>
            }
            meta={
              <>
                <span className="a-chip" data-tone="quiet">
                  {project.visibility}
                </span>
                {project.unverified && (
                  <span
                    className="a-chip"
                    data-tone="suspected"
                    title="Its trunk has advanced with verification switched off"
                  >
                    Unverified
                  </span>
                )}
              </>
            }
          />
        ))}
      </Rows>
    </Column>
  );
}
