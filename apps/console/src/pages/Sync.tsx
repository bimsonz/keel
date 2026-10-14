// Sync from upstream, on an imported project's settings, for its owner: a code host's "Sync fork". Keel
// fast-forwards trunk to the head of the branch it was imported from, and refuses where trunk has commits that
// branch lacks, naming both heads.

import { Button } from "@cloudflare/kumo";
import { useState } from "react";
import { Refusal, useAsking } from "../account/parts.tsx";
import type { UpstreamSync } from "../contract/keel/index.ts";
import { useSelected } from "../engine/react.tsx";
import { branchOf, syncedSaid } from "../engine/settings.ts";
import { Link } from "../router.tsx";

export function SyncUpstream({ sync }: { sync: () => Promise<UpstreamSync> }) {
  const upstream = useSelected((world) => world.trunk.upstream);
  const head = useSelected((world) => world.trunk.head);
  const [outcome, setOutcome] = useState<UpstreamSync>();
  const { busy, refused, ask } = useAsking();
  // Trunk's first entry says whether it was imported, and Keel syncs nothing else.
  if (upstream === undefined) return null;
  const branch = branchOf(upstream.ref);
  return (
    <section className="a-panel flex flex-col gap-3 p-4" aria-label="Sync from upstream">
      <h2 className="a-h">Sync from upstream</h2>
      <p className="text-sm text-kumo-subtle">
        Fast-forward trunk to the latest commit on {branch}. Keel refuses if trunk has commits that{" "}
        {branch} does not.
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-kumo-subtle">Upstream</dt>
        <dd className="min-w-0 break-all text-kumo-default">
          <a className="a-link" href={upstream.url} rel="noreferrer" target="_blank">
            {upstream.url}
          </a>{" "}
          <span className="a-mono">{branch}</span>
        </dd>
        <dt className="text-kumo-subtle">Trunk</dt>
        <dd className="text-kumo-default">
          {head === "" ? (
            "Not read yet"
          ) : (
            <Link to={{ at: "commit", sha: head }} className="a-mono a-link">
              {head.slice(0, 7)}
            </Link>
          )}
        </dd>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void ask(async () => {
              setOutcome(undefined);
              setOutcome(await sync());
            })
          }
        >
          Sync from upstream
        </Button>
        {outcome !== undefined && (
          <output className="text-sm text-kumo-default">{syncedSaid(outcome)}</output>
        )}
      </div>
      <Refusal said={refused} />
    </section>
  );
}
