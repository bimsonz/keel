// Who has access to a project, as a code host's "Collaborators and teams" lists it: a row for each person. A
// person's own project is theirs; an org's is its members', each with their role, managed on its People page.

import { buttonVariants } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { createAccount, type OrgPage } from "../account/account.ts";
import { PersonRow, ROLE_LABEL } from "../account/People.tsx";
import { Refusal, type Said, saidOf } from "../account/parts.tsx";
import { Avatar, Box, Row, Rows } from "../account/rows.tsx";
import type { ProjectView } from "../contract/keel/index.ts";
import { hrefOf } from "../places.ts";

/** An org's members, as Keel reads them to this reader: undefined until it has answered. */
function useMembers(org: string) {
  const [page, setPage] = useState<OrgPage | null>();
  const [unread, setUnread] = useState<Said | null>(null);
  useEffect(() => {
    let here = true;
    const read = async (): Promise<void> => {
      try {
        const account = createAccount({ origin: window.location.origin });
        const who = await account.who();
        const answer = who === null ? null : await account.org(org, who);
        if (here) setPage(answer);
      } catch (error) {
        if (here) setUnread(saidOf(error));
      }
    };
    void read();
    return () => {
      here = false;
    };
  }, [org]);
  return { page, unread };
}

function OrgAccess({ org }: { org: string }) {
  const { page, unread } = useMembers(org);
  return (
    <>
      <Box
        title="Members"
        {...(page === undefined || page === null ? {} : { count: page.members.length })}
        actions={
          <a
            className={buttonVariants({ variant: "secondary", size: "sm" })}
            href={hrefOf({ at: "org", org, tab: "members" })}
          >
            Manage
          </a>
        }
      >
        <Rows label="People with access">
          {(page?.members ?? []).map((member) => (
            <PersonRow
              key={member.id}
              member={member}
              side={<span>{ROLE_LABEL[member.role]}</span>}
            />
          ))}
        </Rows>
      </Box>
      <Refusal said={unread} />
    </>
  );
}

export function Access({ project }: { project: ProjectView }) {
  if (project.namespace.kind === "org") return <OrgAccess org={project.namespace.handle} />;
  const owner = project.namespace.handle;
  return (
    <Box title="People with access" count={1}>
      <Rows label="People with access">
        <Row
          label={owner}
          avatar={<Avatar name={owner} />}
          title={
            <a className="a-link font-semibold" href={hrefOf({ at: "namespace", handle: owner })}>
              {owner}
            </a>
          }
          meta={`@${owner}`}
          side={<span>Owner</span>}
        />
      </Rows>
    </Box>
  );
}
