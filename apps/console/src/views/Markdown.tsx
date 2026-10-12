// A README, drawn from the blocks it was read into. Every piece is an
// element built here: nothing in the source is ever handed to the browser
// as markup.

import type { ReactNode } from "react";
import { type Block, type Inline, markdown } from "../engine/markdown.ts";

function spans(of: Inline[]): ReactNode {
  return of.map((part, index) => {
    // oxlint-disable-next-line react/no-array-index-key -- the pieces of a line are known by their place in it
    const key = index;
    if (part.kind === "text") return part.text;
    if (part.kind === "code") return <code key={key}>{part.text}</code>;
    if (part.kind === "strong") return <strong key={key}>{spans(part.of)}</strong>;
    if (part.kind === "emphasis") return <em key={key}>{spans(part.of)}</em>;
    return (
      <a key={key} href={part.href} target="_blank" rel="noreferrer">
        {spans(part.of)}
      </a>
    );
  });
}

function block(piece: Block, key: number): ReactNode {
  switch (piece.kind) {
    case "heading": {
      const Tag = (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[piece.level - 1] ?? "h6";
      return <Tag key={key}>{spans(piece.of)}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{spans(piece.of)}</p>;
    case "code":
      return (
        <pre key={key}>
          <code>{piece.text}</code>
        </pre>
      );
    case "list": {
      const items = piece.items.map((item, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- a list's items are known by their place in it
        <li key={index}>{spans(item)}</li>
      ));
      return piece.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "quote":
      return <blockquote key={key}>{spans(piece.of)}</blockquote>;
    case "table":
      return (
        <div key={key} className="a-prose-table">
          <table>
            <thead>
              <tr>
                {piece.head.map((cell, column) => (
                  // oxlint-disable-next-line react/no-array-index-key -- a cell is known by its place in the row
                  <th key={column} scope="col">
                    {spans(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {piece.rows.map((row, at) => (
                // oxlint-disable-next-line react/no-array-index-key -- a row is known by its place in the table
                <tr key={at}>
                  {row.map((cell, column) => (
                    // oxlint-disable-next-line react/no-array-index-key -- a cell is known by its place in the row
                    <td key={column}>{spans(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return <hr key={key} />;
  }
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="a-prose">{markdown(source).map((piece, index) => block(piece, index))}</div>
  );
}
