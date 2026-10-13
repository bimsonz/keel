import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, type Within } from "../../../src/views/Markdown.tsx";

/** A page that draws a repository's own links as `/p/<kind>/<path>`. */
const within = (dir: string): Within => ({
  dir,
  link: (to, children) => createElement("a", { href: `/p/${to.kind}/${to.path}` }, children),
});

const drawn = (source: string, at?: Within): string =>
  renderToStaticMarkup(
    createElement(Markdown, at === undefined ? { source } : { source, within: at }),
  );

/** Every link drawn, as `address > words`, with how it opens where it says. */
const links = (html: string): string[] =>
  [...html.matchAll(/<a href="([^"]*)"([^>]*)>(.*?)<\/a>/g)].map(
    ([, href, how, words]) => `${href} >${how === "" ? "" : ` [${how?.trim()}]`} ${words}`,
  );

describe("a text drawn from its Markdown", () => {
  it("[markdown.no-html] shows HTML written in it as the text it is, and makes no element of any of it", () => {
    const html = drawn(
      [
        "# Title",
        "",
        "<script>window.ran = true</script>",
        "",
        '<img src="x" onerror="window.ran = true">',
        "",
        'A <b>bold</b> word and a frame: <iframe src="https://frames.example/"></iframe>.',
      ].join("\n"),
    );
    expect(html).not.toMatch(/<(?:script|img|iframe|b)\b/);
    expect(html).toContain("&lt;script&gt;window.ran = true&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("[markdown.address] leads nowhere from an address that would run a script", () => {
    const html = drawn(
      "[run](javascript:alert(1)) [data](data:text/html,x) ![shot](javascript:alert(2)) [fine](https://keel.example/a)",
    );
    expect(html).not.toMatch(/javascript:|data:/);
    expect(links(html)).toEqual([
      'https://keel.example/a > [target="_blank" rel="noreferrer"] fine',
    ]);
  });

  it("[markdown.anchored] gives a heading an id from its words, and leads a link to #words to it", () => {
    const html = drawn(
      "## Getting started\n\n### Run it\n\n[one](#getting-started) [two](#Run-It)\n\nNoted.[^1]\n\n[^1]: The note.",
    );
    expect(html).toContain('<h2 id="user-content-getting-started">Getting started</h2>');
    expect(html).toContain('<h3 id="user-content-run-it">Run it</h3>');
    expect(links(html).slice(0, 2)).toEqual([
      "#user-content-getting-started > one",
      "#user-content-run-it > two",
    ]);
    // A footnote's own two links are made with the same opening, and are left as made.
    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain('id="user-content-fn-1"');
    expect(html).not.toContain("user-content-user-content");
  });

  it("[markdown.elsewhere] opens an address elsewhere apart, and sends that site no referrer", () => {
    expect(
      links(
        drawn("[site](https://example.org/x) <https://example.org/y> [cdn](//cdn.example.org)"),
      ),
    ).toEqual([
      'https://example.org/x > [target="_blank" rel="noreferrer"] site',
      'https://example.org/y > [target="_blank" rel="noreferrer"] https://example.org/y',
      '//cdn.example.org > [target="_blank" rel="noreferrer"] cdn',
    ]);
    // An address to write to is no page, and opens no empty one: written out or bare, it is a plain link.
    expect(links(drawn("[write](mailto:someone@example.org) or someone@example.org"))).toEqual([
      "mailto:someone@example.org > write",
      "mailto:someone@example.org > someone@example.org",
    ]);
  });

  it("[markdown.within] has the page draw a link to the repository's own files, from the directory the text is in", () => {
    const source = "[a](guide.md) [b](../src/) [c](/package.json) [out](../../etc/passwd)";
    expect(links(drawn(source, within("docs")))).toEqual([
      "/p/blob/docs/guide.md > a",
      "/p/tree/src > b",
      "/p/blob/package.json > c",
    ]);
    // What climbs out of the repository is its words and no link.
    expect(drawn(source, within("docs"))).toContain(" out</p>");
    // A text in no repository keeps such an address as it wrote it: it is the site's own.
    expect(links(drawn("[terms](/terms)"))).toEqual(["/terms > terms"]);
  });

  it("[markdown.image] draws an image as a link by its words, and fetches none", () => {
    const html = drawn(
      "![The logo](assets/logo.png) ![](https://img.example/b.svg) [![build](https://img.example/b.svg)](https://ci.example/run)",
      within(""),
    );
    expect(html).not.toContain("<img");
    expect(links(html)).toEqual([
      "/p/blob/assets/logo.png > The logo",
      'https://img.example/b.svg > [target="_blank" rel="noreferrer"] https://img.example/b.svg',
      // An image that is itself a link is that link's words: no link is drawn inside another.
      'https://ci.example/run > [target="_blank" rel="noreferrer"] build',
    ]);
  });

  it("[markdown.table] draws a table inside the box that scrolls it, each head naming its column", () => {
    const html = drawn("| What | Why |\n|---|---|\n| a | b |");
    expect(html).toContain(
      '<div class="a-prose-table"><table><thead><tr><th scope="col">What</th><th scope="col">Why</th></tr></thead>',
    );
    expect(html).toContain("<td>a</td><td>b</td>");
    expect(html).not.toContain("|---");
  });

  it("[markdown.code] draws a fenced block as the code it is, whatever is written in it", () => {
    expect(drawn("```sh\npnpm install\n<b>not bold</b>\n```")).toBe(
      '<div class="a-prose"><pre><code class="language-sh">pnpm install\n&lt;b&gt;not bold&lt;/b&gt;\n</code></pre></div>',
    );
  });
});
