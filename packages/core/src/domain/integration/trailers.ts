/**
 * The trailers Keel writes on each commit it lands on trunk: `Change-Id`, the
 * change the commit is, then `Keel-Agent` and `Keel-Run`.
 */
import { Option, Schema } from "effect";
import { ChangeId } from "../kernel/index.ts";

const decodeChangeId = Schema.decodeUnknownOption(ChangeId);

/**
 * The change a trunk commit landed, from the message's `Change-Id` trailer.
 * The last such line wins, as git's trailer parsing reads it; a commit Keel
 * did not land (an import, a seed) names none.
 */
export const changeIdOf = (message: string): ChangeId | undefined => {
  const ids = [...message.matchAll(/^Change-Id: (\S+)$/gm)].map((m) => m[1]);
  return Option.getOrUndefined(decodeChangeId(ids.at(-1)));
};
