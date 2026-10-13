// Making a project, at `/new`: whose it is, its name, and how it starts.

import { Button, Input } from "@cloudflare/kumo";
import { type FormEvent, useState } from "react";
import { TRUNK, href } from "../route.ts";
import type { KeelDirectory } from "../source/types.ts";
import type { Org, Who } from "./account.ts";
import { Card, Refusal, SELECT, go, useAsking } from "./parts.tsx";
import { type Start, keys, ownersOf, ready, requestOf } from "./starting.ts";

export function NewProject({
  directory,
  orgs,
  who,
  owner: asked,
}: {
  directory: KeelDirectory;
  /** The orgs Keel lists the reader in. */
  orgs: readonly Org[];
  who: Who;
  /** The owner the link here named, if it named one of the reader's. */
  owner?: string;
}) {
  const owners = ownersOf(orgs, who);
  const [owner, setOwner] = useState(
    owners.find((one) => one.handle === asked)?.handle ?? owners[0]?.handle ?? "",
  );
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Start["kind"]>("empty");
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [keyOf] = useState(() => keys());
  const { busy, refused, ask } = useAsking();
  const request = requestOf(owner, name, kind === "empty" ? { kind } : { kind, url, ref });
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
      title="Make a project"
      lede="A project is a repository and everything Keel records about the changes made to it. It starts private."
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
        {kind === "import" && (
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
          {busy ? "Keel is making the project" : "Make the project"}
        </Button>
      </form>
      <Refusal said={refused} />
    </Card>
  );
}
