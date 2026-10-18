import type { IssueNumber } from "./issue.ts";

/**
 * GitHub's closing keywords, each before `#n`, in any case and with an
 * optional colon: "Fixes #12", "closes: #3", "Resolved #45". A `#n` not right
 * after a keyword, inside a word or with a repository before it closes
 * nothing.
 */
const CLOSING = /(?<![\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d{1,9})(?!\w)/giu;

/** The issues a change's goal says it closes, each once, in the order it names them. */
export function closingNumbers(text: string): readonly IssueNumber[] {
  const seen = new Set<number>();
  for (const match of text.matchAll(CLOSING)) {
    const number = Number(match[1]);
    if (number > 0) seen.add(number);
  }
  return [...seen];
}
