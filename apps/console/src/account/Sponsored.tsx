// "Agents you stand behind", on a person's settings: Keel's list of the agents they sponsor, and the three
// things a sponsor may ask of one. Each is Keel's own operation, and what a row says after it is Keel's answer.

import { Button, Input } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import type { AgentProfile } from "../contract/keel/index.ts";
import { hrefOf } from "../places.ts";
import type { KeelSponsorship } from "../source/types.ts";
import type { Account, Who } from "./account.ts";
import { Refusal, saidOf, useAsking } from "./parts.tsx";
import { type Control, afterMove, controlsOf, reasonOf, standingOf } from "./sponsored.ts";

/** Keel's code, on `/v1`, for a move that wants a passkey sign-in from the last ten minutes. */
const FRESH_SIGN_IN = "auth.fresh_sign_in_required";

const LABEL: Record<Control, string> = { pause: "Pause", unpause: "Unpause", end: "End" };

export function Sponsored({
  account,
  sponsorship,
  who,
}: {
  account: Account;
  sponsorship: KeelSponsorship;
  who: Who;
}) {
  const [agents, setAgents] = useState<readonly AgentProfile[] | null>(null);
  const [unread, setUnread] = useState<ReturnType<typeof saidOf> | null>(null);
  const [why, setWhy] = useState<Record<string, string>>({});
  const { busy, refused, ask } = useAsking();
  /** What was last asked of Keel here: asked again, as it was, once the reader has signed in afresh. */
  const last = useRef<(() => Promise<void>) | null>(null);

  // Read when the page opens and when its tab comes back into view. Nothing is read by the clock.
  useEffect(() => {
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const listed = await sponsorship.listSponsored(stop.signal);
        if (!stop.signal.aborted) {
          setAgents(listed);
          setUnread(null);
        }
      } catch (error) {
        if (!stop.signal.aborted) setUnread(saidOf(error));
      }
    };
    const seen = (): void => {
      if (document.visibilityState === "visible") void read();
    };
    void read();
    document.addEventListener("visibilitychange", seen);
    return () => {
      stop.abort();
      document.removeEventListener("visibilitychange", seen);
    };
  }, [sponsorship]);

  const move = (agent: AgentProfile, control: Control): Promise<void> => {
    const what = async (): Promise<void> => {
      const answered =
        control === "pause"
          ? await sponsorship.pause(agent.id, reasonOf(why[agent.id] ?? ""))
          : control === "unpause"
            ? await sponsorship.unpause(agent.id)
            : await sponsorship.end(agent.id);
      setAgents((listed) => (listed === null ? listed : afterMove(listed, answered, who.id)));
    };
    last.current = what;
    return ask(what);
  };
  const again = (): Promise<void> =>
    ask(async () => {
      const signedIn = await account.signInWithPasskey();
      // A passkey of another account signs that account in: the page is read again as whoever it is now.
      if (signedIn.id !== who.id) {
        window.location.assign(hrefOf({ at: "settings" }));
        return;
      }
      await last.current?.();
    });

  return (
    <section className="a-panel flex flex-col gap-3 p-4" aria-label="Agents you stand behind">
      <h2 className="a-h">Agents you stand behind</h2>
      <p className="text-sm text-kumo-subtle">
        An agent's questions come to the person who stands behind it. You can pause one, or end
        this, at any time. An agent asks by showing you a link.
      </p>
      {unread !== null && <Refusal said={unread} />}
      {agents !== null && agents.length === 0 && (
        <p className="text-sm text-kumo-default">You stand behind no agent.</p>
      )}
      <ul className="flex flex-col gap-3" aria-label="The agents you stand behind">
        {(agents ?? []).map((agent) => {
          const controls = controlsOf(agent.state);
          return (
            <li key={agent.id} className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
              <div className="flex min-w-0 flex-col text-sm">
                <span className="font-semibold text-kumo-strong">{agent.name}</span>
                <span className="text-kumo-subtle">
                  {[`declared as ${agent.kind}`, standingOf(agent.state)]
                    .filter((part) => part !== "")
                    .join(" · ")}
                </span>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                {controls.includes("pause") && (
                  <Input
                    aria-label={`Why pause ${agent.name} (optional, kept in Keel's record)`}
                    name={`why-${agent.id}`}
                    placeholder="Why (optional)"
                    value={why[agent.id] ?? ""}
                    onChange={(event) =>
                      setWhy((typed) => ({ ...typed, [agent.id]: event.target.value }))
                    }
                  />
                )}
                {controls.map((control) => (
                  <Button
                    key={control}
                    variant="secondary"
                    disabled={busy}
                    aria-label={`${LABEL[control]} ${agent.name}`}
                    onClick={() => void move(agent, control)}
                  >
                    {LABEL[control]}
                  </Button>
                ))}
              </div>
            </li>
          );
        })}
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
