// Where an agent sends the person it asks to stand behind it. The page names the agent as Keel shows it to
// anyone, says what standing behind it is, and has one button. Opening the link approves nothing: the tap is a
// passkey touch, which signs a visitor in as it signs anyone in afresh, and then the one call.

import { Button } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import type { AgentCard } from "../contract/keel/index.ts";
import { hrefOf } from "../places.ts";
import type { KeelSponsorship } from "../source/types.ts";
import type { Account, Who } from "./account.ts";
import { Card, Refusal, useAsking } from "./parts.tsx";
import type { SponsorLink } from "./sponsorLink.ts";
import { spent, standBehind } from "./sponsoring.ts";

/** The person as a page names them: by their handle on this Keel, or by their name before they have one. */
const called = (who: Who): string => who.handle ?? who.name;

/** The agent the link names, as Keel shows it to anyone; null where Keel knows none, undefined while it is asked. */
function useAgent(
  sponsorship: KeelSponsorship,
  agentId: string | undefined,
): AgentCard | { failed: string } | null | undefined {
  const [agent, setAgent] = useState<AgentCard | { failed: string } | null>();
  useEffect(() => {
    if (agentId === undefined) return undefined;
    let here = true;
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const found = await sponsorship.findAgent(agentId, stop.signal);
        if (here) setAgent(found);
      } catch (error) {
        if (here)
          setAgent({ failed: error instanceof Error ? error.message : "Keel did not answer" });
      }
    };
    void read();
    return () => {
      here = false;
      stop.abort();
    };
  }, [sponsorship, agentId]);
  return agent;
}

export function Sponsor({
  account,
  sponsorship,
  who,
  link,
  onSignedIn,
}: {
  account: Account;
  sponsorship: KeelSponsorship;
  /** Who is reading, or null for a visitor. */
  who: Who | null;
  /** What the agent's link carried, held here and nowhere else; null where the address had none that is whole. */
  link: SponsorLink | null;
  /** Says who the touch signed in, so the frame names whoever is reading now. */
  onSignedIn: (who: Who) => void;
}) {
  // The code lives in this ref until Keel has answered it, and is then forgotten.
  const held = useRef(link);
  const [open, setOpen] = useState(link !== null);
  const [stood, setStood] = useState<Who | null>(null);
  const [changed, setChanged] = useState<Who | null>(null);
  const { busy, refused, ask } = useAsking();
  const agent = useAgent(sponsorship, link?.agentId);

  if (link === null)
    return (
      <Card title="This link is not whole" lede="Ask the agent for a new one.">
        <a className="a-link" href="/">
          Go to the projects
        </a>
      </Card>
    );
  if (agent === undefined) return null;
  if (agent === null)
    return (
      <Card title="Keel knows no agent by this link" lede="Ask the agent for a new one.">
        <a className="a-link" href="/">
          Go to the projects
        </a>
      </Card>
    );
  if ("failed" in agent)
    return (
      <Card title="Keel did not say who this agent is">
        <Refusal said={{ words: agent.failed, next: [], code: "" }} />
      </Card>
    );
  if (stood !== null)
    return (
      <Card
        title={`You stand behind ${agent.name}`}
        lede={`Its questions come to you, ${called(stood)}. You can pause it, or end this, at any time.`}
      >
        <a className="a-link" href={hrefOf({ at: "settings" })}>
          See the agents you stand behind
        </a>
      </Card>
    );

  const tap = (): Promise<void> =>
    ask(async () => {
      const mine = held.current;
      if (mine === null) return;
      setChanged(null);
      try {
        const came = await standBehind(
          {
            signIn: () => account.signInWithPasskey(),
            approve: (agentId, code) => sponsorship.approve(agentId, code),
          },
          mine,
          who,
        );
        onSignedIn(came.is === "approved" ? came.as : came.to);
        if (came.is === "changed") {
          setChanged(came.to);
          return;
        }
        held.current = null;
        setStood(came.as);
      } catch (error) {
        if (spent(error)) {
          held.current = null;
          setOpen(false);
        }
        throw error;
      }
    });

  return (
    <Card
      title={`Stand behind ${agent.name}?`}
      lede="An agent asks you to stand behind it on this Keel."
    >
      <dl className="a-panel grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 p-4 text-sm">
        <dt className="text-kumo-subtle">Agent</dt>
        <dd className="text-kumo-strong">{agent.name}</dd>
        {/* The kind is what the agent said of itself when it enrolled, and Keel vouches for none of it. */}
        <dt className="text-kumo-subtle">Declared as</dt>
        <dd className="text-kumo-default">{agent.kind}</dd>
        {agent.namespace !== undefined && (
          <>
            <dt className="text-kumo-subtle">Works in</dt>
            <dd className="text-kumo-default">
              <a className="a-link" href={`/${encodeURIComponent(agent.namespace)}`}>
                {agent.namespace}
              </a>
            </dd>
          </>
        )}
      </dl>
      <ul
        className="list-disc pl-5 text-sm text-kumo-default"
        aria-label="What standing behind it is"
      >
        <li>Its questions come to you.</li>
        <li>You can pause it, or end this, at any time.</li>
        <li>It is given none of your rights, and it never acts as you.</li>
      </ul>
      {changed !== null && (
        <output className="text-sm text-kumo-default">
          That passkey is {called(changed)}'s, and you are signed in as them now. Nothing was sent.
        </output>
      )}
      <Refusal said={refused} />
      {/* Once Keel has said the link is spent the button goes, and what to do next is Keel's to say, above. */}
      {open && (
        <div className="flex flex-col gap-2">
          <Button
            className="w-full justify-center"
            variant="primary"
            disabled={busy}
            onClick={() => void tap()}
          >
            Stand behind {agent.name}
          </Button>
          <p className="text-sm text-kumo-subtle">
            {who === null
              ? "You approve with a passkey, and the same touch signs you in. With no account here yet, sign up and open the agent's link again: it is good for ten minutes."
              : `You approve with a passkey, as ${called(who)}.`}
          </p>
        </div>
      )}
    </Card>
  );
}
