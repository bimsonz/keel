// One question put to a person: to be answered here while it is open, and
// read with its answer afterwards.

import { useEffect, useState } from "react";
import { escalationNamed } from "../engine/lists.ts";
import { usePlayer, useSelected } from "../engine/react.tsx";
import { useWhere } from "../router.tsx";
import { Notice } from "../views/Frame.tsx";
import { Escalation } from "../views/Escalation.tsx";

/**
 * A link a phone can open to answer one open question: this console's address, with a capability for that
 * question alone. A capability expires, so it is asked for again while the question stays open.
 */
function usePhoneLink(escalationId: string | undefined, open: boolean): string | undefined {
  const player = usePlayer();
  // The question is one project's, and the phone must fold that project's log to show it.
  const { project } = useWhere();
  const [link, setLink] = useState<{ for: string; url: string }>();
  const wanted =
    escalationId !== undefined && open && player.canRule(escalationId) ? escalationId : undefined;
  useEffect(() => {
    const { source } = player;
    if (wanted === undefined || source.capabilityFor === undefined) return undefined;
    let current = true;
    const refresh = async (): Promise<void> => {
      const capability = (await source.capabilityFor?.(wanted).catch(() => null)) ?? null;
      if (current && capability !== null)
        setLink({
          for: wanted,
          url: `${window.location.origin}/${encodeURIComponent(project)}?rule=${capability}`,
        });
    };
    void refresh();
    const again = window.setInterval(() => void refresh(), 240_000);
    return () => {
      current = false;
      window.clearInterval(again);
    };
  }, [player, wanted, project]);
  return link !== undefined && link.for === wanted ? link.url : undefined;
}

export function EscalationPage({ name }: { name: string }) {
  const player = usePlayer();
  const escalation = useSelected((world) => escalationNamed(world, name), [name]);
  // The entry is changed in place as it is ruled, so what is read of it is read again with the world.
  const state = useSelected(() => escalation?.state, [escalation]);
  const phoneUrl = usePhoneLink(escalation?.id, state === "open");
  if (escalation === undefined) {
    return (
      <Notice title={`There is no escalation ${name} in what Keel has said so far`}>
        A question arrives only when proof exists and the answer is a matter of judgement.
      </Notice>
    );
  }
  return (
    <Escalation
      escalation={escalation}
      world={player.world}
      answerable={player.canRule(escalation.id)}
      readOnly={
        player.live
          ? "This console is read-only: it was not opened with the presenter's key."
          : "This fixture's own operator answers this one, a few seconds after it is asked."
      }
      {...(phoneUrl === undefined ? {} : { phoneUrl })}
      onRule={(escalationId, option) => player.rule(escalationId, option)}
    />
  );
}
