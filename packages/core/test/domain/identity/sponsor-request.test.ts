import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  decideSponsorRequest,
  evolvePersonAsked,
  type PersonAsked,
  SPONSOR_REQUEST_MS,
} from "../../../src/domain/identity/index.ts";
import { Instant, makeId } from "../../../src/domain/kernel/index.ts";

const facts = {
  agentId: makeId("agt", "01J00000000000000000000AGT"),
  person: makeId("usr", "01J00000000000000000000PAT"),
};
const at = (ms: number) => Instant(ms);

/** What one command commits, by event, or the refusal's tag. */
const decided = (
  asked: PersonAsked | undefined,
  command: Parameters<typeof decideSponsorRequest>[1],
) => {
  const result = decideSponsorRequest(asked, command, facts);
  return Result.isSuccess(result) ? result.success.map((event) => event._tag) : result.failure._tag;
};

describe("an agent's sponsor request to one person", () => {
  it("[sponsor.request-lapse] a request waits seven days: asked again inside them it is the same request, and after them a new one; a decline needs one still waiting", () => {
    const asked = evolvePersonAsked(
      undefined,
      { _tag: "SponsorRequested", ...facts, expiresAt: at(1_000 + SPONSOR_REQUEST_MS) },
      at(1_000),
    );
    expect(decided(asked, { _tag: "Ask", now: at(1_000 + SPONSOR_REQUEST_MS - 1) })).toEqual([]);
    expect(decided(asked, { _tag: "Ask", now: at(1_000 + SPONSOR_REQUEST_MS) })).toEqual([
      "SponsorRequested",
    ]);
    expect(
      decided(asked, { _tag: "Decline", block: false, now: at(1_000 + SPONSOR_REQUEST_MS - 1) }),
    ).toEqual(["SponsorRequestDeclined"]);
    expect(
      decided(asked, { _tag: "Decline", block: false, now: at(1_000 + SPONSOR_REQUEST_MS) }),
    ).toBe("SponsorRequestRefused");
  });

  it("[sponsor.request-block] a decline with a block refuses the next ask until an unblock, and an unblock of an agent not blocked is refused", () => {
    const declined = evolvePersonAsked(
      { expiresAt: at(10_000) },
      { _tag: "SponsorRequestDeclined", ...facts, blocked: true },
      at(5_000),
    );
    expect(declined).toEqual({ blockedAt: 5_000 });
    expect(decided(declined, { _tag: "Ask", now: at(6_000) })).toBe("SponsorRequestRefused");
    const lifted = evolvePersonAsked(declined, { _tag: "SponsorBlockLifted", ...facts }, at(7_000));
    expect(lifted).toEqual({});
    expect(decided(lifted, { _tag: "Ask", now: at(8_000) })).toEqual(["SponsorRequested"]);
    expect(decided(lifted, { _tag: "Unblock" })).toBe("SponsorRequestRefused");
  });
});
