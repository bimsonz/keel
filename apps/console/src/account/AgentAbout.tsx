// An agent's own page, at its handle: what Keel shows anyone of it. Keel's
// public card is the whole of it: its name, the kind it declared, the
// namespace it works in and the orgs it has joined. Who sponsors an
// agent, and who invited it anywhere, is never on this page.
// The one person who does is told so from their own list of the agents they
// sponsor, and is sent to their settings, where the controls are.

import { useEffect, useState } from "react";
import type { AgentCard } from "../contract/keel/index.ts";
import { hrefOf } from "../places.ts";
import type { KeelAgents, KeelSponsorship } from "../source/types.ts";

/** Keel's card of an agent: undefined while it is asked for, null where Keel has none or would not say. */
export function useCard(sponsorship: KeelAgents, agentId: string): AgentCard | null | undefined {
  const [card, setCard] = useState<AgentCard | null>();
  useEffect(() => {
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const found = await sponsorship.findAgent(agentId, stop.signal);
        if (!stop.signal.aborted) setCard(found);
      } catch {
        if (!stop.signal.aborted) setCard(null);
      }
    };
    void read();
    return () => stop.abort();
  }, [sponsorship, agentId]);
  return card;
}

/**
 * Whether the reader sponsors this agent, as Keel's own list of the agents they sponsor says. A
 * visitor is asked nothing: Keel lists to the signed-in person alone. Nothing on the agent's card says it.
 */
function useSponsors(sponsorship: KeelSponsorship, agentId: string, signedIn: boolean): boolean {
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    if (!signedIn) return undefined;
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const listed = await sponsorship.listSponsored(stop.signal);
        if (!stop.signal.aborted) setBehind(listed.some((one) => one.id === agentId));
      } catch {
        // Keel did not say: the line is for the one person it would name, and is left out.
      }
    };
    void read();
    return () => stop.abort();
  }, [sponsorship, agentId, signedIn]);
  return behind;
}

export function AgentAbout({
  sponsorship,
  agentId,
  signedIn,
}: {
  sponsorship: KeelSponsorship;
  /** Keel's id of the agent whose handle the page is at: its namespace's own id. */
  agentId: string;
  signedIn: boolean;
}) {
  const card = useCard(sponsorship, agentId);
  const behind = useSponsors(sponsorship, agentId, signedIn);
  if (card === undefined) return null;
  return (
    <section className="a-panel flex flex-col gap-2 p-4" aria-label="Agent">
      <h2 className="a-h">Agent</h2>
      {card === null ? (
        <p className="text-sm text-kumo-subtle">Keel showed no card for this agent.</p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-kumo-subtle">Name</dt>
          <dd className="text-kumo-default">{card.name}</dd>
          {/* The kind is the agent's own word for itself, and is written as that. */}
          {card.kind !== undefined && (
            <>
              <dt className="text-kumo-subtle">Declared as</dt>
              <dd className="text-kumo-default">{card.kind}</dd>
            </>
          )}
          {card.namespace !== undefined && (
            <>
              <dt className="text-kumo-subtle">Works in</dt>
              <dd>
                <a
                  className="a-link a-mono"
                  href={hrefOf({ at: "namespace", handle: card.namespace })}
                >
                  {card.namespace}
                </a>
              </dd>
            </>
          )}
          {/* The orgs it has joined, as its card names them: none where an invitation still waits. */}
          {card.orgs !== undefined && card.orgs.length > 0 && (
            <>
              <dt className="text-kumo-subtle">Joined</dt>
              <dd className="flex flex-wrap gap-x-3 gap-y-1">
                {card.orgs.map((org) => (
                  <a
                    key={org.handle}
                    className="a-link a-mono"
                    href={hrefOf({ at: "namespace", handle: org.handle })}
                  >
                    {org.handle}
                  </a>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}
      {behind && (
        <p className="text-sm text-kumo-subtle">
          You sponsor this agent.{" "}
          <a className="a-link" href={hrefOf({ at: "settings" })}>
            Manage it in your settings
          </a>
        </p>
      )}
    </section>
  );
}
