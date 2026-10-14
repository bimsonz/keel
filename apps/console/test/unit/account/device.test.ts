import { describe, expect, it } from "vitest";
import type { Who } from "../../../src/account/account.ts";
import { approveTerminal } from "../../../src/account/device.ts";

const ADA: Who = { id: "ada", name: "Ada", handle: "ada" };
const GRACE: Who = { id: "grace", name: "Grace", handle: "grace" };
const MINUTE = 60_000;
const NOW = Date.parse("2026-10-14T05:00:00Z");

/**
 * The browser's session as Keel sees it, and the page's two calls on it. A passkey touch signs in afresh as the
 * passkey's account. An approval goes with the session held, and Keel gives the terminal what is left of ten
 * minutes from that session's passkey where it is a passkey sign-in of the last ten minutes, and none where it
 * is not. What was called, in order, and each terminal approved are kept.
 */
function browser(held: { who: Who; passkeyAt: number | null }, passkey: Who | Error) {
  const session = { ...held };
  const order: string[] = [];
  const terminals: { as: string; freshFor: number }[] = [];
  return {
    order,
    terminals,
    approving: {
      signIn: () => {
        order.push("passkey");
        if (passkey instanceof Error) return Promise.reject(passkey);
        session.who = passkey;
        session.passkeyAt = NOW;
        return Promise.resolve(passkey);
      },
      approve: () => {
        order.push("approve");
        const since = session.passkeyAt === null ? Infinity : NOW - session.passkeyAt;
        terminals.push({ as: session.who.id, freshFor: Math.max(0, 10 * MINUTE - since) });
        return Promise.resolve();
      },
    },
  };
}

describe("approving a terminal", () => {
  it("[device.step-up] asks an account that holds a passkey for it every time and then approves, as the account the code was claimed for and no other", async () => {
    // Ada holds a passkey, and signed in by it four minutes ago. Her session is fresh, and the touch is asked for
    // all the same: the terminal is given ten minutes from it, not the six left of her sign-in.
    const fresh = browser({ who: ADA, passkeyAt: NOW - 4 * MINUTE }, ADA);
    expect(await approveTerminal(fresh.approving, ADA, true)).toEqual({ is: "approved" });
    expect(fresh.order).toEqual(["passkey", "approve"]);
    expect(fresh.terminals).toEqual([{ as: "ada", freshFor: 10 * MINUTE }]);
    // Ada signed in by a code an hour ago, and her session is not fresh: the touch makes it so before the approval.
    const stale = browser({ who: ADA, passkeyAt: null }, ADA);
    expect(await approveTerminal(stale.approving, ADA, true)).toEqual({ is: "approved" });
    expect(stale.order).toEqual(["passkey", "approve"]);
    expect(stale.terminals).toEqual([{ as: "ada", freshFor: 10 * MINUTE }]);
    // A passkey prompt the person called off approves nothing.
    const called = browser({ who: ADA, passkeyAt: NOW - MINUTE }, new Error("called off"));
    await expect(approveTerminal(called.approving, ADA, true)).rejects.toThrow("called off");
    expect(called.order).toEqual(["passkey"]);
    expect(called.terminals).toEqual([]);
    // Ada claimed the code, and the passkey touched is Grace's: nothing is approved, and the page is told whose
    // it was.
    const other = browser({ who: ADA, passkeyAt: NOW - MINUTE }, GRACE);
    expect(await approveTerminal(other.approving, ADA, true)).toEqual({ is: "changed", to: GRACE });
    expect(other.order).toEqual(["passkey"]);
    expect(other.terminals).toEqual([]);
  });

  it("[device.no-passkey] approves for an account that holds no passkey on the sign-in it has, with no prompt, and its terminal gets no fresh window", async () => {
    // Ada signed in by a code and holds no passkey: a prompt would have none of hers to offer, and she would never
    // get past it.
    const none = browser({ who: ADA, passkeyAt: null }, new Error("No passkey of Ada's is here"));
    expect(await approveTerminal(none.approving, ADA, false)).toEqual({ is: "approved" });
    expect(none.order).toEqual(["approve"]);
    expect(none.terminals).toEqual([{ as: "ada", freshFor: 0 }]);
  });
});
