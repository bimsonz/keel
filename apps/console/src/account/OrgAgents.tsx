// The agents in an org. On its members page: Keel's list as it reads a member, a form that invites one by its
// handle, and its removal where Keel would take it. On the org's home: the agents that have joined, as Keel
// reads them to anyone. Each call is Keel's own operation, and the list is read again after every one.

import { Button, Input } from "@cloudflare/kumo";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { NamespaceAgent } from "../contract/keel/index.ts";
import { hrefOf } from "../places.ts";
import type { KeelOrgAgents } from "../source/types.ts";
import type { Account, OrgPage, Who } from "./account.ts";
import {
  GRANTS,
  type Grant,
  SCOPES,
  givenOf,
  inviterOf,
  joinedOf,
  mayRemove,
  removalOf,
  standingOf,
} from "./orgAgents.ts";
import { Refusal, SELECT, saidOf, useAsking } from "./parts.tsx";

/** Keel's code, on `/v1`, for a move that wants a passkey sign-in from the last ten minutes. */
const FRESH_SIGN_IN = "auth.fresh_sign_in_required";

/** Keel's answer to a read of an org's agents: its list for this reader, or what it said in refusing. */
type Answer = { listed: readonly NamespaceAgent[] } | { unread: ReturnType<typeof saidOf> };

async function listing(agents: KeelOrgAgents, org: string, signal?: AbortSignal): Promise<Answer> {
  try {
    return { listed: await agents.listAgents(org, signal) };
  } catch (error) {
    return { unread: saidOf(error) };
  }
}

/** Keel's list of an org's agents for this reader: read when the page opens and when its tab comes back into view. */
function useListed(agents: KeelOrgAgents, org: string) {
  const [listed, setListed] = useState<readonly NamespaceAgent[] | null>(null);
  const [unread, setUnread] = useState<ReturnType<typeof saidOf> | null>(null);
  const read = useCallback(async (): Promise<void> => {
    const answer = await listing(agents, org);
    if ("listed" in answer) setListed(answer.listed);
    setUnread("unread" in answer ? answer.unread : null);
  }, [agents, org]);
  // Nothing is read by the clock.
  useEffect(() => {
    const stop = new AbortController();
    const first = async (): Promise<void> => {
      const answer = await listing(agents, org, stop.signal);
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
  }, [agents, org]);
  return { listed, unread, read };
}

/** An agent by its name, linked to its own page where Keel's row has its handle. */
function Named({ agent }: { agent: NamespaceAgent }) {
  return agent.handle === undefined ? (
    <span className="font-semibold text-kumo-strong [overflow-wrap:anywhere]">{agent.name}</span>
  ) : (
    <a
      className="a-link font-semibold [overflow-wrap:anywhere]"
      href={hrefOf({ at: "namespace", handle: agent.handle })}
    >
      {agent.name}
    </a>
  );
}

const said = (parts: readonly string[]): string => parts.filter((part) => part !== "").join(" · ");

/** What an agent declared itself as, where Keel's row says. */
const declared = (agent: NamespaceAgent): string =>
  agent.kind === undefined ? "" : `declared as ${agent.kind}`;

export function OrgAgents({
  account,
  agents,
  page,
  who,
}: {
  account: Account;
  agents: KeelOrgAgents;
  page: OrgPage;
  who: Who;
}) {
  const org = page.org.handle;
  const { listed, unread, read } = useListed(agents, org);
  const [handle, setHandle] = useState("");
  const [grant, setGrant] = useState<Grant>("work");
  const { busy, refused, ask } = useAsking();
  /** What was last asked of Keel here: asked again, as it was, once the reader has signed in afresh. */
  const last = useRef<(() => Promise<void>) | null>(null);

  const move = (what: () => Promise<void>): Promise<void> => {
    const asked = async (): Promise<void> => {
      await what();
      await read();
    };
    last.current = asked;
    return ask(asked);
  };
  const invite = (event: FormEvent): void => {
    event.preventDefault();
    const named = handle.trim();
    void move(async () => {
      await agents.inviteAgent(org, named, SCOPES[grant]);
      setHandle("");
    });
  };
  const again = (): Promise<void> =>
    ask(async () => {
      const signedIn = await account.signInWithPasskey();
      // A passkey of another account signs that account in: the page is read again as whoever it is now.
      if (signedIn.id !== who.id) {
        window.location.assign(hrefOf({ at: "org", org, tab: "members" }));
        return;
      }
      await last.current?.();
    });

  return (
    <section className="a-panel flex flex-col gap-3 p-4" aria-label="Agents">
      <h2 className="a-h">Agents</h2>
      <p className="text-sm text-kumo-subtle">
        Any member invites an agent by its handle. Whoever invites it answers for it here: its
        questions come to them first, and it acts here only while they are a member. It gets nothing
        until it accepts.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={invite}
        aria-label="Invite an agent"
      >
        <Input
          aria-label="The agent's handle"
          name="agent"
          placeholder="its-handle"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
        />
        <select
          className={SELECT}
          aria-label="What the agent may do here"
          value={grant}
          onChange={(event) => setGrant(event.target.value === "read" ? "read" : "work")}
        >
          {GRANTS.map((offered) => (
            <option key={offered.grant} value={offered.grant}>
              {offered.label}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" disabled={busy || handle.trim() === ""}>
          Invite agent
        </Button>
      </form>
      {unread !== null && <Refusal said={unread} />}
      {listed !== null && listed.length === 0 && (
        <p className="text-sm text-kumo-default">No agent has been invited into this org.</p>
      )}
      <ul className="flex flex-col gap-2" aria-label="Agents of this org">
        {(listed ?? []).map((agent) => (
          <li
            key={agent.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"
          >
            <div className="flex min-w-0 flex-col">
              <Named agent={agent} />
              <span className="text-kumo-subtle">
                {said([
                  declared(agent),
                  givenOf(agent),
                  standingOf(agent),
                  inviterOf(agent, page.members),
                ])}
              </span>
            </div>
            {mayRemove(agent, page.role, who.id) && (
              <button
                type="button"
                className="a-link"
                disabled={busy}
                aria-label={`${removalOf(agent)} ${agent.name}`}
                onClick={() =>
                  void move(async () => {
                    await agents.removeAgent(org, agent.id);
                  })
                }
              >
                {removalOf(agent)}
              </button>
            )}
          </li>
        ))}
      </ul>
      <Refusal said={refused} />
      {refused?.code === FRESH_SIGN_IN && (
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void again()}>
            Sign in again with a passkey
          </Button>
        </div>
      )}
    </section>
  );
}

/** The agents that have joined an org, as Keel reads them to anyone: who each is, and nothing of who invited it. */
export function JoinedAgents({ agents, org }: { agents: KeelOrgAgents; org: string }) {
  const { listed, unread } = useListed(agents, org);
  const joined = listed === null ? null : joinedOf(listed);
  return (
    <section className="a-panel flex flex-col gap-2 p-4" aria-label="Agents">
      <h2 className="a-h">Agents</h2>
      {unread !== null && <Refusal said={unread} />}
      {joined !== null && joined.length === 0 && (
        <p className="text-sm text-kumo-subtle">No agent has joined this org.</p>
      )}
      <ul className="flex flex-col gap-1.5" aria-label="Agents that have joined this org">
        {(joined ?? []).map((agent) => (
          <li key={agent.id} className="flex items-center justify-between gap-3 text-sm">
            <Named agent={agent} />
            <span className="text-kumo-subtle">{said([declared(agent), standingOf(agent)])}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
