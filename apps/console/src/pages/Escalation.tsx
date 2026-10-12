// One question put to a person: to be answered here while it is open, and
// read with its answer afterwards.

import { escalationNamed } from "../engine/lists.ts";
import { usePlayer, useSelected } from "../engine/react.tsx";
import { useWhere } from "../router.tsx";
import { Notice } from "../views/Frame.tsx";
import { Escalation } from "../views/Escalation.tsx";

/**
 * The question's own address on this console, for a phone to open. It carries where the question is and
 * nothing else: no key, and nothing that answers for anyone. Whoever opens it signs in, and Keel decides.
 */
function addressOf(place: string): string {
  const address = new URL(place, window.location.origin);
  address.search = "";
  return address.href;
}

export function EscalationPage({ name }: { name: string }) {
  const player = usePlayer();
  const escalation = useSelected((world) => escalationNamed(world, name), [name]);
  // The entry is changed in place as it is ruled, so what is read of it is read again with the world.
  const state = useSelected(() => escalation?.state, [escalation]);
  const { org, to } = useWhere();
  const phoneUrl = state === "open" ? addressOf(to({ at: "escalation", name })) : undefined;
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
          ? `A member of ${org} answers this. Sign in as one to answer it here.`
          : "This fixture's own operator answers this one, a few seconds after it is asked."
      }
      {...(phoneUrl === undefined ? {} : { phoneUrl })}
      onRule={(escalationId, option) => player.rule(escalationId, option)}
    />
  );
}
