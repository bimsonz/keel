// The project's code: its files at a commit, trunk's history, and one commit.

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlayer, useSelected, useWorldVersion } from "../engine/react.tsx";
import { type Browsing, type RepoAddress, repositoryOf } from "../engine/repository.ts";
import { type Route, TRUNK } from "../route.ts";
import { navigate, useWhere } from "../router.tsx";
import type { Mode } from "../theme/mode.ts";
import { Repository } from "../views/Repository.tsx";

type CodeRoute = Extract<Route, { at: "code" | "commits" | "commit" }>;

function addressOf(route: CodeRoute): RepoAddress {
  if (route.at === "commit") return { view: "history", path: "", commit: route.sha };
  const at = route.ref === TRUNK ? {} : { ref: route.ref };
  return route.at === "commits"
    ? { view: "history", path: "", ...at }
    : { view: "code", path: route.path, kind: route.kind, ...at };
}

/** True where `directory` is `path`, or on the way to it. */
const leadsTo = (directory: string, path: string): boolean =>
  path === directory || path.startsWith(`${directory}/`);

export function CodePage({ route, mode }: { route: CodeRoute; mode: Mode }) {
  const player = usePlayer();
  const version = useWorldVersion();
  const where = useWhere();
  const address = useMemo(() => addressOf(route), [route]);

  // The list of files beside the code: what a reader has opened in it and closed in it. It lasts while they read the code.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  // Going somewhere opens the way to it, whatever was closed before.
  const [arrivedAt, setArrivedAt] = useState(address.path);
  if (arrivedAt !== address.path) {
    setArrivedAt(address.path);
    setClosed(
      (before) => new Set([...before].filter((directory) => !leadsTo(directory, address.path))),
    );
  }
  const browsing = useMemo((): Browsing => ({ opened, closed }), [opened, closed]);
  const toggle = useCallback((directory: string, open: boolean): void => {
    const [into, outOf] = open ? [setOpened, setClosed] : [setClosed, setOpened];
    into((before) => new Set([...before, directory]));
    outOf((before) => new Set([...before].filter((each) => each !== directory)));
  }, []);

  // Read from Keel as the page asks for it, and again whenever what is known changes.
  useEffect(() => {
    player.repository.want(address, player.world.trunk.head, opened);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `version` stands for the world's contents: trunk's head moves, and what was read says what to read next
  }, [player, address, opened, version]);
  const state = useSelected(
    (world, { repository }) => repositoryOf(world, repository, address, browsing),
    [address, browsing],
  );
  // An address says whether it is a directory or a file, and only Keel knows. Where it guessed wrong, it is put right.
  const found = state.status === "ready" ? state.view.kind : undefined;
  useEffect(() => {
    if (route.at !== "code") return;
    const kind = found === "file" ? "blob" : found === "tree" ? "tree" : undefined;
    if (kind !== undefined && kind !== route.kind)
      navigate(where.to({ ...route, kind }), "replace");
  }, [found, route, where]);
  return <Repository state={state} address={address} mode={mode} onToggle={toggle} />;
}
