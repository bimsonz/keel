import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../fixtures/sha256.ts";

async function platform(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("SHA-256, written out", () => {
  it("gives the published digests", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("agrees with the platform's digest across block boundaries and beyond ASCII", async () => {
    const texts = [55, 56, 63, 64, 65, 119, 120, 1000, 5000]
      .map((length) => "k".repeat(length))
      .concat("freshness ≤ per-request · 鍵");
    const ours = texts.map((text) => sha256Hex(text));
    expect(ours).toEqual(await Promise.all(texts.map((text) => platform(text))));
  });
});
