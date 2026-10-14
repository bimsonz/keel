// A namespace's credentials, as a code host has a repository's secrets: Keel's list by label, and its removal. A
// person's own are on their settings, an org's on a page of the org. No token is typed here: Keel makes the one it
// deploys with when an owner connects a project to a Cloudflare account, and nothing shows it again.

import { useCallback, useEffect, useState } from "react";
import type { Credential } from "../contract/keel/index.ts";
import type { KeelCredentials } from "../source/types.ts";
import { TOKENS_PAGE, storedOf } from "./credentials.ts";
import { Refusal, type Said, saidOf, useAsking } from "./parts.tsx";

/** Keel's answer to a read of a namespace's credentials: its list, or what it said in refusing. */
type Answer = { listed: Credential[] } | { unread: Said };

async function listing(
  credentials: KeelCredentials,
  handle: string,
  signal?: AbortSignal,
): Promise<Answer> {
  try {
    return { listed: await credentials.listCredentials(handle, signal) };
  } catch (error) {
    return { unread: saidOf(error) };
  }
}

/** Keel's list of a namespace's credentials: read when the page opens, when its tab comes back into view, and after a move. */
export function useStored(credentials: KeelCredentials, handle: string) {
  const [listed, setListed] = useState<Credential[] | null>(null);
  const [unread, setUnread] = useState<Said | null>(null);
  const read = useCallback(async (): Promise<void> => {
    const answer = await listing(credentials, handle);
    if ("listed" in answer) setListed(answer.listed);
    setUnread("unread" in answer ? answer.unread : null);
  }, [credentials, handle]);
  // Nothing is read by the clock.
  useEffect(() => {
    const stop = new AbortController();
    const first = async (): Promise<void> => {
      const answer = await listing(credentials, handle, stop.signal);
      if (stop.signal.aborted) return;
      if ("listed" in answer) setListed(answer.listed);
      setUnread("unread" in answer ? answer.unread : null);
    };
    const seen = (): void => {
      if (document.visibilityState === "visible") void first();
    };
    void first();
    document.addEventListener("visibilitychange", seen);
    return () => {
      stop.abort();
      document.removeEventListener("visibilitychange", seen);
    };
  }, [credentials, handle]);
  return { listed, unread, read };
}

/**
 * A namespace's credentials. Keel reads them, and takes one, only from the namespace's owner: anyone else who
 * reaches the page is told Keel's refusal in its words, and is offered no form.
 */
export function NamespaceCredentials({
  credentials,
  handle,
  readerId,
  owner,
  whose,
}: {
  credentials: KeelCredentials;
  handle: string;
  readerId: string;
  /** Whether the reader owns the namespace, as the page knows it: removal is offered to an owner alone. */
  owner: boolean;
  /** Whose credentials these are, in the section's own words: "yours", or an org's handle. */
  whose: string;
}) {
  const { listed, unread, read } = useStored(credentials, handle);
  const { busy, refused, ask } = useAsking();

  return (
    <section className="a-panel flex flex-col gap-3 p-4" aria-label="Credentials">
      <h2 className="a-h">Credentials</h2>
      <p className="text-sm text-kumo-subtle">
        A credential is an API token Keel made on a Cloudflare account when an owner connected one
        of {whose} projects to it, kept for those projects to deploy with. Keel seals it as it is
        made, and nothing shows it again, here or anywhere. Removing one stops every deploy target
        that names it from reaching its account; revoke it on Cloudflare too.
      </p>
      {unread !== null && <Refusal said={unread} />}
      {listed !== null && listed.length === 0 && (
        <p className="text-sm text-kumo-default">No credential is stored.</p>
      )}
      {listed !== null && listed.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Stored credentials">
          {listed.map((credential) => (
            <li
              key={credential.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-semibold text-kumo-strong [overflow-wrap:anywhere]">
                  {credential.label}
                </span>
                <span className="text-kumo-subtle">{storedOf(credential, readerId)}</span>
              </div>
              {owner && (
                <button
                  type="button"
                  className="a-link"
                  disabled={busy}
                  aria-label={`Remove ${credential.label}`}
                  onClick={() =>
                    void ask(async () => {
                      await credentials.removeCredential(handle, credential.id);
                      await read();
                    })
                  }
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {owner && listed !== null && listed.length > 0 && (
        <p className="text-sm text-kumo-subtle">
          Each token is on{" "}
          <a className="a-link" href={TOKENS_PAGE} target="_blank" rel="noreferrer">
            Cloudflare's account API tokens
          </a>{" "}
          under its label, where it is revoked.
        </p>
      )}
      <Refusal said={refused} />
    </section>
  );
}
