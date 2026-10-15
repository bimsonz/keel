import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Player } from "../../../src/engine/player.ts";
import { ConsoleProvider } from "../../../src/engine/react.tsx";
import { ChangePage } from "../../../src/pages/Change.tsx";
import { EscalationPage } from "../../../src/pages/Escalation.tsx";
import type { Route } from "../../../src/route.ts";
import { WhereProvider } from "../../../src/router.tsx";
import { Frame } from "../../../src/views/Frame.tsx";
import { NamesProvider } from "../../../src/views/links.tsx";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { showing } from "../showing.ts";

/** A page of the fixture's project `acme/demo` as the console draws it, at `route`. */
function drawn(player: Player, route: Route, page: ReactElement): string {
  // A unit test draws with no JSX, and every provider's props name their children.
  return renderToStaticMarkup(
    createElement(ConsoleProvider, {
      player,
      // oxlint-disable-next-line react/no-children-prop
      children: createElement(WhereProvider, {
        namespace: "acme",
        project: "demo",
        route,
        // oxlint-disable-next-line react/no-children-prop
        children: createElement(NamesProvider, { children: page }),
      }),
    }),
  );
}

/** The project's frame with nothing in it, for a reader, or on a test fixture (no reader). */
const frame = (reader: { name?: string } | undefined) =>
  createElement(Frame, {
    source: { mode: "live", seed: 0 },
    ...(reader === undefined ? {} : { reader }),
    // oxlint-disable-next-line react/no-children-prop
    children: null,
  });

/** What a page says, as one line of text. */
const said = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .replaceAll("&#x27;", "'")
    .trim();

/** The fixture's whole log, read to its end: #1 and #2 both landed, C-1 between them resolved, E-1 ruled. */
async function landedPair(): Promise<Player> {
  const player = showing(createMockSource({ scenario: "s1", seed: 42 }));
  await player.load();
  player.seek(player.end);
  return player;
}

describe("the console's three rulings", () => {
  // A link names the address's carried parameters, which a browser's address holds.
  beforeEach(() =>
    vi.stubGlobal("window", { location: { search: "", origin: "https://keel.example" } }),
  );
  afterEach(() => vi.unstubAllGlobals());

  it("[change.landed-noted] a landed change's status box leads with its landing and notes a conflict it was in as one that did not hold it, linked", async () => {
    const player = await landedPair();
    const route: Route = { at: "change", name: "1", tab: "overview" };
    const page = drawn(
      player,
      route,
      createElement(ChangePage, { name: "1", tab: "overview", mode: "light" }),
    );
    const box = said(page.slice(page.indexOf('aria-label="Status"')));
    expect(box).toMatch(/^aria-label="Status"> Landed/u);
    expect(box).toContain("Noted: C-1 with #2 · didn't hold this change");
    expect(box).not.toContain("View conflict");
    // C-1 goes to the conflict, and #2 to the change.
    const noted = page.slice(page.indexOf("Noted:"), page.indexOf("didn&#x27;t hold"));
    expect(noted).toContain('href="/acme/demo/conflicts/C-1"');
    expect(noted).toContain('href="/acme/demo/changes/2"');

    // Before it landed, the conflict stood against it, and is said so.
    const before = showing(createMockSource({ scenario: "s1", seed: 42 }));
    await before.load();
    const landedAt = [...player.world.changes.values()].find(
      (change) => change.label === "#1",
    )?.landedT;
    expect(landedAt).toBeGreaterThan(0);
    before.seek((landedAt ?? 0) - 1);
    const open = said(
      drawn(
        before,
        route,
        createElement(ChangePage, { name: "1", tab: "overview", mode: "light" }),
      ),
    );
    expect(open).not.toContain("Noted:");
    expect(open).toMatch(/Conflicts? with #2/u);
  });

  it("[question.plain-head] a question's page is headed by Keel's question in plain words, with the formal claim it stands for and its label beneath", async () => {
    const player = await landedPair();
    const page = drawn(
      player,
      { at: "escalation", name: "E-1" },
      createElement(EscalationPage, { name: "E-1" }),
    );
    const heading = page.slice(page.indexOf("<h1"), page.indexOf("</h1>"));
    expect(said(`${heading}>`)).toContain("May permission checks be cached within a session?");
    expect(heading).not.toContain("E-1");
    expect(heading).not.toContain("Does permission-evaluation");
    const under = page.slice(page.indexOf("</h1>"), page.indexOf("</p>", page.indexOf("</h1>")));
    expect(said(under)).toBe(
      "Does permission-evaluation: freshness at-most per-request hold? · E-1",
    );
  });

  it("[frame.fork] Fork is in the project's header on every one of its tabs where Keel serves accounts, and not on a test fixture's", async () => {
    const player = await landedPair();
    const routes: Route[] = [
      { at: "code", kind: "tree", ref: "main", path: "" },
      { at: "changes", filter: "open", shown: 25 },
      { at: "pipeline" },
      { at: "mission-control" },
      { at: "insights", tab: "trunk" },
    ];
    const fork = /<a href="\/acme\/demo\/fork"[^>]*>.*?Fork<\/a>/u;
    const without = routes.filter(
      (route) => !fork.test(drawn(player, route, frame({ name: "Ada" }))),
    );
    expect(without).toEqual([]);
    // A visitor is offered it too, and signs in on the way.
    expect(drawn(player, routes[0]!, frame({}))).toContain('href="/acme/demo/fork"');
    // A test fixture is not Keel's to fork.
    expect(drawn(player, routes[0]!, frame(undefined))).not.toContain("/fork");
  });
});
