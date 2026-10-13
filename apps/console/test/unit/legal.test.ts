import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RESERVED_SEGMENTS } from "../../src/contract/keel/index.ts";
import { markdown } from "../../src/engine/markdown.ts";
import { TEXT } from "../../src/legal/documents.ts";
import { LEGAL, type Legal, legalOf } from "../../src/legal/legal.ts";

/**
 * Each document as it was last published: the date under its title, and a digest of everything else in it.
 * The text cannot change without this table changing, and whoever changes a digest here changes the date
 * beside it to the day the new text is published.
 */
const PUBLISHED: Record<Legal, { updated: string; digest: string }> = {
  terms: { updated: "13 October 2026", digest: "e047ebcdd3bf4dd0" },
  privacy: { updated: "13 October 2026", digest: "2ec2f31aff0b4c43" },
};

const DATED = /^Last updated: (.+)$/m;
const digestOf = (text: string): string =>
  createHash("sha256").update(text.replace(DATED, "Last updated:")).digest("hex").slice(0, 16);

const BOTH: Legal[] = ["terms", "privacy"];
const count = (which: Legal, kind: string): number =>
  markdown(TEXT[which]).filter((block) => block.kind === kind).length;
const headings = (which: Legal): number =>
  TEXT[which].split("\n").filter((line) => /^#{1,6} /.test(line)).length;

describe("the terms and the privacy notice", () => {
  it("[legal.address] are read at /terms and /privacy, which no project and no org can be called", () => {
    expect(
      ["/terms", "/privacy/", "/terms/more", "/orgs/terms", "/", "/demo"].map(legalOf),
    ).toEqual(["terms", "privacy", null, null, null, null]);
    expect(Object.values(LEGAL).map((document) => document.href)).toEqual(["/terms", "/privacy"]);
    for (const which of BOTH) expect(RESERVED_SEGMENTS).toContain(which);
  });

  it.each(BOTH)(
    "[legal.dated] %s opens with its title and the day it was last changed, and its text is tied to that day",
    (which) => {
      const [title, dated] = markdown(TEXT[which]);
      expect(title).toEqual({
        kind: "heading",
        level: 1,
        of: [{ kind: "text", text: LEGAL[which].title }],
      });
      // A real day, written out, and nothing left for an operator to fill in.
      expect(dated).toEqual({
        kind: "paragraph",
        of: [{ kind: "text", text: `Last updated: ${PUBLISHED[which].updated}` }],
      });
      expect(PUBLISHED[which].updated).toMatch(/^\d{1,2} [A-Z][a-z]+ 20\d\d$/);
      expect(TEXT[which]).not.toMatch(/\[OPERATOR|TODO|TBD/);
      expect(digestOf(TEXT[which])).toBe(PUBLISHED[which].digest);
    },
  );

  it("[legal.read] are read whole by the console's own Markdown: every heading, and the notice's two tables", () => {
    expect([count("terms", "heading"), count("privacy", "heading")]).toEqual([
      headings("terms"),
      headings("privacy"),
    ]);
    expect([count("terms", "table"), count("privacy", "table")]).toEqual([0, 2]);
    // No line of bars is left as text, and nothing in either is a link to somewhere else.
    for (const which of BOTH) {
      expect(JSON.stringify(markdown(TEXT[which]))).not.toMatch(/\|---|"kind":"link"/);
    }
  });
});
