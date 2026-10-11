import { describe, expect, it } from "vitest";
import { BASE_FILES } from "../../fixtures/repo.ts";
import { type Inline, inline, markdown } from "../../../src/engine/markdown.ts";

const text = (of: Inline[]): string =>
  of
    .map((part) => (part.kind === "text" || part.kind === "code" ? part.text : text(part.of)))
    .join("");

describe("reading a README", () => {
  it("reads headings, paragraphs, lists and fenced code as what they are", () => {
    const readme = BASE_FILES.find((file) => file.path === "README.md")?.after ?? "";
    const blocks = markdown(readme);
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list",
      "heading",
      "code",
      "paragraph",
    ]);
    expect(blocks[0]).toEqual({ kind: "heading", level: 1, of: [{ kind: "text", text: "demo" }] });
    // A paragraph broken over lines is one paragraph.
    expect(blocks[1]?.kind === "paragraph" && text(blocks[1].of)).toBe(
      "A small service with repositories, collaborators and permissions. It is the codebase the Keel scenarios change.",
    );
    expect(blocks[3]?.kind === "list" && blocks[3].items.map(text)).toEqual([
      "src/authz: who may do what. requirePermission is the one way in.",
      "src/collaborators: adding and removing the people on a repository.",
      "src/http.ts: the request, the session and the routes' plumbing.",
    ]);
    expect(blocks[5]).toEqual({ kind: "code", language: "sh", text: "pnpm install\npnpm test" });
  });

  it("keeps what is inside a code fence exactly, whatever it looks like", () => {
    expect(markdown("```\n# not a heading\n- not a list\n**not bold**\n```")).toEqual([
      { kind: "code", language: "", text: "# not a heading\n- not a list\n**not bold**" },
    ]);
    // A fence that never closes runs to the end.
    expect(markdown("~~~ts\nconst a = 1;")).toEqual([
      { kind: "code", language: "ts", text: "const a = 1;" },
    ]);
  });

  it("reads inline code, emphasis and links, with code first", () => {
    expect(inline("Run `pnpm test` and **read** the *output*.")).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "pnpm test" },
      { kind: "text", text: " and " },
      { kind: "strong", of: [{ kind: "text", text: "read" }] },
      { kind: "text", text: " the " },
      { kind: "emphasis", of: [{ kind: "text", text: "output" }] },
      { kind: "text", text: "." },
    ]);
    expect(inline("`a * b * c` and snake_case_names")).toEqual([
      { kind: "code", text: "a * b * c" },
      { kind: "text", text: " and snake_case_names" },
    ]);
    expect(inline("See [the docs](https://example.com/docs).")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", href: "https://example.com/docs", of: [{ kind: "text", text: "the docs" }] },
      { kind: "text", text: "." },
    ]);
  });

  it("gives a link an address only when it is plainly the web's", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,x",
      "//evil.example",
      "../secrets",
      "mailto:a@example.com",
    ]) {
      expect(inline(`[click](${href})`)).toEqual([{ kind: "text", text: "click" }]);
    }
  });

  it("leaves HTML in the source as the text it is", () => {
    const blocks = markdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)"> and <b>bold</b>',
    );
    expect(blocks).toEqual([
      { kind: "paragraph", of: [{ kind: "text", text: "<script>alert(1)</script>" }] },
      {
        kind: "paragraph",
        of: [{ kind: "text", text: '<img src=x onerror="alert(2)"> and <b>bold</b>' }],
      },
    ]);
  });

  it("reads ordered lists, quotes, rules and a list item carried over a line", () => {
    const blocks = markdown(
      "1. first\n2. second\n   carried on\n\n> said once\n> and again\n\n---\n\n###### small",
    );
    expect(blocks.map((block) => block.kind)).toEqual(["list", "quote", "rule", "heading"]);
    expect(blocks[0]?.kind === "list" && [blocks[0].ordered, blocks[0].items.map(text)]).toEqual([
      true,
      ["first", "second carried on"],
    ]);
    expect(blocks[1]?.kind === "quote" && text(blocks[1].of)).toBe("said once and again");
    expect(blocks[3]).toMatchObject({ kind: "heading", level: 6 });
  });
});
