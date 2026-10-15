// A project's settings, as a code host lays out a repository's: a sidebar of sections, each at its own address
// and with one purpose. General is what Keel holds for trunk, the upstream an import syncs from, and the Danger
// zone; Access, the people who may read the project; Agents, the agents on it; Integrations, its Cloudflare
// account. Keel reads the settings to a member of the project's namespace and lets a maintainer or an owner
// replace them; what it answers is what the page shows, and a refusal is said in its words.

import { Button, Input } from "@cloudflare/kumo";
import {
  GearIcon,
  type Icon,
  PlugsConnectedIcon,
  RobotIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Refusal, type Said, saidOf, useAsking } from "../account/parts.tsx";
import { Box, DangerZone, FormDialog, Rows, Setting, Tag } from "../account/rows.tsx";
import type { ProjectSettings, ProjectView, UpstreamSync } from "../contract/keel/index.ts";
import { usePlayer, useSelected } from "../engine/react.tsx";
import type { Visibility } from "../engine/projects.ts";
import { branchOf, maintains, mayPublish, owns, readBy, syncedSaid } from "../engine/settings.ts";
import type { SettingsSection } from "../route.ts";
import { Link } from "../router.tsx";
import { Notice } from "../views/Frame.tsx";
import { Column } from "../views/List.tsx";
import { Access } from "./Access.tsx";
import { CloudflareTargets } from "./Cloudflare.tsx";
import { Collaborators, OrgAgentsOf, invitesHere } from "./Collaborators.tsx";

/** The sidebar, as a code host's repository settings have it: General first, at the bare address. */
const SECTIONS: readonly { section: SettingsSection | undefined; label: string; Icon: Icon }[] = [
  { section: undefined, label: "General", Icon: GearIcon },
  { section: "access", label: "Access", Icon: UsersIcon },
  { section: "agents", label: "Agents", Icon: RobotIcon },
  { section: "integrations", label: "Integrations", Icon: PlugsConnectedIcon },
];

function Sidebar({ open }: { open: SettingsSection | undefined }) {
  return (
    <nav aria-label="Settings" className="shrink-0 md:w-56">
      <ul className="flex gap-1 overflow-x-auto md:flex-col">
        {SECTIONS.map(({ section, label, Icon }) => (
          <li key={label}>
            <Link
              to={section === undefined ? { at: "settings" } : { at: "settings", section }}
              aria-current={section === open ? "page" : undefined}
              className="flex h-8 items-center gap-2 rounded-md px-2 text-sm whitespace-nowrap text-kumo-default hover:bg-kumo-tint aria-[current=page]:bg-kumo-fill aria-[current=page]:font-semibold aria-[current=page]:text-kumo-strong"
            >
              <Icon size={16} aria-hidden />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A section's own heading, ruled off from what follows it, as a code host heads each settings page. */
function Heading({ children }: { children: ReactNode }) {
  return (
    <h2 className="border-b border-kumo-hairline pb-2 text-xl font-semibold text-kumo-strong">
      {children}
    </h2>
  );
}

/** Sync from upstream, on an imported project, for its owner: the branch it came from, and the one button. */
function Upstream({ sync }: { sync: () => Promise<UpstreamSync> }) {
  const upstream = useSelected((world) => world.trunk.upstream);
  const [outcome, setOutcome] = useState<UpstreamSync>();
  const { busy, refused, ask } = useAsking();
  // Trunk's first entry says whether it was imported, and Keel syncs nothing else.
  if (upstream === undefined) return null;
  return (
    <Box title="Upstream">
      <Rows label="Upstream">
        <Setting
          name={branchOf(upstream.ref)}
          value={
            <a className="a-link" href={upstream.url} rel="noreferrer" target="_blank">
              {upstream.url}
            </a>
          }
        >
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void ask(async () => {
                setOutcome(undefined);
                setOutcome(await sync());
              })
            }
          >
            Sync from upstream
          </Button>
        </Setting>
      </Rows>
      {(outcome !== undefined || refused !== null) && (
        <div className="border-t border-kumo-hairline px-4 py-3 text-sm">
          {outcome !== undefined && (
            <output className="text-kumo-default">{syncedSaid(outcome)}</output>
          )}
          <Refusal said={refused} />
        </div>
      )}
    </Box>
  );
}

/** Make public, in a dialog that waits for the project's name: anyone then reads its code and its log. */
function Publish({
  project,
  busy,
  publish,
  close,
}: {
  project: ProjectView;
  busy: boolean;
  publish: () => void;
  close: () => void;
}) {
  const [typed, setTyped] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (mayPublish(project, typed)) publish();
  };
  return (
    <FormDialog
      open
      close={close}
      title={`Make ${project.name} public`}
      action="Make public"
      busy={busy}
      ready={mayPublish(project, typed)}
      submit={submit}
    >
      <Input
        label={`Type ${project.name} to confirm`}
        name="confirm"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />
    </FormDialog>
  );
}

function General({
  project,
  held,
  change,
  busy,
  refused,
}: {
  project: ProjectView;
  held: ProjectSettings;
  change: (to: Visibility) => Promise<boolean>;
  busy: boolean;
  refused: Said | null;
}) {
  const { source } = usePlayer();
  const [publishing, setPublishing] = useState(false);
  const visibility: Visibility = held.visibility ?? project.visibility;
  const batch = held.maxBatchSize;
  return (
    <>
      <Heading>General</Heading>
      <Box title="Project">
        <Rows label="Project">
          <Setting name="Name" value={<span className="a-mono">{project.name}</span>} />
          <Setting
            name="Visibility"
            value={<Tag>{visibility === "public" ? "Public" : "Private"}</Tag>}
          />
        </Rows>
      </Box>
      <Box title="Trunk">
        <Rows label="Trunk">
          <Setting name="Verification" value={held.verification === "off" ? "Off" : "Required"} />
          <Setting
            name="Max batch size"
            value={`${batch.toLocaleString("en-US")} ${batch === 1 ? "change" : "changes"}`}
          />
          <Setting
            name="Protected paths"
            value={
              held.protectedPaths.length === 0 ? (
                "None"
              ) : (
                <ul className="a-mono flex flex-col gap-0.5" aria-label="Protected paths">
                  {held.protectedPaths.map((glob) => (
                    <li key={glob}>{glob}</li>
                  ))}
                </ul>
              )
            }
          />
        </Rows>
      </Box>
      {/* Keel syncs an imported trunk for the project's owner alone. */}
      {source.syncUpstream !== undefined && owns(project) && (
        <Upstream sync={source.syncUpstream} />
      )}
      {maintains(project) && (
        <DangerZone>
          <Setting name="Change visibility" value={visibility === "public" ? "Public" : "Private"}>
            {visibility === "public" ? (
              <Button
                type="button"
                variant="secondary"
                className="!text-kumo-danger"
                disabled={busy}
                onClick={() => void change("private")}
              >
                Make private
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                className="!text-kumo-danger"
                disabled={busy}
                onClick={() => setPublishing(true)}
              >
                Make public
              </Button>
            )}
          </Setting>
          {refused !== null && (
            <li className="px-4 py-3">
              <Refusal said={refused} />
            </li>
          )}
        </DangerZone>
      )}
      {publishing && (
        <Publish
          project={project}
          busy={busy}
          close={() => setPublishing(false)}
          publish={() =>
            void change("public").then((done) => {
              if (done) setPublishing(false);
              return done;
            })
          }
        />
      )}
    </>
  );
}

export function SettingsPage({
  project,
  section,
}: {
  project: ProjectView;
  section: SettingsSection | undefined;
}) {
  const player = usePlayer();
  const { source } = player;
  // Keel's Connect callback comes back to the bare settings with how it went: that is Integrations' to say.
  const [arrived] = useState(() => new URLSearchParams(window.location.search).has("cloudflare"));
  const open = section ?? (arrived ? "integrations" : undefined);
  useEffect(() => {
    if (!arrived || section !== undefined) return;
    // Integrations' own address, once it has read how Connect went and taken that off the address.
    const address = new URL(window.location.href);
    address.pathname = `${address.pathname.replace(/\/$/, "")}/integrations`;
    window.history.replaceState(window.history.state, "", address);
  }, [arrived, section]);
  const [held, setHeld] = useState<ProjectSettings>();
  const [unread, setUnread] = useState<Said | null>(null);
  const { busy, refused, ask } = useAsking();

  useEffect(() => {
    let here = true;
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const settings = await source.getSettings?.(stop.signal);
        if (!here) return;
        setHeld(settings);
        // The frame says who may read the project too, and says what Keel has just said.
        if (settings?.visibility !== undefined) player.readBy(settings.visibility);
      } catch (error) {
        if (here) setUnread(saidOf(error));
      }
    };
    void read();
    return () => {
      here = false;
      stop.abort();
    };
  }, [player, source]);

  if (source.getSettings === undefined || source.putSettings === undefined)
    return (
      <Notice title="A test fixture has no settings">
        Keel holds a project's settings, and this is not Keel.
      </Notice>
    );
  if (unread !== null)
    return (
      <Column>
        <h1 className="text-xl font-semibold text-kumo-strong">Settings</h1>
        <Refusal said={unread} />
      </Column>
    );
  if (held === undefined) return null;

  const { putSettings } = source;
  const change = async (to: Visibility): Promise<boolean> => {
    let done = false;
    await ask(async () => {
      // Keel replaces the settings whole: what it answered goes back with the one field changed, and what it
      // answers to that is what the page then shows.
      const answered = await putSettings(readBy(held, to));
      setHeld(answered);
      if (answered.visibility !== undefined) player.readBy(answered.visibility);
      done = true;
    });
    return done;
  };

  return (
    <Column>
      <h1 className="sr-only">Settings</h1>
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <Sidebar open={open} />
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          {open === undefined && (
            <General project={project} held={held} change={change} busy={busy} refused={refused} />
          )}
          {open === "access" && (
            <>
              <Heading>Access</Heading>
              <Access project={project} />
            </>
          )}
          {open === "agents" && (
            <>
              <Heading>Agents</Heading>
              {source.invited !== undefined && invitesHere(project) ? (
                <Collaborators project={project} invited={source.invited} />
              ) : project.namespace.kind === "org" ? (
                <OrgAgentsOf org={project.namespace.handle} />
              ) : null}
            </>
          )}
          {open === "integrations" && (
            <>
              <Heading>Integrations</Heading>
              {/* Where the project deploys is its namespace's owner's to say, and Keel reads it to them alone. */}
              {source.targets !== undefined &&
                source.credentials !== undefined &&
                (owns(project) ? (
                  <CloudflareTargets
                    project={project}
                    targets={source.targets}
                    credentials={source.credentials}
                  />
                ) : (
                  <Box title="Cloudflare">
                    <p className="px-4 py-3 text-sm text-kumo-subtle">Owner only</p>
                  </Box>
                ))}
            </>
          )}
        </div>
      </div>
    </Column>
  );
}
