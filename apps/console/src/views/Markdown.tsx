// A README or a document, drawn from its Markdown. Every piece on the page is an element built from the text
// as it was read: nothing in the source is ever handed to the browser as markup. Nothing here reads HTML, so
// HTML written in the source is shown as the text it is and none of it is run, and the reader's own rule for
// addresses is kept, which empties a `javascript:` address and its like.

import { type ReactNode, createContext, useContext, useEffect, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { ANCHOR, targetOf } from "../engine/readme.ts";

/** Where a text is in its repository, for the page that knows the repository's addresses. */
export interface Within {
  /** The directory the text is in, from the repository's root: "" at the root. */
  dir: string;
  /** A link to a file or a directory of the repository, drawn by the page. */
  link: (to: { kind: "tree" | "blob"; path: string }, children: ReactNode) => ReactNode;
}

const Place = createContext<Within | undefined>(undefined);

/** True beneath a link: what is drawn there is the link's words, and never a second link inside it. */
const Linked = createContext(false);

/** An address of a page on another site. */
const PAGE = /^(?:https?:)?\/\//i;

/** An address as the text wrote it, led to where it goes. One that leads nowhere is its words alone. */
function Lead({ href, children }: { href: string; children: ReactNode }) {
  const within = useContext(Place);
  const target = targetOf(href, within?.dir ?? "");
  switch (target.to) {
    case "heading": {
      const id = target.id.startsWith(ANCHOR) ? target.id : `${ANCHOR}${target.id}`;
      return <a href={`#${id}`}>{children}</a>;
    }
    case "path":
      // A text in no repository has no pages of a repository to lead to: its address is the site's own.
      return within === undefined ? <a href={href}>{children}</a> : within.link(target, children);
    case "elsewhere":
      // Another site's page opens apart, and is not told where its reader came from. An address that is no
      // page, as one to write to is, opens nothing of its own.
      return PAGE.test(target.href) ? (
        <a href={target.href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ) : (
        <a href={target.href}>{children}</a>
      );
    default:
      return children;
  }
}

const PARTS: Components = {
  a: function Anchor({ href, children }) {
    return (
      <Linked.Provider value>
        <Lead href={href ?? ""}>{children}</Lead>
      </Linked.Provider>
    );
  },
  // An image is a link by its own words and is never fetched: one from elsewhere would tell that host who is
  // reading, and Keel serves no file of a repository as an image.
  img: function Image({ src, alt }) {
    const words = alt === undefined || alt === "" ? (src ?? "") : alt;
    return useContext(Linked) ? words : <Lead href={src ?? ""}>{words}</Lead>;
  },
  table: function Table({ children }) {
    return (
      <div className="a-prose-table">
        <table>{children}</table>
      </div>
    );
  },
  th: function Head({ children, style }) {
    return (
      <th scope="col" style={style}>
        {children}
      </th>
    );
  },
};

/** The id an address's fragment names, or none where it names nothing that can be read. */
function named(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return "";
  }
}

export function Markdown({ source, within }: { source: string; within?: Within }) {
  const drawn = useRef<HTMLDivElement>(null);
  // An address that names one of this text's headings was followed by the browser before the text had come,
  // and so to nothing. Once the text is first drawn, the heading it names is brought into view.
  useEffect(() => {
    const heading = document.getElementById(named(window.location.hash));
    if (heading !== null && drawn.current?.contains(heading) === true) heading.scrollIntoView();
  }, []);
  return (
    <div className="a-prose" ref={drawn}>
      <Place.Provider value={within}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeSlug, { prefix: ANCHOR }]]}
          components={PARTS}
        >
          {source}
        </ReactMarkdown>
      </Place.Provider>
    </div>
  );
}
