import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RESERVED_SEGMENTS } from "../../src/contract/keel/index.ts";
import { TEXT } from "../../src/legal/documents.ts";
import { LEGAL, type Legal, legalOf } from "../../src/legal/legal.ts";
import { Markdown } from "../../src/views/Markdown.tsx";

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
/** A document as its page draws it. */
const drawn = (which: Legal): string =>
  renderToStaticMarkup(createElement(Markdown, { source: TEXT[which] }));
const count = (which: Legal, piece: RegExp): number => drawn(which).match(piece)?.length ?? 0;
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
      const { title } = LEGAL[which];
      const dated = `Last updated: ${PUBLISHED[which].updated}`;
      // A real day, written out on a line of its own, and nothing left for an operator to fill in.
      expect(TEXT[which].split("\n").slice(0, 4)).toEqual([`# ${title}`, "", dated, ""]);
      // And so the page opens: the title as its one first heading, the day beneath it.
      expect(drawn(which)).toMatch(
        new RegExp(`^<div class="a-prose"><h1 id="[a-z-]+">${title}</h1>\\s*<p>${dated}</p>`),
      );
      expect(PUBLISHED[which].updated).toMatch(/^\d{1,2} [A-Z][a-z]+ 20\d\d$/);
      expect(TEXT[which]).not.toMatch(/\[OPERATOR|TODO|TBD/);
      expect(digestOf(TEXT[which])).toBe(PUBLISHED[which].digest);
    },
  );

  it("[legal.read] are drawn whole by the page's Markdown: every heading, and the notice's two tables", () => {
    expect([count("terms", /<h[1-6][ >]/g), count("privacy", /<h[1-6][ >]/g)]).toEqual([
      headings("terms"),
      headings("privacy"),
    ]);
    expect([count("terms", /<table>/g), count("privacy", /<table>/g)]).toEqual([0, 2]);
    for (const which of BOTH) {
      // No line of bars is left as text, and the one address either leads to is where to write to.
      expect(drawn(which)).not.toContain("|---");
      expect([
        ...new Set([...drawn(which).matchAll(/<a ([^>]*)>/g)].map(([, how]) => how)),
      ]).toEqual(['href="mailto:privacy@keel.town"']);
    }
  });
});
