// "Apps acting as you", on a person's settings: each app they allowed to act as them at Keel's MCP server, and
// the way to revoke one. A revoked app's token is refused at once, and its refreshes end.

import { useEffect, useState } from "react";
import type { Account } from "./account.ts";
import type { AllowedApp } from "./apps.ts";
import { Refusal, saidOf, useAsking } from "./parts.tsx";
import { Box } from "./rows.tsx";

export function Apps({ account }: { account: Account }) {
  const [apps, setApps] = useState<readonly AllowedApp[] | null>(null);
  const [unread, setUnread] = useState<ReturnType<typeof saidOf> | null>(null);
  const { busy, refused, ask } = useAsking();

  useEffect(() => {
    let here = true;
    const read = async (): Promise<void> => {
      try {
        const listed = await account.apps();
        if (here) setApps(listed);
      } catch (error) {
        if (here) setUnread(saidOf(error));
      }
    };
    void read();
    return () => {
      here = false;
    };
  }, [account]);

  // Whatever Keel answered to a revoking, the list is read again.
  const revoke = (id: string): Promise<void> =>
    ask(async () => {
      try {
        await account.revokeApp(id);
      } finally {
        setApps(await account.apps());
      }
    });

  return (
    <Box title="Apps acting as you" {...(apps === null ? {} : { count: apps.length })}>
      {apps !== null && apps.length === 0 && (
        <p className="px-4 py-3 text-sm text-kumo-subtle">
          No app acts as you. An MCP client you connect to Keel asks you here first.
        </p>
      )}
      <ul className="divide-y divide-kumo-hairline" aria-label="Apps acting as you">
        {(apps ?? []).map((app) => (
          <li key={app.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <div className="flex min-w-0 flex-col">
              <span className="text-kumo-strong">{app.name}</span>
              <span className="text-kumo-subtle">
                Allowed {new Date(app.allowedAt).toLocaleDateString()}
              </span>
            </div>
            <button
              type="button"
              className="a-link shrink-0"
              disabled={busy}
              aria-label={`Revoke ${app.name}`}
              onClick={() => void revoke(app.id)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {(unread !== null || refused !== null) && (
        <div className="flex flex-col gap-2 border-t border-kumo-hairline px-4 py-3">
          <Refusal said={unread} />
          <Refusal said={refused} />
        </div>
      )}
    </Box>
  );
}
