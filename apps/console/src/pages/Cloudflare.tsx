// A project's Cloudflare account, under its settings' Integrations, for the owner of its namespace, as a code host lists an installed app: a box
// with Connect to Cloudflare in its header and a row for each deploy target Keel holds. Connect sends the owner of
// the project's namespace to Cloudflare's consent screen to tick one account; Keel's callback makes an API token
// of its own there, which may only edit its Workers, stores it as a credential of the namespace and sets the
// target with it, then sends the owner back with how it went.

import { CloudflareLogo } from "@cloudflare/kumo";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useStored } from "../account/Credentials.tsx";
import {
  CONNECT_SAID,
  FIRST_TARGET,
  TOKENS_PAGE,
  credentialOf,
  outcomeIn,
  refusedAtIn,
} from "../account/credentials.ts";
import { Refusal, type Said, saidOf, useAsking } from "../account/parts.tsx";
import { Box, Row, RowMenu, Rows } from "../account/rows.tsx";
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

/** Cloudflare's own button: its mark in white on its orange, and its words. */
function ConnectButton({ busy }: { busy: boolean }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="inline-flex h-8 items-center gap-2 rounded-md bg-[#F38020] px-3 text-sm font-semibold text-white hover:bg-[#E06D10] disabled:opacity-60"
    >
      <CloudflareLogo variant="glyph" color="white" className="h-4 w-auto" aria-hidden />
      Connect to Cloudflare
    </button>
  );
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
  const connected = useTargets(targets);
  const stored = useStored(credentials, project.namespace.handle);
  const { outcome, refusedAt } = useOutcome();
  const { busy, refused, ask } = useAsking();
  // Connecting an account is optional configuration of an instance: one without an OAuth client says so plainly.
  const [unset, setUnset] = useState(false);

  const consent = (event: FormEvent): void => {
    event.preventDefault();
    void ask(async () => {
      try {
        // The target a project's .keel/deploy.json names first: Connect sets it, and asks for no name.
        window.location.assign(await targets.beginConnect(FIRST_TARGET));
      } catch (error) {
        if (!(error instanceof KeelRefused) || error.code !== "cloudflare.not_configured")
          throw error;
        setUnset(true);
      }
    });
  };
  const said = outcome === undefined ? undefined : CONNECT_SAID[outcome];

  return (
    <>
      <Box
        title="Cloudflare"
        actions={
          <form onSubmit={consent} aria-label="Connect a Cloudflare account">
            <ConnectButton busy={busy} />
          </form>
        }
      >
        {said !== undefined && (
          <output
            aria-label="How connecting went"
            className={`block border-b border-kumo-hairline px-4 py-3 text-sm ${said.ok ? "text-kumo-strong" : "text-kumo-danger"}`}
          >
            {said.said}
            {refusedAt !== undefined && ` (${refusedAt})`}
          </output>
        )}
        <Rows label="Connected accounts">
          {(connected.listed ?? []).map((target) => {
            const credential = credentialOf(target, stored.listed ?? []);
            return (
              <Row
                key={target.name}
                label={target.name}
                avatar={
                  <span
                    aria-hidden
                    className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[#F38020]"
                  >
                    <CloudflareLogo variant="glyph" color="white" className="h-3.5 w-auto" />
                  </span>
                }
                title={<span className="a-mono font-semibold text-kumo-strong">{target.name}</span>}
                meta={[
                  target.workersDev === undefined ? undefined : `Previews ${target.workersDev}`,
                  stored.listed === null
                    ? undefined
                    : credential === undefined
                      ? "Token removed: connect again"
                      : `Token ${credential.label}`,
                ]
                  .filter((part) => part !== undefined)
                  .join(" · ")}
                menu={
                  <RowMenu
                    label={`Actions for ${target.name}`}
                    disabled={busy}
                    items={[
                      {
                        label: "Remove",
                        danger: true,
                        select: () =>
                          void ask(async () => {
                            await targets.clearTarget(target.name);
                            await connected.read();
                          }),
                      },
                    ]}
                  />
                }
              />
            );
          })}
        </Rows>
        {connected.listed !== null && connected.listed.length === 0 && (
          <p className="px-4 py-3 text-sm text-kumo-subtle">No connected accounts</p>
        )}
        {(unset || connected.unread !== null || refused !== null || stored.unread !== null) && (
          <div className="flex flex-col gap-2 border-t border-kumo-hairline px-4 py-3">
            {unset && <p className="text-sm text-kumo-default">Not available on this instance</p>}
            <Refusal said={connected.unread} />
            <Refusal said={refused} />
            <Refusal said={stored.unread} />
          </div>
        )}
        <p className="border-t border-kumo-hairline px-4 py-3 text-sm">
          <a className="a-link" href={TOKENS_PAGE} target="_blank" rel="noreferrer">
            Revoke on Cloudflare
          </a>
        </p>
      </Box>
    </>
  );
}
