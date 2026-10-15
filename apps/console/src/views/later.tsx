// The heaviest things the page draws, loaded when a page first draws one: the
// code viewer, which carries the highlighter, the reader of Markdown, and
// Mission Control's canvas. The home, a handle's page, the account pages and
// every list draw none of them, so they are not in the script those pages wait
// for. Each is asked for by the pages that draw it and by nothing else; while it
// comes, its place is empty.

import { type ComponentProps, Suspense, lazy } from "react";
import type { LineNote } from "../code/CodeDiff.tsx";
import type { Route } from "../route.ts";

export type { LineNote };

const code = () => import("../code/CodeDiff.tsx");
const mission = () => import("./MissionCanvas.tsx");
const prose = () => import("./Markdown.tsx");
const pipeline = () => import("./Pipeline.tsx");
const PipelineLater = lazy(async () => ({ default: (await pipeline()).Pipeline }));
const DiffLater = lazy(async () => ({ default: (await code()).CodeDiff }));
const FileLater = lazy(async () => ({ default: (await code()).CodeFile }));
const MissionLater = lazy(async () => ({ default: (await mission()).MissionCanvas }));
const MarkdownLater = lazy(async () => ({ default: (await prose()).Markdown }));

/** Which of them a page at each place draws. A place not listed draws none. */
const DRAWN: Partial<Record<Route["at"], readonly (() => Promise<unknown>)[]>> = {
  commit: [code],
  change: [code],
  conflict: [code],
  "mission-control": [mission],
  pipeline: [pipeline],
};

/** How long a directory's page is left alone before the viewer is asked for, in milliseconds. */
export const IDLE = 1_200;

/**
 * Asks for what the page at a place will draw, as soon as the address says where the reader is: Keel is being
 * read meanwhile, so the code is not kept waiting for its viewer once Keel has answered. A directory draws a
 * list and no code, so it is not kept waiting for the viewer either: there the viewer is asked for a moment
 * later, once the page is up, so that the first file opened from it has its viewer already. What a directory
 * does draw is its README, so the reader of Markdown is asked for at once. Answers with a way to call the
 * viewer off, for a reader who has gone elsewhere by then.
 */
export function warm(route: Route): () => void {
  if (route.at === "code" && route.kind === "tree") {
    void prose().catch(() => undefined);
    const later = setTimeout(() => void code().catch(() => undefined), IDLE);
    return () => clearTimeout(later);
  }
  const drawn = route.at === "code" ? [code] : (DRAWN[route.at] ?? []);
  for (const ask of drawn) void ask().catch(() => undefined);
  return () => undefined;
}

export function CodeDiff(props: ComponentProps<typeof DiffLater>) {
  return (
    <Suspense fallback={null}>
      <DiffLater {...props} />
    </Suspense>
  );
}

export function CodeFile(props: ComponentProps<typeof FileLater>) {
  return (
    <Suspense fallback={null}>
      <FileLater {...props} />
    </Suspense>
  );
}

export function MissionCanvas(props: ComponentProps<typeof MissionLater>) {
  return (
    <Suspense fallback={null}>
      <MissionLater {...props} />
    </Suspense>
  );
}

export function Markdown(props: ComponentProps<typeof MarkdownLater>) {
  return (
    <Suspense fallback={null}>
      <MarkdownLater {...props} />
    </Suspense>
  );
}

export function Pipeline(props: ComponentProps<typeof PipelineLater>) {
  return (
    <Suspense fallback={null}>
      <PipelineLater {...props} />
    </Suspense>
  );
}
