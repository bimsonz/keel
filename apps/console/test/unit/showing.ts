import { type ConsoleSource, Player } from "../../src/engine/player.ts";

/** A playhead on one project of a source's log: the fixtures' own, unless a test names another. */
export function showing(source: ConsoleSource, project = "demo"): Player {
  const player = new Player(source);
  player.scopeTo(project);
  return player;
}
