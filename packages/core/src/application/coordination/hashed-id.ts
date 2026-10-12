import { sha256Hex } from "../../domain/kernel/index.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The 26 Crockford characters of the first 130 bits of `text`'s sha256: an id's body, the same for the same text. */
export function hashedIdBody(text: string): string {
  const bits = Array.from(sha256Hex(text).split(""), (digit) =>
    Number.parseInt(digit, 16).toString(2).padStart(4, "0"),
  )
    .join("")
    .slice(0, 130);
  const chars = Array.from(
    { length: 26 },
    (_, i) => CROCKFORD[Number.parseInt(bits.slice(i * 5, i * 5 + 5), 2)] ?? "0",
  );
  return chars.join("");
}
