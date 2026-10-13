// Which of a directory's files is its README, and where an address written in one leads.

/**
 * The names a README goes by. The first of them that a directory holds is the one shown, and letter case is
 * not told apart: `readme.md` is `README.md`.
 */
const NAMES = ["readme.md", "readme.markdown", "readme"] as const;

/** The README among a directory's entries, if it holds one. A directory by one of the names is not one. */
export function readmeAmong<Entry extends { kind: string; name: string }>(
  entries: readonly Entry[],
): Entry | undefined {
  for (const name of NAMES) {
    const found = entries.find(
      (entry) => entry.kind === "blob" && entry.name.toLowerCase() === name,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The directory a file is in, from the repository's root: "" for a file at the root. */
export function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * What every heading's id opens with, so that no heading of a README can take an id the page itself goes by.
 * A link to `#section` written in the README is led to the id with this before it.
 */
export const ANCHOR = "user-content-";

/** Where an address written in a README leads. */
export type Target =
  /** A heading of the same text, by the id its words give it. */
  | { to: "heading"; id: string }
  /** A file or a directory of the same repository, by its path from the root. */
  | { to: "path"; kind: "tree" | "blob"; path: string }
  /** Somewhere that is not this repository. */
  | { to: "elsewhere"; href: string }
  /** Nowhere: no address, one that climbs out of the repository, or one by a scheme no text may lead by. */
  | { to: "nowhere" };

/** An address that names where it is by itself: one with a scheme, or one that opens with a host. */
const NAMED = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * The only such addresses a text leads to: a page on the web, and an address to write to. Any other scheme is
 * one a browser might run or read a file by, and whoever wrote the README chose it.
 */
const LED = /^(?:https?:|mailto:|\/\/)/i;

function plain(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Where an address written in a text leads, the text being in the directory `dir` of its repository. One that
 * opens with `/` is counted from the repository's root and any other from the text's own directory; `..`
 * climbs a directory, and one that climbs out of the repository leads nowhere. Only Keel knows whether a path
 * is a file or a directory, so it is taken for a file unless it is written as a directory, with a `/` at its
 * end, or is the root itself: the page of a file that turns out to be a directory shows the directory.
 */
export function targetOf(href: string, dir: string): Target {
  if (href === "") return { to: "nowhere" };
  if (href.startsWith("#")) {
    const id = plain(href.slice(1)).toLowerCase();
    return id === "" ? { to: "nowhere" } : { to: "heading", id };
  }
  if (NAMED.test(href)) return LED.test(href) ? { to: "elsewhere", href } : { to: "nowhere" };
  const written = href.split(/[?#]/, 1)[0] ?? "";
  const parts = written.startsWith("/") || dir === "" ? [] : dir.split("/");
  for (const part of written.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(plain(part));
    else if (parts.pop() === undefined) return { to: "nowhere" };
  }
  const path = parts.join("/");
  return { to: "path", kind: path === "" || written.endsWith("/") ? "tree" : "blob", path };
}
