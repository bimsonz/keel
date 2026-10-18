import { useEffect, useMemo, useState } from "react";
import { type Org, createAccount, nameOf } from "./account/account.ts";
import { accountsOf } from "./account/accounts.ts";
import { openCounts } from "./engine/lists.ts";
import { Player } from "./engine/player.ts";
import { maintains } from "./engine/settings.ts";
import { ConsoleProvider, usePlayer, useSelected, useWorldVersion } from "./engine/react.tsx";
import { drawable } from "./engine/seed.ts";
import { ChangePage } from "./pages/Change.tsx";
import { ChangesPage } from "./pages/Changes.tsx";
import { CodePage } from "./pages/Code.tsx";
import { ConflictPage } from "./pages/Conflict.tsx";
import { ConflictsPage } from "./pages/Conflicts.tsx";
import { EscalationPage } from "./pages/Escalation.tsx";
import { EscalationsPage } from "./pages/Escalations.tsx";
import { DecisionPage } from "./pages/Decision.tsx";
import { DecisionsPage } from "./pages/Decisions.tsx";
import { IssuePage } from "./pages/Issue.tsx";
import { IssuesPage } from "./pages/Issues.tsx";
import { NewIssuePage } from "./pages/NewIssue.tsx";
import { type HomeAccount, HomePage } from "./pages/Home.tsx";
import { InsightsFrame, InsightsPage } from "./pages/Insights.tsx";
import { Missing } from "./pages/Missing.tsx";
import { MissionControlPage } from "./pages/MissionControl.tsx";
import { PipelinePage } from "./pages/Pipeline.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { type Route, TRUNK, href } from "./route.ts";
import { WhereProvider, carriedParams, useAddress } from "./router.tsx";
import { createHttpDirectory, createHttpSource, createHttpSponsorship } from "./source/http.ts";
import { createHttpSponsorRequests } from "./source/sponsorRequests.ts";
import type { ProjectView } from "./contract/keel/index.ts";
import type { KeelDirectory } from "./source/types.ts";
import { type Mode, applyMode } from "./theme/mode.ts";
import { Frame, Notice, type ReaderMark } from "./views/Frame.tsx";
import { warm } from "./views/later.tsx";
import { NamesProvider } from "./views/links.tsx";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "./views/tokens.css";

const HOME: Route = { at: "code", kind: "tree", ref: TRUNK, path: "" };

/** `7:26`, or plain seconds, as milliseconds of simulated time. */
function parseTime(value: string | null): number {
  if (value === null || value === "") return 0;
  const [minutes, seconds] = value.includes(":") ? value.split(":") : ["0", value];
  return (Number(minutes) * 60 + Number(seconds)) * 1000 || 0;
}

/** Keel as this page reads it: Keel itself, or in development a scripted fixture standing in for it. */
interface Reading {
  mode: "live" | "fixture";
  /** The projects Keel names to this reader. */
  directory: KeelDirectory;
  /** A playhead on one of those projects, its log not read yet. */
  open(project: ProjectView): Player;
}

/** A scripted fixture, loaded only when asked for. The import is what keeps it out of the built console. */
async function fixtureReading(
  scenario: string,
  params: URLSearchParams,
  seed: number,
): Promise<Reading> {
  const { createMockSource, fixtureDirectory, isScenario } =
    await import("../test/fixtures/mock/MockSource.ts");
  const ruling = params.get("ruling");
  const [agents, seconds] = [Number(params.get("agents")), Number(params.get("seconds"))];
  const source = createMockSource({
    scenario: isScenario(scenario) ? scenario : "s1",
    seed,
    ...(ruling === null ? {} : { ruling }),
    ...(agents > 0 ? { agents } : {}),
    ...(seconds > 0 ? { seconds } : {}),
  });
  return {
    mode: "fixture",
    directory: await fixtureDirectory(source),
    // A fixture's one log holds every project it has, so its playhead is told which to fold.
    open(project) {
      const player = new Player(source);
      player.scopeTo(project.name);
      return player;
    },
  };
}

/**
 * The console reads Keel. A scripted fixture can stand in for it in development, for tests and for working on
 * a view; it is not in the built console, so that branch is gone from the build.
 */
async function readingOf(params: URLSearchParams, seed: number): Promise<Reading> {
  const fixture = import.meta.env.DEV ? params.get("scenario") : null;
  if (fixture !== null) return fixtureReading(fixture, params, seed);
  return {
    mode: "live",
    directory: createHttpDirectory(),
    open: (project) => new Player(createHttpSource(project)),
  };
}

/** Who is reading, and their orgs. */
interface Reader {
  mark: ReaderMark;
  orgs: readonly Org[];
  /** The reader's own handle, once they have chosen one: their name here, and where their projects live. */
  handle?: string;
}

/**
 * Who is reading, for the frame's way in and its way to the reader's own account and their orgs. Keel says, by the session the
 * browser holds. Undefined until it has, on a Keel that serves no accounts, and on a test fixture.
 */
function useReader(live: boolean): Reader | undefined {
  const [reader, setReader] = useState<Reader>();
  useEffect(() => {
    if (!live) return undefined;
    let here = true;
    const account = createAccount({ origin: window.location.origin });
    const read = async (): Promise<void> => {
      const who = await account.who();
      if (!here) return;
      if (who === null) {
        setReader({ mark: {}, orgs: [] });
        return;
      }
      setReader({ mark: { name: nameOf(who) }, orgs: [] });
      // Keel lists a user's orgs once they have a handle; one who has none yet has no org.
      if (who.handle === undefined) return;
      const orgs = await account.orgs();
      if (!here) return;
      setReader({
        mark: {
          name: nameOf(who),
          handle: who.handle,
          orgs: accountsOf(orgs, who),
        },
        orgs,
        handle: who.handle,
      });
    };
    // A Keel that serves no accounts has nobody to name: the frame then offers no way in.
    read().catch(() => undefined);
    return () => {
      here = false;
    };
  }, [live]);
  return reader;
}

function Page({
  route,
  mode,
  project,
  reader,
}: {
  route: Route;
  mode: Mode;
  project: ProjectView;
  reader: ReaderMark | undefined;
}) {
  switch (route.at) {
    case "code":
    case "commits":
    case "commit":
      return <CodePage route={route} mode={mode} />;
    case "issues":
      return <IssuesPage state={route.state} reader={reader} />;
    case "issue":
      return <IssuePage number={route.number} reader={reader} />;
    case "new-issue":
      return <NewIssuePage reader={reader} />;
    case "changes":
      return <ChangesPage filter={route.filter} shown={route.shown} />;
    case "change":
      return <ChangePage name={route.name} tab={route.tab} mode={mode} />;
    case "conflicts":
      return (
        <InsightsFrame at="conflicts">
          <ConflictsPage filter={route.filter} shown={route.shown} />
        </InsightsFrame>
      );
    case "conflict":
      return <ConflictPage name={route.name} tab={route.tab} mode={mode} />;
    case "escalations":
      return (
        <InsightsFrame at="questions">
          <EscalationsPage filter={route.filter} shown={route.shown} />
        </InsightsFrame>
      );
    case "escalation":
      return <EscalationPage name={route.name} />;
    case "decisions":
      return (
        <InsightsFrame at="decisions">
          <DecisionsPage {...(route.subject === undefined ? {} : { subject: route.subject })} />
        </InsightsFrame>
      );
    case "decision":
      return <DecisionPage name={route.name} />;
    case "mission-control":
      return (
        <MissionControlPage
          name={`${project.namespace.handle}/${project.name}`}
          mode={mode}
          {...(route.subject === undefined ? {} : { subject: route.subject })}
        />
      );
    case "pipeline":
      return <PipelinePage mode={mode} />;
    case "insights":
      return <InsightsPage tab={route.tab} />;
    case "settings":
      return <SettingsPage project={project} section={route.section} />;
    default:
      return <Missing />;
  }
}

/** What makes a page a different page: moving between two of them starts the new one at its top. */
function pageOf(route: Route, address: string): string {
  // A list is one page under any filter, and the live graph is one page whichever subject is open beside it.
  // The code is one page among its files, so the list of files beside one keeps what was opened in it.
  if (
    route.at === "issues" ||
    route.at === "changes" ||
    route.at === "conflicts" ||
    route.at === "escalations" ||
    route.at === "decisions" ||
    route.at === "mission-control" ||
    route.at === "pipeline" ||
    route.at === "code" ||
    route.at === "insights"
  )
    return route.at;
  // A thing is one page whichever of its parts is shown, so the tab a reader chose keeps the keyboard's place.
  if (route.at === "change" || route.at === "conflict") return `${route.at}:${route.name}`;
  return address;
}

/** The places that need nothing of the project's log: its code, its issues and its settings, which Keel is asked for. */
const UNLOGGED: ReadonlySet<Route["at"]> = new Set([
  "code",
  "commits",
  "commit",
  "settings",
  "issues",
  "issue",
  "new-issue",
]);

/** A project's pages, in its frame. */
function Console({
  found,
  siblings,
  reader,
  route,
  mode,
  seed,
}: {
  found: ProjectView;
  /** The other projects of the namespace that Keel names to this reader. */
  siblings: readonly ProjectView[];
  reader: ReaderMark | undefined;
  route: Route;
  mode: Mode;
  seed: number;
}) {
  const player = usePlayer();
  useWorldVersion();
  // Who may read the project: as its log says it now is, or else as Keel said when the project was found.
  const visibility = player.projects.named(found.name)?.visibility ?? found.visibility;
  const counts = useSelected(openCounts);
  const source = { mode: player.source.descriptor.mode, seed, unread: player.unread };
  const projects = siblings.map((project) => ({
    name: project.name,
    href: href(project.namespace.handle, project.name, HOME, carriedParams()),
    note: project.visibility,
  }));
  // A page read from the log has nothing to draw until the log has been read, or a snapshot of it that the page
  // draws from (seed.ts), unless it is drawn as the log is read. The code waits for none of it.
  const waiting = !drawable(player, route.at) && !UNLOGGED.has(route.at) && route.at !== "missing";
  return (
    <WhereProvider
      namespace={found.namespace.handle}
      kind={found.namespace.kind}
      project={found.name}
      route={route}
    >
      <NamesProvider>
        <Frame
          source={source}
          projects={projects}
          visibility={visibility}
          {...(found.forkedFrom === undefined ? {} : { forkedFrom: found.forkedFrom })}
          // Keel holds a project's settings, so a test fixture, which is not Keel, has none to offer.
          settings={maintains(found) && player.source.getSettings !== undefined}
          {...(reader === undefined ? {} : { reader })}
          {...(player.loaded ? { counts } : {})}
        >
          {waiting ? null : (
            <Page
              key={pageOf(route, href(found.namespace.handle, found.name, route))}
              route={route}
              mode={mode}
              project={found}
              reader={reader}
            />
          )}
        </Frame>
      </NamesProvider>
    </WhereProvider>
  );
}

type Opened =
  | { is: "reading" }
  | { is: "missing" }
  | { is: "failed"; said: string }
  | { is: "open"; found: ProjectView; player: Player };

/** One project, found by its namespace's handle and its name, and read from there. */
function Project({
  reading,
  reader,
  namespace,
  name,
  route,
  mode,
  seed,
  params,
}: {
  reading: Reading;
  reader: ReaderMark | undefined;
  namespace: string;
  name: string;
  route: Route;
  mode: Mode;
  seed: number;
  params: URLSearchParams;
}) {
  const [opened, setOpened] = useState<Opened>({ is: "reading" });
  const [siblings, setSiblings] = useState<readonly ProjectView[]>([]);
  // What this place draws is asked for at once, beside Keel's own answers and not after them.
  useEffect(() => warm(route), [route]);

  useEffect(() => {
    let here = true;
    const stop = new AbortController();
    const start = async (): Promise<void> => {
      const found = await reading.directory.findProject(namespace, name, stop.signal);
      if (!here) return;
      if (found === null) {
        setOpened({ is: "missing" });
        return;
      }
      const player = reading.open(found);
      if (player.live) {
        // Keel's log is followed as it is written, and the code needs none of it: the pages stand at once, and
        // the log is read behind them.
        setOpened({ is: "open", found, player });
        await player.load();
        if (!here) return;
        player.seek(player.end);
        player.play();
        void player.follow(stop.signal);
        return;
      }
      // Where in a fixture's log to stand, and how fast to go, are the address's to say, before anything is drawn.
      await player.load();
      if (!here) return;
      player.setRate(Number(params.get("speed")) || (params.get("scenario") === "swarm" ? 1 : 4));
      player.seek(parseTime(params.get("t")));
      if (params.get("play") !== "0") player.play();
      setOpened({ is: "open", found, player });
    };
    start().catch((error: unknown) => {
      if (here)
        setOpened({
          is: "failed",
          said: error instanceof Error ? error.message : "Keel could not be read",
        });
    });
    // The namespace's other projects, for the frame's switcher. The page does not wait for them.
    const others = async (): Promise<void> => {
      const listed = await reading.directory.listProjects(stop.signal).catch(() => []);
      if (here) setSiblings(listed.filter((project) => project.namespace.handle === namespace));
    };
    void others();
    return () => {
      here = false;
      stop.abort();
    };
  }, [reading, namespace, name, params]);

  // A project's frame is up while Keel finds it, as a code host draws a repository's structure before its contents:
  // what it is called and its tabs are the address's. What Keel says of it fills in once it is found.
  if (opened.is === "reading")
    return (
      <WhereProvider namespace={namespace} project={name} route={route}>
        <Frame source={{ mode: reading.mode, seed }} {...(reader === undefined ? {} : { reader })}>
          {null}
        </Frame>
      </WhereProvider>
    );
  if (opened.is === "failed") return <Unreachable said={opened.said} />;
  if (opened.is === "missing") {
    // A project Keel does not show this reader and one that is not there are the same answer, and the same page.
    return (
      <WhereProvider namespace="" project="" route={{ at: "missing" }}>
        <Frame source={{ mode: reading.mode, seed }} {...(reader === undefined ? {} : { reader })}>
          <Notice title={`Project ${namespace}/${name} not found`}>
            <a href="/" className="a-link">
              See the projects Keel has
            </a>
          </Notice>
        </Frame>
      </WhereProvider>
    );
  }
  return (
    <ConsoleProvider player={opened.player}>
      <Console
        found={opened.found}
        siblings={siblings}
        reader={reader}
        route={route}
        mode={mode}
        seed={seed}
      />
    </ConsoleProvider>
  );
}

/** What the home asks of a live Keel beyond its projects: agents' cards, the reader's sponsor requests, a passkey. */
function liveHome(): HomeAccount {
  const account = createAccount({ origin: window.location.origin });
  return {
    agents: createHttpSponsorship(),
    requests: createHttpSponsorRequests(),
    signIn: () => account.signInWithPasskey(),
  };
}

function Unreachable({ said }: { said: string }) {
  return (
    <Notice title="The console could not reach Keel">
      {said}. Check that Keel is up.
      {import.meta.env.DEV
        ? " In development there is no Keel behind this page; the test fixtures are at ?scenario=s1, s2, s3, s4, s5, s6 or swarm."
        : ""}
    </Notice>
  );
}

export function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const mode: Mode = params.get("theme") === "light" ? "light" : "dark";
  const seed = Number(params.get("seed") ?? "42") || 42;
  const [reading, setReading] = useState<Reading | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { namespace, project, route } = useAddress();
  const reader = useReader(reading?.mode === "live");
  const home = useMemo(() => (reading?.mode === "live" ? liveHome() : undefined), [reading?.mode]);

  useEffect(() => {
    applyMode(mode);
  }, [mode]);

  useEffect(() => {
    let here = true;
    const begin = async (): Promise<void> => {
      try {
        const made = await readingOf(params, seed);
        if (here) setReading(made);
      } catch (error) {
        if (here) setFailure(error instanceof Error ? error.message : "Keel could not be read");
      }
    };
    void begin();
    return () => {
      here = false;
    };
  }, [params, seed]);

  if (failure !== null) return <Unreachable said={failure} />;
  if (reading === null) return null;
  if (namespace !== null && project !== null) {
    // Another project is another log and another playhead: nothing of the last one is carried over.
    return (
      <Project
        key={`${namespace}/${project}`}
        reading={reading}
        reader={reader?.mark}
        namespace={namespace}
        name={project}
        route={route}
        mode={mode}
        seed={seed}
        params={params}
      />
    );
  }
  // The bare address is the home: the projects Keel names to this reader, by namespace.
  return (
    <WhereProvider namespace="" project="" route={route.at === "missing" ? route : HOME}>
      <Frame
        source={{ mode: reading.mode, seed }}
        {...(reader === undefined ? {} : { reader: reader.mark })}
      >
        {route.at === "missing" || namespace !== null ? (
          <Missing />
        ) : (
          <HomePage
            directory={reading.directory}
            {...(home === undefined ? {} : { account: home })}
            orgs={reader?.orgs ?? []}
            {...(reader?.handle === undefined ? {} : { handle: reader.handle })}
          />
        )}
      </Frame>
    </WhereProvider>
  );
}
