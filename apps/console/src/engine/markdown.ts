// Reads Markdown into blocks, for a README. It reads what a README is made
// of: headings, paragraphs, lists, quotes, rules, fenced code, tables, and
// inline code, emphasis and links. Anything else is text, and so is any HTML in the
// source: it is shown as it was written, never run.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; of: Inline[] }
  | { kind: "emphasis"; of: Inline[] }
  | { kind: "link"; href: string; of: Inline[] };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; of: Inline[] }
  | { kind: "paragraph"; of: Inline[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; of: Inline[] }
  /** Every row has as many cells as the head. */
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

// Code first: nothing inside backticks is read as anything else. An address may hold one pair of brackets of its own.
const SPAN =
  /(`+)(.+?)\1(?!`)|\*\*(.+?)\*\*|\*([^\s*](?:.*?[^\s*])?)\*|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/s;

/** A link goes somewhere only if it is plainly the web's. Anything else keeps its words and loses its address. */
const SAFE = /^https?:\/\//i;

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest !== "") {
    const found = SPAN.exec(rest);
    if (found === null) {
      out.push({ kind: "text", text: rest });
      break;
    }
    if (found.index > 0) out.push({ kind: "text", text: rest.slice(0, found.index) });
    const [whole, , code, strong, emphasis, label, href] = found;
    if (code !== undefined) out.push({ kind: "code", text: code.trim() });
    else if (strong !== undefined) out.push({ kind: "strong", of: inline(strong) });
    else if (emphasis !== undefined) out.push({ kind: "emphasis", of: inline(emphasis) });
    else if (label !== undefined && href !== undefined)
      out.push(
        ...(SAFE.test(href) ? [{ kind: "link" as const, href, of: inline(label) }] : inline(label)),
      );
    rest = rest.slice(found.index + whole.length);
  }
  return out;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
const ITEM = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

function level(hashes: string): 1 | 2 | 3 | 4 | 5 | 6 {
  const depth = hashes.length;
  return depth === 1 || depth === 2 || depth === 3 || depth === 4 || depth === 5 ? depth : 6;
}

/** A table's line: it opens with a bar. The rule under a table's head: bars, dashes and colons, and nothing else. */
const ROW = /^\s*\|/;
const UNDER = /^\s*\|\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

export function markdown(source: string): Block[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", of: inline(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flush();
      const body: string[] = [];
      // To the closing fence, or the end: what is inside is kept exactly.
      for (
        i += 1;
        i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "```");
        i += 1
      )
        body.push(lines[i] ?? "");
      blocks.push({ kind: "code", language: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({
        kind: "heading",
        level: level(heading[1] ?? "#"),
        of: inline(heading[2] ?? ""),
      });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    // Lines of bars are a table only where the line under the first says so.
    if (ROW.test(line) && UNDER.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && ROW.test(lines[i] ?? ""); i += 1)
        rows.push(head.map((_, column) => cells(lines[i] ?? "")[column] ?? ""));
      i -= 1;
      blocks.push({
        kind: "table",
        head: head.map((cell) => inline(cell)),
        rows: rows.map((row) => row.map((cell) => inline(cell))),
      });
      continue;
    }
    const item = ITEM.exec(line);
    if (item !== null) {
      flush();
      const ordered = item[1] !== undefined;
      const items: string[] = [];
      for (; i < lines.length; i += 1) {
        const next = ITEM.exec(lines[i] ?? "");
        if (next !== null && (next[1] !== undefined) === ordered) items.push(next[2] ?? "");
        // An indented line carries the item above it on.
        else if (/^\s+\S/.test(lines[i] ?? "") && items.length > 0)
          items[items.length - 1] = `${items.at(-1) ?? ""} ${(lines[i] ?? "").trim()}`;
        else break;
      }
      i -= 1;
      blocks.push({ kind: "list", ordered, items: items.map((text) => inline(text)) });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote !== null) {
      flush();
      const said: string[] = [];
      for (; i < lines.length; i += 1) {
        const next = QUOTE.exec(lines[i] ?? "");
        if (next === null) break;
        said.push(next[1] ?? "");
      }
      i -= 1;
      blocks.push({ kind: "quote", of: inline(said.join(" ")) });
      continue;
    }
    if (line.trim() === "") flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
