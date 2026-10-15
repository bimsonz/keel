// The project's code: its files at a commit, trunk's history, and one commit.

import { buttonVariants } from "@cloudflare/kumo";
import { GavelIcon, HandPalmIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type WhyDecision, readWhy } from "../source/why.ts";
import { DecisionLink } from "../views/links.tsx";
import { dateTime } from "../views/parts.tsx";
import { PAGE, changesOf, waitsOnARuling } from "../engine/lists.ts";
import { useHolderCards, usePlayer, useSelected, useWorldVersion } from "../engine/react.tsx";
import { hrefOf } from "../places.ts";
import { type Browsing, type RepoAddress, repositoryOf } from "../engine/repository.ts";
import { type Route, TRUNK } from "../route.ts";
import { Link, navigate, useWhere } from "../router.tsx";
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

/**
 * Over a project's home, what waits on a person: the changes parked on a ruling, and the way to them, as a code
 * host heads a repository with the pull requests that ask for a review.
 */
function WaitingOnARuling() {
  const player = usePlayer();
  const parked = useSelected((world) => {
    let count = 0;
    for (const change of world.changes.values()) if (waitsOnARuling(change)) count += 1;
    return count;
  });
  // The questions open to this reader, where Keel shows them: one opens its own page, several their list.
  const open = useSelected((world) =>
    [...world.escalations.values()]
      .filter((entry) => entry.state === "open")
      .map((entry) => ({ id: entry.id, label: entry.label })),
  );
  const mine = open.filter((entry) => player.canRule(entry.id));
  if (parked === 0 && open.length === 0) return null;
  const only = open.length === 1 ? open[0] : undefined;
  return (
    <section className="a-banner" aria-label="Waiting on a ruling">
      <HandPalmIcon size={18} weight="fill" style={{ color: "var(--a-person)" }} aria-hidden />
      <p className="min-w-0 flex-1 text-base text-kumo-strong">
        <b className="font-semibold">
          {mine.length > 0 ? "Your ruling needed" : "Waiting on a ruling"}
        </b>
        <span className="text-kumo-subtle">
          {" · "}
          {Math.max(parked, open.length).toLocaleString("en-US")}{" "}
          {Math.max(parked, open.length) === 1 ? "change" : "changes"}
        </span>
      </p>
      <Link
        to={
          only === undefined
            ? { at: "changes", filter: "parked", shown: PAGE }
            : { at: "escalation", name: only.label }
        }
        className={buttonVariants({ variant: "primary", size: "sm" })}
      >
        {mine.length > 0 ? "Rule" : "Review"}
      </Link>
    </section>
  );
}

/**
 * Over a file, the decisions Keel says explain it, as a code host heads a file with its last commit: each by its
 * label and Keel's line for it. Nothing where Keel names none.
 */
function WhyBar({ path }: { path: string }) {
  const player = usePlayer();
  const { project } = useWhere();
  const projectId = player.projects.named(project)?.id;
  const [decisions, setDecisions] = useState<readonly WhyDecision[]>([]);
  useEffect(() => {
    if (projectId === undefined || player.source.descriptor.mode !== "live") return undefined;
    const stop = new AbortController();
    readWhy(projectId, path, stop.signal)
      .then(setDecisions)
      .catch(() => setDecisions([]));
    return () => stop.abort();
  }, [player, projectId, path]);
  if (decisions.length === 0) return null;
  return (
    <section className="a-panel flex flex-col" aria-label="Decisions on this file">
      <header className="a-panel-head">
        <GavelIcon size={16} aria-hidden />
        <h2 className="text-sm font-semibold text-kumo-strong">Decisions</h2>
        <span className="text-sm text-kumo-subtle">{decisions.length}</span>
      </header>
      <ul className="flex flex-col divide-y divide-kumo-hairline">
        {decisions.map((decision) => (
          <li key={decision.id} className="flex items-baseline gap-3 px-4 py-2.5 text-sm">
            <DecisionLink id={decision.id} className="a-link min-w-0 flex-1">
              {decision.summary}
            </DecisionLink>
            <time className="a-num shrink-0 text-kumo-subtle">{dateTime(decision.at)}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One line of the About column: a count and what it counts, a link to where they are listed. */
function Counted({ count, label, to }: { count: number; label: string; to: Route }) {
  return (
    <Link
      to={to}
      className="flex min-h-6 items-center gap-2 text-sm text-kumo-default hover:text-kumo-link"
    >
      <b className="a-num font-semibold text-kumo-strong">{count.toLocaleString("en-US")}</b>
      {label}
    </Link>
  );
}

/**
 * Beside a project's files, what a code host's repository home has in its About column: here, its changes by
 * where they stand, trunk's head and how often it went red, and the agents that open its changes.
 */
function About() {
  const counts = useSelected((world) => {
    const tally = { open: 0, running: 0, parked: 0, bounced: 0, landed: 0 };
    for (const change of world.changes.values()) {
      if (change.state === "landed") tally.landed += 1;
      else if (change.state !== "withdrawn" && change.state !== "superseded") tally.open += 1;
      if (change.state === "verifying" || change.state === "integrating") tally.running += 1;
      if (waitsOnARuling(change)) tally.parked += 1;
      if (change.state === "bounced") tally.bounced += 1;
    }
    return tally;
  });
  const trunk = useSelected((world) => ({
    head: world.trunk.head,
    red: world.trunk.redCount,
  }));
  // The agents of the latest changes, each once, by the name Keel's card gives it.
  const rows = useSelected((world, from) => [
    ...changesOf(world, "open", PAGE, from.cards).rows,
    ...changesOf(world, "closed", PAGE, from.cards).rows,
  ]);
  useHolderCards(rows.map((row) => row.id));
  const agents = [
    ...new Map(
      rows
        .filter((row) => row.held.handle !== undefined)
        .map((row) => [row.held.handle ?? "", row.agent]),
    ),
  ].slice(0, 8);
  return (
    <aside className="flex flex-col gap-5" aria-label="About">
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-kumo-strong">Changes</h2>
        <Counted
          count={counts.open}
          label="open"
          to={{ at: "changes", filter: "open", shown: PAGE }}
        />
        {counts.running > 0 && (
          <Counted
            count={counts.running}
            label="checks running"
            to={{ at: "changes", filter: "open", shown: PAGE }}
          />
        )}
        {counts.parked > 0 && (
          <Counted
            count={counts.parked}
            label="waiting on a ruling"
            to={{ at: "changes", filter: "parked", shown: PAGE }}
          />
        )}
        {counts.bounced > 0 && (
          <Counted
            count={counts.bounced}
            label="bounced"
            to={{ at: "changes", filter: "bounced", shown: PAGE }}
          />
        )}
        <Counted
          count={counts.landed}
          label="landed"
          to={{ at: "changes", filter: "landed", shown: PAGE }}
        />
      </section>
      <section className="flex flex-col gap-2 border-t border-kumo-line pt-4">
        <h2 className="text-base font-semibold text-kumo-strong">Trunk</h2>
        {trunk.head !== "" && (
          <Link
            to={{ at: "commit", sha: trunk.head }}
            className="text-sm text-kumo-default hover:text-kumo-link"
          >
            Head <span className="a-mono text-kumo-strong">{trunk.head.slice(0, 7)}</span>
          </Link>
        )}
        <span className="text-sm text-kumo-default">
          Red <b className="a-num font-semibold text-kumo-strong">{trunk.red}</b>
        </span>
        <Link to={{ at: "insights", tab: "trunk" }} className="a-link text-sm">
          Insights
        </Link>
      </section>
      {agents.length > 0 && (
        <section className="flex flex-col gap-2 border-t border-kumo-line pt-4">
          <h2 className="text-base font-semibold text-kumo-strong">Agents</h2>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {agents.map(([handle, name]) => (
              <li key={handle}>
                <a href={hrefOf({ at: "namespace", handle })} className="a-link text-sm">
                  {name}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
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
  return (
    <Repository
      state={state}
      address={address}
      mode={mode}
      onToggle={toggle}
      {...(route.at === "code" && route.path === ""
        ? { banner: <WaitingOnARuling />, aside: <About /> }
        : route.at === "code" && found === "file"
          ? { banner: <WhyBar path={route.path} /> }
          : {})}
    />
  );
}
