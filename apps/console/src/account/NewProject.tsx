// Making a project, at `/new`: whose it is, its name, and how it starts. And forking one, at the project's own
// address with `fork` after it: the same form with the source named, which is how that one starts.

import { Button, Input } from "@cloudflare/kumo";
import { type FormEvent, useEffect, useState } from "react";
import { TRUNK, href } from "../route.ts";
import type { KeelDirectory } from "../source/types.ts";
import type { Org, Who } from "./account.ts";
import { Card, Refusal, SELECT, type Said, go, saidOf, useAsking } from "./parts.tsx";
import { type Start, keys, ownersOf, ready, requestOf } from "./starting.ts";

/** A project to fork: Keel's id for it, which is what a fork is asked for by, and the address it was read at. */
export interface Forked {
  id: string;
  namespace: string;
  name: string;
}

/**
 * Forking a project, at its own address. Keel is asked for the project as this person may read it, and the
 * form is drawn with it named. One Keel does not read them is told as one that is not there, as it is anywhere.
 */
export function Fork({
  directory,
  orgs,
  who,
  namespace,
  project,
}: {
  directory: KeelDirectory;
  orgs: readonly Org[];
  who: Who;
  namespace: string;
  project: string;
}) {
  const [found, setFound] = useState<Forked | null | undefined>(undefined);
  const [unread, setUnread] = useState<Said | null>(null);
  useEffect(() => {
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const view = await directory.findProject(namespace, project, stop.signal);
        if (stop.signal.aborted) return;
        setFound(
          view === null ? null : { id: view.id, namespace: view.namespace.handle, name: view.name },
        );
      } catch (error) {
        if (!stop.signal.aborted) setUnread(saidOf(error));
      }
    };
    void read();
    return () => stop.abort();
  }, [directory, namespace, project]);
  if (unread !== null)
    return (
      <Card title={`Fork ${namespace}/${project}`}>
        <Refusal said={unread} />
      </Card>
    );
  if (found === undefined) return null;
  if (found === null)
    return (
      <Card title={`Project ${namespace}/${project} not found`}>
        <a className="a-link text-sm" href="/">
          See the projects Keel has
        </a>
      </Card>
    );
  return <NewProject directory={directory} orgs={orgs} who={who} source={found} />;
}

export function NewProject({
  directory,
  orgs,
  who,
  owner: asked,
  start,
  source,
}: {
  directory: KeelDirectory;
  /** The orgs Keel lists the reader in. */
  orgs: readonly Org[];
  who: Who;
  /** The owner the link here named, if it named one of the reader's. */
  owner?: string;
  /** How the link here asked for the project to start, where it asked for an import. */
  start?: "import";
  /** The project this one is a fork of, as Keel read it to this person. Absent at `/new`. */
  source?: Forked;
}) {
  const owners = ownersOf(orgs, who);
  const [owner, setOwner] = useState(
    owners.find((one) => one.handle === asked)?.handle ?? owners[0]?.handle ?? "",
  );
  // A fork starts under its source's name, which the person may change.
  const [name, setName] = useState(source?.name ?? "");
  const [kind, setKind] = useState<Exclude<Start["kind"], "fork">>(start ?? "empty");
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [keyOf] = useState(() => keys());
  const { busy, refused, ask } = useAsking();
  const request = requestOf(
    owner,
    name,
    source !== undefined
      ? { kind: "fork", project: source.id }
      : kind === "empty"
        ? { kind }
        : { kind, url, ref },
  );
  const make = (event: FormEvent) => {
    event.preventDefault();
    void ask(async () => {
      // Keel answers once the project's trunk exists: the page it is sent to has code to show.
      const made = await directory.createProject(request, keyOf(request));
      go(
        href(made.namespace.handle, made.name, { at: "code", kind: "tree", ref: TRUNK, path: "" }),
      );
    });
  };
  return (
    <Card
      title={source === undefined ? "Make a project" : `Fork ${source.namespace}/${source.name}`}
      lede={
        source === undefined
          ? "A project is a repository and everything Keel records about the changes made to it. It starts private."
          : "A fork is a project of its own, which starts where this one's trunk is now. It starts private, whoever may read the one it is forked from."
      }
    >
      <form className="flex flex-col gap-3" onSubmit={make}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-kumo-default">Owner</span>
          <select
            name="owner"
            className={SELECT}
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
          >
            {owners.map((one) => (
              <option key={one.handle} value={one.handle}>
                {one.handle === one.note ? one.handle : `${one.handle} (${one.note})`}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="Name"
          name="name"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={name}
          description={`${window.location.host}/${owner}/${request.name === "" ? "its-name" : request.name.toLowerCase()}`}
          onChange={(event) => setName(event.target.value)}
        />
        {source === undefined && (
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-1 font-medium text-kumo-default">Start from</legend>
            <div className="flex flex-col gap-0.5">
              <label className="flex items-center gap-2 text-kumo-default">
                <input
                  type="radio"
                  name="start"
                  value="empty"
                  aria-describedby="start-empty"
                  checked={kind === "empty"}
                  onChange={() => setKind("empty")}
                />
                Nothing
              </label>
              <p id="start-empty" className="pl-6 text-kumo-subtle">
                Keel writes a first commit with a README.
              </p>
            </div>
            <div className="flex flex-col gap-0.5">
              <label className="flex items-center gap-2 text-kumo-default">
                <input
                  type="radio"
                  name="start"
                  value="import"
                  aria-describedby="start-import"
                  checked={kind === "import"}
                  onChange={() => setKind("import")}
                />
                A public Git repository
              </label>
              <p id="start-import" className="pl-6 text-kumo-subtle">
                Keel imports its history. The address is recorded for every reader of the project.
              </p>
            </div>
          </fieldset>
        )}
        {source === undefined && kind === "import" && (
          <>
            <Input
              label="Repository address"
              name="url"
              type="url"
              autoCapitalize="none"
              spellCheck={false}
              required
              placeholder="https://"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Input
              label="Branch"
              name="ref"
              autoCapitalize="none"
              spellCheck={false}
              value={ref}
              description="Left empty, Keel takes the repository's default branch."
              onChange={(event) => setRef(event.target.value)}
            />
          </>
        )}
        <Button
          className="w-full justify-center"
          type="submit"
          variant="primary"
          disabled={busy || !ready(request)}
        >
          {source !== undefined
            ? busy
              ? "Keel is forking the project"
              : "Fork the project"
            : busy
              ? "Keel is making the project"
              : "Make the project"}
        </Button>
      </form>
      <Refusal said={refused} />
    </Card>
  );
}
