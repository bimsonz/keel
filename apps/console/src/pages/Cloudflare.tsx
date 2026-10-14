// A project's Cloudflare accounts, on its settings, for the owner of its namespace: the deploy targets Keel holds
// for it, and Continue with Cloudflare, which sends the owner to Cloudflare's consent screen to tick one account.
// Keel's callback makes an API token of its own on that account, which may only edit its Workers, stores it as a
// credential of the project's namespace and sets the target with it, then sends the owner back here with how it
// went. A token Keel stored for one project serves another target on the same account without a second consent.

import { Button, Input } from "@cloudflare/kumo";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useStored } from "../account/Credentials.tsx";
import {
  CONNECT_SAID,
  FIRST_TARGET,
  PROVIDER,
  TOKENS_PAGE,
  credentialOf,
  outcomeIn,
  refusedAtIn,
} from "../account/credentials.ts";
import { Refusal, SELECT, type Said, saidOf, useAsking } from "../account/parts.tsx";
import type { DeployTargetView, ProjectView } from "../contract/keel/index.ts";
import { hrefOf } from "../places.ts";
import { KeelRefused, type KeelCredentials, type KeelDeployTargets } from "../source/types.ts";

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

/** How the Connect the owner just came back from ended, read once from the address and then taken off it. */
function useOutcome() {
  const [outcome] = useState(() => outcomeIn(window.location.search));
  const [refusedAt] = useState(() => refusedAtIn(window.location.search));
  useEffect(() => {
    if (outcome === undefined) return;
    const address = new URL(window.location.href);
    address.searchParams.delete("cloudflare");
    address.searchParams.delete("step");
    window.history.replaceState(window.history.state, "", address);
  }, [outcome]);
  return { outcome, refusedAt };
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
  const { outcome, refusedAt } = useOutcome();
  // The target a project's .keel/deploy.json names first: Connect sets it, and asks for no name.
  const name = FIRST_TARGET;
  const [accountId, setAccountId] = useState("");
  const [using, setUsing] = useState("");
  const { busy, refused, ask } = useAsking();
  // Connecting an account is optional configuration of an instance: one without an OAuth client says so plainly.
  const [unset, setUnset] = useState(false);
  const tokenName = `Keel deploys: ${handle}/${project.name}`.slice(0, 64).trimEnd();

  const consent = (event: FormEvent): void => {
    event.preventDefault();
    void ask(async () => {
      try {
        window.location.assign(await targets.beginConnect(name));
      } catch (error) {
        if (!(error instanceof KeelRefused) || error.code !== "cloudflare.not_configured")
          throw error;
        setUnset(true);
      }
    });
  };
  const reuse = (event: FormEvent): void => {
    event.preventDefault();
    void ask(async () => {
      await targets.putTarget(name, { provider: "cloudflare", accountId, credential: using });
      await connected.read();
      setAccountId("");
      setUsing("");
    });
  };
  const said = outcome === undefined ? undefined : CONNECT_SAID[outcome];

  return (
    <section className="a-panel flex flex-col gap-3 p-4" aria-label="Cloudflare">
      <h2 className="a-h">Cloudflare</h2>
      <p className="text-sm text-kumo-subtle">
        A deploy target is a Cloudflare account this project deploys to, under the name its{" "}
        <code className="a-mono">.keel/deploy.json</code> gives. Continue with Cloudflare and tick
        one account: Keel makes an API token of its own there, named{" "}
        <code className="a-mono">{tokenName}</code>, that may only edit that account's Workers, and
        deploys with it. Cloudflare's consent lets Keel do more than that for a moment; Keel uses it
        only to make that token, and keeps nothing of it.
      </p>
      {said !== undefined && (
        <output
          aria-label="How connecting went"
          className={`block text-sm ${said.ok ? "text-kumo-strong" : "text-kumo-danger"}`}
        >
          {said.said}
          {refusedAt !== undefined && ` (At: ${refusedAt}.)`}
        </output>
      )}
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
                        ? "Its token is no longer stored, so Keel cannot reach the account: connect it again."
                        : `With the token ${credential.label}`}
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
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={consent}
        aria-label="Connect a Cloudflare account"
      >
        <Button type="submit" variant="secondary" disabled={busy}>
          Continue with Cloudflare
        </Button>
      </form>
      {stored.listed !== null && stored.listed.length > 0 && (
        <form
          className="flex flex-col gap-2"
          onSubmit={reuse}
          aria-label="Use a token already stored"
        >
          <p className="text-sm text-kumo-default">
            Or set the target with a token Keel already made for {handle}, on the account it was
            made for:
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <select
              className={SELECT}
              aria-label="Stored token"
              value={using}
              onChange={(event) => setUsing(event.target.value)}
            >
              <option value="">Choose a token</option>
              {stored.listed.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.label}
                </option>
              ))}
            </select>
            <Input
              label="Account id"
              name="account"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={busy || using === "" || accountId.trim() === ""}
            >
              Set the target
            </Button>
          </div>
        </form>
      )}
      {unset && (
        <p className="text-sm text-kumo-default">
          Cloudflare connection isn't set up on this instance yet.
        </p>
      )}
      <Refusal said={refused} />
      {stored.unread !== null && <Refusal said={stored.unread} />}
      <p className="text-sm text-kumo-subtle">
        Remove takes the target off this project. To end Keel's access to an account, delete its
        token from{" "}
        {project.namespace.kind === "org" ? (
          <a className="a-link" href={hrefOf({ at: "org", org: handle, tab: "credentials" })}>
            {handle}'s credentials
          </a>
        ) : (
          <a className="a-link" href={hrefOf({ at: "settings" })}>
            your credentials
          </a>
        )}{" "}
        and revoke it on{" "}
        <a className="a-link" href={TOKENS_PAGE} target="_blank" rel="noreferrer">
          Cloudflare's account API tokens
        </a>
        .
      </p>
    </section>
  );
}
