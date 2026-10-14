// A project's Cloudflare accounts, on its settings, for the owner of its namespace: the deploy targets Keel holds
// for it, and the steps a code host's "connect" page has. Cloudflare's own page makes the token; the token is
// stored as a credential of the project's namespace; then the target is set with that credential's id. Keel
// reaches the account before it sets anything, and says why where it cannot. A token stored for a target Keel
// then refused stays chosen in the form, so trying again needs no second paste.

import { Button, Input } from "@cloudflare/kumo";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useStored } from "../account/Credentials.tsx";
import {
  FIRST_TARGET,
  PROVIDER,
  TOKEN_LINK,
  credentialOf,
  labelFor,
} from "../account/credentials.ts";
import { Refusal, SELECT, type Said, saidOf, useAsking } from "../account/parts.tsx";
import type { DeployTargetView, ProjectView } from "../contract/keel/index.ts";
import { hrefOf } from "../places.ts";
import type { KeelCredentials, KeelDeployTargets } from "../source/types.ts";

/** The form's choice of credential: a token pasted here, or one the namespace has stored, by its id. */
const NEW = "new";

/** Keel's answer to a read of the project's deploy targets: its list, or what it said in refusing. */
type Answer = { listed: DeployTargetView[] } | { unread: Said };

async function listing(targets: KeelDeployTargets, signal?: AbortSignal): Promise<Answer> {
  try {
    return { listed: await targets.listTargets(signal) };
  } catch (error) {
    return { unread: saidOf(error) };
  }
}

/** Keel's list of the project's deploy targets: read when the section opens and after every move. */
function useTargets(targets: KeelDeployTargets) {
  const [listed, setListed] = useState<DeployTargetView[] | null>(null);
  const [unread, setUnread] = useState<Said | null>(null);
  const read = useCallback(async (): Promise<void> => {
    const answer = await listing(targets);
    if ("listed" in answer) setListed(answer.listed);
    setUnread("unread" in answer ? answer.unread : null);
  }, [targets]);
  useEffect(() => {
    const stop = new AbortController();
    const first = async (): Promise<void> => {
      const answer = await listing(targets, stop.signal);
      if (stop.signal.aborted) return;
      if ("listed" in answer) setListed(answer.listed);
      setUnread("unread" in answer ? answer.unread : null);
    };
    void first();
    return () => stop.abort();
  }, [targets]);
  return { listed, unread, read };
}

export function CloudflareTargets({
  project,
  targets,
  credentials,
}: {
  project: ProjectView;
  targets: KeelDeployTargets;
  credentials: KeelCredentials;
}) {
  const handle = project.namespace.handle;
  const connected = useTargets(targets);
  const stored = useStored(credentials, handle);
  const [name, setName] = useState(FIRST_TARGET);
  const [accountId, setAccountId] = useState("");
  const [using, setUsing] = useState(NEW);
  const [label, setLabel] = useState(() => labelFor(project.name));
  const [token, setToken] = useState("");
  const { busy, refused, ask } = useAsking();

  const connect = (event: FormEvent): void => {
    event.preventDefault();
    // The token is taken out of the field as it is sent, whatever Keel answers.
    const secret = token;
    setToken("");
    void ask(async () => {
      let credential = using;
      if (using === NEW) {
        const made = await credentials.storeCredential(handle, {
          label,
          provider: "cloudflare",
          secret,
        });
        credential = made.id;
        // Kept chosen: if Keel refuses the target, the owner tries again without the token.
        setUsing(made.id);
        await stored.read();
      }
      await targets.putTarget(name, { provider: "cloudflare", accountId, credential });
      await connected.read();
      setName(FIRST_TARGET);
      setAccountId("");
      setUsing(NEW);
      setLabel(labelFor(project.name));
    });
  };
  const ready =
    name.trim() !== "" &&
    accountId.trim() !== "" &&
    (using !== NEW || (label.trim() !== "" && token.trim() !== ""));

  return (
    <section className="a-panel flex flex-col gap-3 p-4" aria-label="Cloudflare">
      <h2 className="a-h">Cloudflare</h2>
      <p className="text-sm text-kumo-subtle">
        A deploy target is a Cloudflare account this project deploys to, under the name its{" "}
        <code className="a-mono">.keel/deploy.json</code> gives. Keel reaches the account with an
        API token stored in {handle}'s credentials, and checks that the token reaches the account's
        Workers before it sets the target.
      </p>
      {connected.unread !== null && <Refusal said={connected.unread} />}
      {connected.listed !== null && connected.listed.length === 0 && (
        <p className="text-sm text-kumo-default">No Cloudflare account is connected.</p>
      )}
      {connected.listed !== null && connected.listed.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Deploy targets">
          {connected.listed.map((target) => {
            const credential = credentialOf(target, stored.listed ?? []);
            return (
              <li
                key={target.name}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="a-mono font-semibold text-kumo-strong">{target.name}</span>
                  <span className="text-kumo-subtle [overflow-wrap:anywhere]">
                    {PROVIDER[target.provider]} account{" "}
                    <span className="a-mono">{target.accountId}</span>
                    {target.workersDev !== undefined && (
                      <>
                        {" "}
                        · previews at <span className="a-mono">{target.workersDev}</span>
                      </>
                    )}
                  </span>
                  {stored.listed !== null && (
                    <span className="text-kumo-subtle [overflow-wrap:anywhere]">
                      {credential === undefined
                        ? "Its credential is no longer stored, so Keel cannot reach the account: set it again with another."
                        : `With the credential ${credential.label}`}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="a-link"
                  disabled={busy}
                  aria-label={`Remove the target ${target.name}`}
                  onClick={() =>
                    void ask(async () => {
                      await targets.clearTarget(target.name);
                      await connected.read();
                    })
                  }
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-kumo-default">
        <li>
          <a className="a-link" href={TOKEN_LINK} target="_blank" rel="noreferrer">
            Make a token on Cloudflare
          </a>{" "}
          with Workers Scripts: Edit, already chosen there.
        </li>
        <li>
          Give the target's name, the account's id (on the account's home in Cloudflare's dashboard)
          and the token, or a credential {handle} has stored.
        </li>
      </ol>
      <form
        className="flex flex-col gap-3"
        onSubmit={connect}
        aria-label="Connect a Cloudflare account"
      >
        <div className="flex flex-wrap items-end gap-2">
          <Input
            label="Target"
            name="target"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            label="Account id"
            name="account"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          />
          <select
            className={SELECT}
            aria-label="Credential"
            value={using}
            onChange={(event) => setUsing(event.target.value)}
          >
            <option value={NEW}>A new token</option>
            {(stored.listed ?? []).map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.label}
              </option>
            ))}
          </select>
        </div>
        {using === NEW && (
          <div className="flex flex-wrap items-end gap-2">
            <Input
              label="Label"
              name="label"
              autoComplete="off"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Input
              label="Cloudflare API token"
              name="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
        )}
        <div>
          <Button type="submit" variant="secondary" disabled={busy || !ready}>
            Connect
          </Button>
        </div>
      </form>
      <Refusal said={refused} />
      {stored.unread !== null && <Refusal said={stored.unread} />}
      <p className="text-sm text-kumo-subtle">
        {project.namespace.kind === "org" ? (
          <a className="a-link" href={hrefOf({ at: "org", org: handle, tab: "credentials" })}>
            {handle}'s credentials
          </a>
        ) : (
          <a className="a-link" href={hrefOf({ at: "settings" })}>
            Your credentials
          </a>
        )}{" "}
        are listed with each one's label, and removed there.
      </p>
    </section>
  );
}
