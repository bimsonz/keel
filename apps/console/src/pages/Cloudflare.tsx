// A project's Cloudflare accounts, on its settings, for the owner of its namespace: the deploy targets Keel holds
// for it, and Continue with Cloudflare, which sends the owner to Cloudflare's consent screen to tick one account.
// Keel's callback makes an API token of its own on that account, which may only edit its Workers, stores it as a
// credential of the project's namespace and sets the target with it, then sends the owner back here with how it
// went. The section is that one button, the connected account and how the last Connect went.

import { CloudflareLogo } from "@cloudflare/kumo";
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
import { Refusal, type Said, saidOf, useAsking } from "../account/parts.tsx";
import type { DeployTargetView, ProjectView } from "../contract/keel/index.ts";
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
    address.searchParams.delete("code");
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
  const { busy, refused, ask } = useAsking();
  // Connecting an account is optional configuration of an instance: one without an OAuth client says so plainly.
  const [unset, setUnset] = useState(false);

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
  const said = outcome === undefined ? undefined : CONNECT_SAID[outcome];

  return (
    <section className="a-panel flex flex-col gap-3 p-4" aria-label="Cloudflare">
      <h2 className="a-h">Cloudflare</h2>
      {said !== undefined && (
        <output
          aria-label="How connecting went"
          className={`block text-sm ${said.ok ? "text-kumo-strong" : "text-kumo-danger"}`}
        >
          {said.said}
          {refusedAt !== undefined && ` (${refusedAt})`}
        </output>
      )}
      {connected.unread !== null && <Refusal said={connected.unread} />}
      {connected.listed !== null && connected.listed.length === 0 && (
        <p className="text-sm text-kumo-default">No connected accounts</p>
      )}
      {connected.listed !== null && connected.listed.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Connected accounts">
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
                        · Previews <span className="a-mono">{target.workersDev}</span>
                      </>
                    )}
                  </span>
                  {stored.listed !== null && (
                    <span className="text-kumo-subtle [overflow-wrap:anywhere]">
                      {credential === undefined
                        ? "Token: removed, connect again"
                        : `Token: ${credential.label}`}
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
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-8 items-center gap-2 rounded-md bg-[#F38020] px-3 text-sm font-semibold text-white hover:bg-[#E06D10] disabled:opacity-60"
        >
          <CloudflareLogo variant="glyph" color="white" className="h-4 w-auto" aria-hidden />
          Connect to Cloudflare
        </button>
      </form>
      {unset && <p className="text-sm text-kumo-default">Not available on this instance</p>}
      <Refusal said={refused} />
      {stored.unread !== null && <Refusal said={stored.unread} />}
      <p className="text-sm">
        <a className="a-link" href={TOKENS_PAGE} target="_blank" rel="noreferrer">
          Revoke on Cloudflare
        </a>
      </p>
    </section>
  );
}
