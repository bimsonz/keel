// A fork's bar above its code, as a code host's: the project it was forked from, Sync fork for its owners (Keel
// takes the upstream's trunk, or merges it with the fork's own work), and Propose for whoever works in it, which
// opens the form that proposes a commit back. Keel decides who may: the bar offers what the reader's role allows.

import { Button, buttonVariants } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, GitForkIcon, GitPullRequestIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Refusal, useAsking } from "../account/parts.tsx";
import type { UpstreamSync } from "../contract/keel/index.ts";
import { href, TRUNK } from "../route.ts";
import { Link } from "../router.tsx";

export interface ForkBarProps {
  /** The project it was forked from, where Keel names it to this reader. */
  upstream: { id: string; namespace: string; name: string };
  /** Sync fork, for the fork's owners alone. */
  sync?: () => Promise<UpstreamSync>;
  /** Whether the reader works in the fork, so may propose from it. */
  propose: boolean;
}

/** Keel's answer to a fork's sync, as a code host says it. */
const syncedSaid = (outcome: UpstreamSync, upstream: string): string =>
  outcome.synced
    ? `Synced with ${upstream}: trunk is at ${outcome.to.slice(0, 7)}.`
    : outcome.from === outcome.to
      ? `Already up to date with ${upstream}.`
      : `Syncing with ${upstream}: trunk moves to ${outcome.to.slice(0, 7)}.`;

export function ForkBar({ upstream, sync, propose }: ForkBarProps) {
  const [outcome, setOutcome] = useState<UpstreamSync>();
  const { busy, refused, ask } = useAsking();
  const named = `${upstream.namespace}/${upstream.name}`;
  return (
    <section className="a-banner flex-wrap" aria-label="Fork">
      <GitForkIcon size={18} weight="bold" aria-hidden />
      <p className="min-w-0 flex-1 text-base text-kumo-default">
        A fork of {/* Another project's page: a plain link, which loads it. */}
        <a
          className="a-link"
          href={href(upstream.namespace, upstream.name, {
            at: "code",
            kind: "tree",
            ref: TRUNK,
            path: "",
          })}
        >
          {named}
        </a>
      </p>
      {sync !== undefined && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void ask(async () => {
              setOutcome(undefined);
              setOutcome(await sync());
            })
          }
        >
          <ArrowsClockwiseIcon size={15} aria-hidden />
          Sync fork
        </Button>
      )}
      {propose && (
        <Link
          to={{ at: "new-proposal" }}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <GitPullRequestIcon size={15} aria-hidden />
          Propose
        </Link>
      )}
      {(outcome !== undefined || refused !== null) && (
        <div className="basis-full text-sm">
          {outcome !== undefined && (
            <output className="text-kumo-default">{syncedSaid(outcome, named)}</output>
          )}
          <Refusal said={refused} />
        </div>
      )}
    </section>
  );
}
