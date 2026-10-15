// "Sessions", on a person's settings: Keel's list of where they are signed in, with the session this page is
// asking with marked, and the way to end any other. Signing out here, or everywhere else, is under it.

import { Button } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import type { Account, OwnSession } from "./account.ts";
import { Refusal, saidOf, useAsking } from "./parts.tsx";
import { Box } from "./rows.tsx";
import { rowsOf } from "./sessions.ts";

export function Sessions({ account, onSignedOut }: { account: Account; onSignedOut: () => void }) {
  const [sessions, setSessions] = useState<readonly OwnSession[] | null>(null);
  const [unread, setUnread] = useState<ReturnType<typeof saidOf> | null>(null);
  const [ended, setEnded] = useState(false);
  const { busy, refused, ask } = useAsking();

  // Read when the page opens and when its tab comes back into view. Nothing is read by the clock.
  useEffect(() => {
    let here = true;
    const read = async (): Promise<void> => {
      try {
        const listed = await account.sessions();
        if (here) {
          setSessions(listed);
          setUnread(null);
        }
      } catch (error) {
        if (here) setUnread(saidOf(error));
      }
    };
    const seen = (): void => {
      if (document.visibilityState === "visible") void read();
    };
    void read();
    document.addEventListener("visibilitychange", seen);
    return () => {
      here = false;
      document.removeEventListener("visibilitychange", seen);
    };
  }, [account]);

  // Whatever Keel answered to an ending, the list is read again: a session ended somewhere else leaves it too.
  const after = async (what: () => Promise<void>): Promise<void> => {
    try {
      await what();
    } finally {
      setSessions(await account.sessions());
    }
  };

  return (
    <Box
      title="Sessions"
      {...(sessions === null ? {} : { count: sessions.length })}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void ask(() =>
                after(async () => {
                  await account.signOutElsewhere();
                  setEnded(true);
                }),
              )
            }
          >
            Sign out everywhere else
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void ask(async () => {
                await account.signOut();
                onSignedOut();
              })
            }
          >
            Sign out
          </Button>
        </div>
      }
    >
      <ul className="divide-y divide-kumo-hairline" aria-label="Your sessions">
        {rowsOf(sessions ?? []).map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <div className="flex min-w-0 flex-col">
              <span className="text-kumo-strong" title={row.userAgent}>
                {row.device}
                {row.current && <span className="text-kumo-subtle"> · this session</span>}
              </span>
              <span className="text-kumo-subtle">
                {row.signedIn} · last used {row.lastUsed}
              </span>
            </div>
            {!row.current && (
              <button
                type="button"
                className="a-link shrink-0"
                disabled={busy}
                aria-label={`End the session on ${row.device}`}
                onClick={() => void ask(() => after(() => account.endSession(row.id)))}
              >
                End
              </button>
            )}
          </li>
        ))}
      </ul>
      {(unread !== null || refused !== null || ended) && (
        <div className="flex flex-col gap-2 border-t border-kumo-hairline px-4 py-3">
          <Refusal said={unread} />
          {ended && <p className="text-sm text-kumo-default">Every other session is ended.</p>}
          <Refusal said={refused} />
        </div>
      )}
    </Box>
  );
}
