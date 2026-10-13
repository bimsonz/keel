import { publicOnly } from "./audience.ts";
import { holdersOf } from "./holder.ts";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { Player } from "./player.ts";
import type { World } from "./world.ts";

const PlayerContext = createContext<Player | null>(null);

/** Hands the playhead to the views and drives it from the display's own frames. */
export function ConsoleProvider({ player, children }: { player: Player; children: ReactNode }) {
  useEffect(() => {
    let last = performance.now();
    let frame = requestAnimationFrame(function loop(now) {
      // A backgrounded tab resumes with one long frame; do not let it skip the story ahead.
      player.tick(Math.min(now - last, 250));
      last = now;
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [player]);
  return <PlayerContext.Provider value={player}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): Player {
  const player = useContext(PlayerContext);
  if (player === null) throw new Error("usePlayer needs a ConsoleProvider above it");
  return player;
}

/** Whether this reader is read the public part of the project's log alone (audience.ts). */
export function usePublicOnly(): boolean {
  return publicOnly(usePlayer().source.descriptor);
}

/** A view of the player's version that changes at most `perSecond` times a second. */
function throttled(player: Player, perSecond: number) {
  let seen = player.version;
  return {
    subscribe: (notify: () => void): (() => void) => {
      let last = 0;
      let timer: number | undefined;
      const publish = (): void => {
        timer = undefined;
        last = performance.now();
        seen = player.version;
        notify();
      };
      const off = player.subscribe(() => {
        const wait = 1000 / perSecond - (performance.now() - last);
        if (wait <= 0) publish();
        else timer ??= window.setTimeout(publish, wait);
      });
      return () => {
        off();
        if (timer !== undefined) window.clearTimeout(timer);
      };
    },
    snapshot: (): number => seen,
  };
}

/**
 * Re-renders when the world, or the playback controls, change: at once when
 * things are quiet, and at most `perSecond` times a second when events pour in.
 */
export function useWorldVersion(perSecond = 8): number {
  const player = usePlayer();
  const store = useMemo(() => throttled(player, perSecond), [player, perSecond]);
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

/**
 * Ask Keel for its card of the agent that holds each of these changes, once for each agent: the changes a page
 * names an agent beside. The log names a holder by its id alone, so its name and its handle are its card's.
 */
export function useHolderCards(changeIds: readonly string[]): void {
  const player = usePlayer();
  const shown = changeIds.join(" ");
  const asked = useSelected(
    (world) => holdersOf(world, shown === "" ? [] : shown.split(" ")).join(" "),
    [shown],
  );
  useEffect(() => player.wantCards(asked === "" ? [] : asked.split(" ")), [player, asked]);
}

/** Re-renders as the clock moves, at most `perSecond` times a second. */
export function useClock(perSecond = 4): number {
  const player = usePlayer();
  return useSyncExternalStore(player.subscribeTime, () =>
    Math.floor((player.t * perSecond) / 1000),
  );
}

/**
 * A page's own reading of the world: made again when the world changes, or when one of `inputs` does, and
 * not on every tick of the clock. Only the page on screen reads, so nothing is worked out for a page not shown.
 */
export function useSelected<Read>(
  select: (world: World, player: Player) => Read,
  inputs: readonly unknown[] = [],
): Read {
  const player = usePlayer();
  const version = useWorldVersion();
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `version` stands for the world's contents, and `select` is the caller's reading of `inputs`
  return useMemo(() => select(player.world, player), [player, player.world, version, ...inputs]);
}
