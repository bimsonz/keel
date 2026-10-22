// A fork's bar above its code, as a code host's: where it was forked from, Sync fork for its owners, and Propose
// for whoever works in it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhereProvider } from "../../../src/router.tsx";
import { ForkBar, type ForkBarProps } from "../../../src/views/ForkBar.tsx";

const said = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

const drawn = (props: ForkBarProps) =>
  said(
    renderToStaticMarkup(
      createElement(WhereProvider, {
        namespace: "ann",
        project: "fork",
        route: { at: "code", kind: "tree", ref: "trunk", path: "" },
        // oxlint-disable-next-line react/no-children-prop
        children: createElement(ForkBar, props),
      }),
    ),
  );

const UPSTREAM = { id: "prj_01J9VVVVVVVVVVVVVVVVVVVVVV", namespace: "acme", name: "app" };
const sync = async () => ({ from: "a".repeat(40), to: "b".repeat(40), synced: true });

describe("a fork's bar", () => {
  // A link carries the address's own parameters, read from the page it is drawn on.
  beforeEach(() =>
    vi.stubGlobal("window", { location: { search: "", origin: "https://keel.example" } }),
  );
  afterEach(() => vi.unstubAllGlobals());

  it("[fork-bar.owner] names the project it was forked from, and offers its owner Sync fork and Propose", () => {
    const text = drawn({ upstream: UPSTREAM, sync, propose: true });
    expect(text).toContain("acme/app");
    expect(text).toContain("Sync fork");
    expect(text).toContain("Propose");
  });

  it("[fork-bar.reader] offers a reader who works in it no sync and no proposal: neither is theirs", () => {
    const text = drawn({ upstream: UPSTREAM, propose: false });
    expect(text).toContain("acme/app");
    expect(text).not.toContain("Sync fork");
    expect(text).not.toContain("Propose");
  });
});
