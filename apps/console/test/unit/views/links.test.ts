import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConsoleProvider } from "../../../src/engine/react.tsx";
import { DecisionLink, NamesProvider } from "../../../src/views/links.tsx";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { showing } from "../showing.ts";

describe("a link to a decision", () => {
  it("[decisions.plain-chip] is drawn as its words where the source has no memory of decisions, in the chip's tone and with its title", async () => {
    const player = showing(createMockSource({ scenario: "s2", seed: 42 }));
    await player.load();
    player.seek(player.end);
    const [decision] = player.world.decisions.values();
    // The page writes the chip's tone as an attribute of its own, which a component's props do not name.
    const props = {
      id: decision?.id ?? "",
      className: "a-chip",
      "data-tone": "quiet",
      title: "Decision D-1",
      children: "D-1",
    };
    const chip = createElement(DecisionLink, props);
    const drawn = renderToStaticMarkup(
      createElement(ConsoleProvider, {
        player,
        // A unit test draws with no JSX, and both providers' props name their children.
        // oxlint-disable-next-line react/no-children-prop
        children: createElement(NamesProvider, { children: chip }),
      }),
    );
    expect(drawn).toBe('<span class="a-chip" data-tone="quiet" title="Decision D-1">D-1</span>');
  });
});
