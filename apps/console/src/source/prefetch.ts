// What a page will read of Keel, asked for before the page asks: as soon as the address says where the reader
// is, and while the pointer rests on a link (or the keyboard is on it, or it is being pressed) to another page.
// Each read goes into the console's one cache (cache.ts), so the page that then asks finds it answered or on
// its way, and never asks twice. Only Keel's plain reads are asked for here; the project's log is the
// player's to read.

import { parse, TRUNK } from "../route.ts";
import { FRESH_MS } from "./cache.ts";
import { createHttpDirectory, createHttpSource } from "./http.ts";
import type { RepoAt } from "./repository.ts";

/** How many of a branch's latest commits the code's page reads for its history. */
const HISTORY = 100;

const directory = createHttpDirectory();

/** Where a page of the code reads: trunk's head is read by naming no ref, as the code's page reads it. */
const atOf = (ref: string, path: string): RepoAt => (ref === TRUNK ? { path } : { ref, path });

/** The directories above `path`, the root first: the code's page lists each beside a file. */
const above = (path: string): string[] => {
  const parts = path.split("/").filter((part) => part !== "");
  return ["", ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))];
};

/**
 * Asks Keel for what the page at an address reads: the project it names, and for its code, the directory or
 * file, the directories above it, the README beside a directory and trunk's history. A read that fails is
 * left for the page, which reads for itself and says what went wrong.
 */
export async function prefetchAddress(pathname: string, search = ""): Promise<void> {
  try {
    const { namespace, project, route } = parse(pathname, search);
    if (namespace === null || project === null) return;
    const found = await directory.findProject(namespace, project);
    if (found === null) return;
    const source = createHttpSource(found);
    const id = found.id;
    const reads: Promise<unknown>[] = [];
    switch (route.at) {
      case "code": {
        const named = route.ref === TRUNK ? {} : { ref: route.ref };
        reads.push(source.getCommits(id, { ...named, limit: HISTORY }));
        if (route.kind === "tree") {
          reads.push(source.getTree(id, atOf(route.ref, route.path)));
          // The README is asked for beside its directory, not after it: most directories that have one name it so.
          const readme = route.path === "" ? "README.md" : `${route.path}/README.md`;
          reads.push(source.getBlob(id, atOf(route.ref, readme)));
        } else reads.push(source.getBlob(id, atOf(route.ref, route.path)));
        for (const parent of route.path === "" ? [] : above(route.path))
          reads.push(source.getTree(id, atOf(route.ref, parent)));
        break;
      }
      case "commits":
        reads.push(
          source.getCommits(id, {
            ...(route.ref === TRUNK ? {} : { ref: route.ref }),
            limit: HISTORY,
          }),
        );
        break;
      case "commit":
        reads.push(source.getCommit(id, route.sha));
        break;
      default:
        // Every other page is drawn from the project's log, which the player reads; the lattices it reads first.
        reads.push(source.getLattices());
    }
    await Promise.allSettled(reads);
  } catch {
    // Nothing to do: the page reads for itself.
  }
}

/**
 * Prefetches a link's page while the reader moves towards it: on the pointer resting on it, on the keyboard
 * reaching it, and on its being pressed. One address is asked for at most once while its answers are fresh.
 */
export function installPrefetch(target: Document = document): void {
  const asked = new Map<string, number>();
  const intend = (event: Event): void => {
    const element = event.target;
    if (!(element instanceof Element)) return;
    const anchor = element.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    const address = `${url.pathname}${url.search}`;
    if (Date.now() - (asked.get(address) ?? 0) < FRESH_MS) return;
    asked.set(address, Date.now());
    void prefetchAddress(url.pathname, url.search);
  };
  target.addEventListener("pointerover", intend, { passive: true });
  target.addEventListener("focusin", intend);
  target.addEventListener("pointerdown", intend, { passive: true });
}
