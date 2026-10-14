// A namespace's credentials, as a code host has a repository's secrets: Keel's list by label, a form that stores
// a provider's API token, and its removal. A person's own are on their settings, an org's on a page of the org.
// The token is typed into one field, leaves the page in the body of the one call that stores it, and the field
// is emptied as it is sent: it is in no address, no storage and no later request, and nothing shows it again.

import { Button, Input } from "@cloudflare/kumo";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Credential } from "../contract/keel/index.ts";
import type { KeelCredentials } from "../source/types.ts";
import { TOKEN_LINK, storedOf } from "./credentials.ts";
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
  /** Whether the reader owns the namespace, as the page knows it: the form is offered to an owner alone. */
  owner: boolean;
  /** Whose credentials these are, in the section's own words: "yours", or an org's handle. */
  whose: string;
}) {
  const { listed, unread, read } = useStored(credentials, handle);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const { busy, refused, ask } = useAsking();

  const store = (event: FormEvent): void => {
    event.preventDefault();
    // The token is taken out of the field as it is sent, whatever Keel answers.
    const secret = token;
    setToken("");
    void ask(async () => {
      await credentials.storeCredential(handle, { label, provider: "cloudflare", secret });
      setLabel("");
      await read();
    });
  };

  return (
    <section className="a-panel flex flex-col gap-3 p-4" aria-label="Credentials">
      <h2 className="a-h">Credentials</h2>
      <p className="text-sm text-kumo-subtle">
        A credential is a provider's API token kept by Keel for {whose} projects to deploy with.
        Keel seals it as it is stored, and nothing shows it again, here or anywhere. A project's
        owner chooses one by its label when connecting the project to an account. Removing one stops
        every deploy target that names it from reaching its account.
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
      {owner && (
        <p className="text-sm text-kumo-default">
          <a className="a-link" href={TOKEN_LINK} target="_blank" rel="noreferrer">
            Make a token on Cloudflare
          </a>{" "}
          with Workers Scripts: Edit, already chosen there, then paste it here.
        </p>
      )}
      {owner && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={store}
          aria-label="Store a credential"
        >
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
          <Button
            type="submit"
            variant="secondary"
            disabled={busy || label.trim() === "" || token.trim() === ""}
          >
            Store credential
          </Button>
        </form>
      )}
      <Refusal said={refused} />
    </section>
  );
}
