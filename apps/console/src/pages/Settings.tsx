// A project's settings: who may read it, and what else Keel holds for it.
// Keel reads them to a member of the project's namespace and lets a maintainer or
// an owner replace them. The page shows what Keel answered, offers the change
// to whoever Keel named a maintainer, and says Keel's refusal in its words.

import { Button, Input } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { Refusal, type Said, saidOf, useAsking } from "../account/parts.tsx";
import type { NamespaceRef, ProjectSettings, ProjectView } from "../contract/keel/index.ts";
import { usePlayer } from "../engine/react.tsx";
import type { Visibility } from "../engine/projects.ts";
import { maintains, mayPublish, owns, readBy } from "../engine/settings.ts";
import { Notice } from "../views/Frame.tsx";
import { Column } from "../views/List.tsx";
import { CloudflareTargets } from "./Cloudflare.tsx";
import { AgentsOfTheOrg, ProjectAgents, invitesHere } from "./ProjectAgents.tsx";

/** Who reads a project of each kind, in a sentence. An org's is its members'; a person's or an agent's is theirs. */
function readers(visibility: Visibility, namespace: NamespaceRef): string {
  if (visibility === "public") return "Anyone reads its code and its log, signed in or not.";
  return namespace.kind === "org"
    ? `Only members of ${namespace.handle} read it.`
    : `Only ${namespace.handle} reads it.`;
}

/** The rest of what Keel holds for the project, as it answered: shown, and changed nowhere on this page. */
function Held({ settings }: { settings: ProjectSettings }) {
  return (
    <section
      className="a-panel flex flex-col gap-3 p-4"
      aria-label="What Keel holds for this project"
    >
      <h2 className="a-h">What Keel holds for this project</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-kumo-subtle">Verification</dt>
        <dd className="text-kumo-default">
          {settings.verification === "off"
            ? "Off: the lane skips verification and marks what lands unverified."
            : "Required: the lane verifies each batch before it lands."}
        </dd>
        <dt className="text-kumo-subtle">Largest batch</dt>
        <dd className="text-kumo-default">
          {settings.maxBatchSize.toLocaleString("en-US")}{" "}
          {settings.maxBatchSize === 1 ? "change" : "changes"}
        </dd>
        <dt className="text-kumo-subtle">Protected paths</dt>
        <dd className="text-kumo-default">
          {settings.protectedPaths.length === 0 ? (
            "None"
          ) : (
            <ul className="a-mono flex flex-col gap-0.5" aria-label="Protected paths">
              {settings.protectedPaths.map((glob) => (
                <li key={glob}>{glob}</li>
              ))}
            </ul>
          )}
          <p className="text-kumo-subtle">
            Only Keel changes these. A change that touches one is refused at precheck.
          </p>
        </dd>
      </dl>
    </section>
  );
}

export function SettingsPage({ project }: { project: ProjectView }) {
  const player = usePlayer();
  const { source } = player;
  const [held, setHeld] = useState<ProjectSettings>();
  const [unread, setUnread] = useState<Said | null>(null);
  const [typed, setTyped] = useState("");
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
        <section className="a-panel flex flex-col gap-3 p-4" aria-label="Settings">
          <Refusal said={unread} />
          <p className="text-sm text-kumo-subtle">
            {project.namespace.kind === "org"
              ? `Keel reads a project's settings to the members of ${project.namespace.handle}, and an owner or a maintainer changes them.`
              : `Keel reads a project's settings to ${project.namespace.handle}, whose project it is.`}
          </p>
        </section>
      </Column>
    );
  if (held === undefined) return null;

  const visibility: Visibility = held.visibility ?? project.visibility;
  const { putSettings } = source;
  const change = (to: Visibility): Promise<void> =>
    ask(async () => {
      // Keel replaces the settings whole: what it answered goes back with the one field changed, and what it
      // answers to that is what the page then shows.
      const answered = await putSettings(readBy(held, to));
      setHeld(answered);
      if (answered.visibility !== undefined) player.readBy(answered.visibility);
      setTyped("");
    });

  return (
    <Column>
      <h1 className="text-xl font-semibold text-kumo-strong">Settings</h1>
      <section className="a-panel flex flex-col gap-3 p-4" aria-label="Who may read this project">
        <h2 className="a-h">Who may read this project</h2>
        <p className="flex flex-wrap items-center gap-2 text-base text-kumo-default">
          <span className="a-chip" data-tone="quiet">
            {visibility}
          </span>
          {readers(visibility, project.namespace)}
        </p>
        {!maintains(project) ? (
          <p className="text-sm text-kumo-subtle">
            {project.namespace.kind === "org"
              ? `An owner or a maintainer of ${project.namespace.handle} changes this.`
              : `${project.namespace.handle} changes this.`}
          </p>
        ) : visibility === "public" ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void change("private")}
            >
              Make private
            </Button>
            <span className="text-sm text-kumo-subtle">
              {readers("private", project.namespace)}
            </span>
          </div>
        ) : (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!mayPublish(project, typed)) return;
              void change("public");
            }}
          >
            <Input
              label={`Type ${project.name} to make it public: anyone will read its code and its log`}
              name="confirm"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={busy || !mayPublish(project, typed)}
            >
              Make public
            </Button>
          </form>
        )}
        <Refusal said={refused} />
      </section>
      {/* A person's own project takes an invitation of its own, from its owner. An org's sends them to the org. */}
      {source.invited !== undefined && invitesHere(project) && (
        <ProjectAgents project={project} invited={source.invited} />
      )}
      {project.namespace.kind === "org" && maintains(project) && (
        <AgentsOfTheOrg org={project.namespace.handle} />
      )}
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
          <section className="a-panel flex flex-col gap-2 p-4" aria-label="Cloudflare">
            <h2 className="a-h">Cloudflare</h2>
            <p className="text-sm text-kumo-default">
              An owner of {project.namespace.handle} connects this project to a Cloudflare account.
            </p>
          </section>
        ))}
      <Held settings={held} />
    </Column>
  );
}
