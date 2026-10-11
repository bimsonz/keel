import { describe, expect, it } from "vitest";
import { type Claim, checkCapability, mintCapability, readClaim } from "../../src/capability.ts";

const KEY = "a key only the Worker holds";
const NOW = 1_800_000_000;
const CLAIM: Claim = { escalationId: "esc_01", expires: NOW + 600, nonce: "0f3a9c" };

/** The same capability with one character of one part changed. */
function altered(capability: string, part: 0 | 1): string {
  const parts = capability.split(".");
  const text = parts[part] ?? "";
  parts[part] = `${text.slice(0, 5)}${text[5] === "A" ? "B" : "A"}${text.slice(6)}`;
  return parts.join(".");
}

describe("a capability to rule on one question", () => {
  it("is honoured as minted, and says which question it is for", async () => {
    const capability = await mintCapability(KEY, CLAIM);
    expect(capability).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(await checkCapability(KEY, capability, NOW)).toEqual({ ok: true, claim: CLAIM });
    expect(readClaim(capability)).toEqual(CLAIM);
  });

  it("is refused once it has expired, to the second", async () => {
    const capability = await mintCapability(KEY, CLAIM);
    expect(await checkCapability(KEY, capability, CLAIM.expires - 1)).toMatchObject({ ok: true });
    expect(await checkCapability(KEY, capability, CLAIM.expires)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("is refused if what it says was changed after it was signed", async () => {
    const capability = await mintCapability(KEY, CLAIM);
    // Someone rewrites the payload to name another question, or to last longer, and keeps the signature.
    const other = await mintCapability("their own key", { ...CLAIM, escalationId: "esc_02" });
    expect(
      await checkCapability(
        KEY,
        `${other.split(".")[0] ?? ""}.${capability.split(".")[1] ?? ""}`,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "forged" });
    expect(await checkCapability(KEY, altered(capability, 0), NOW)).toMatchObject({ ok: false });
    expect(await checkCapability(KEY, altered(capability, 1), NOW)).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  it("is refused if another key signed it", async () => {
    expect(await checkCapability(KEY, await mintCapability("another key", CLAIM), NOW)).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  it("is refused if it is not a capability at all", async () => {
    const malformed = await Promise.all(
      [
        "",
        "no-dot",
        "a.b.c",
        "!!.??",
        `${(await mintCapability(KEY, CLAIM)).split(".")[0] ?? ""}.`,
      ].map((text) => checkCapability(KEY, text, NOW)),
    );
    expect(malformed.map((checked) => checked.ok)).toEqual([false, false, false, false, false]);
    expect(readClaim("not-base64-json.sig")).toBeNull();
    // A good capability with something tacked on is not that capability.
    expect(await checkCapability(KEY, `${await mintCapability(KEY, CLAIM)}.more`, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
    // Signed, but naming no question.
    const empty = await mintCapability(KEY, { ...CLAIM, escalationId: "" });
    expect(await checkCapability(KEY, empty, NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});
