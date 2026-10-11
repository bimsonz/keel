import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { openCounts } from "./engine/lists.ts";
import { Player } from "./engine/player.ts";
import { ConsoleProvider, usePlayer, useSelected, useWorldVersion } from "./engine/react.tsx";
import { ChangePage } from "./pages/Change.tsx";
import { ChangesPage } from "./pages/Changes.tsx";
import { CodePage } from "./pages/Code.tsx";
import { ConflictPage } from "./pages/Conflict.tsx";
import { ConflictsPage } from "./pages/Conflicts.tsx";
import { EscalationPage } from "./pages/Escalation.tsx";
import { EscalationsPage } from "./pages/Escalations.tsx";
import { HomePage } from "./pages/Home.tsx";
import { InsightsPage } from "./pages/Insights.tsx";
import { Missing } from "./pages/Missing.tsx";
import { MissionControlPage } from "./pages/MissionControl.tsx";
import { type Route, TRUNK, href, parse } from "./route.ts";
import { WhereProvider, carriedParams, onMove, useAddress } from "./router.tsx";
import { KeyRefused, createHttpSource } from "./source/http.ts";
import { type Mode, applyMode } from "./theme/mode.ts";
import { Frame, Notice } from "./views/Frame.tsx";
import { Phone } from "./views/Phone.tsx";
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

const PRESENTER_KEY = "keel.presenter";

/**
 * The presenter's key, if this console was opened with one. It arrives once, in the address's fragment
 * (`#presenter=…`), which is never sent to a server; it is kept for the session and taken out of the address.
 */
function presenterKey(): { presenterKey?: string } {
  const given = new URLSearchParams(window.location.hash.slice(1)).get("presenter");
  if (given !== null && given !== "") {
    window.sessionStorage.setItem(PRESENTER_KEY, given);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  const kept = window.sessionStorage.getItem(PRESENTER_KEY);
  return kept === null ? {} : { presenterKey: kept };
}

/** The project the address names, if it names one. */
const projectAsked = (): string | null => parse(window.location.pathname, "").project;

/** A capability this page was opened with: what a QR code carries to a phone. */
function linkedCapability(params: URLSearchParams): { capability?: string } {
  const given = params.get("rule");
  return given === null || given === "" ? {} : { capability: given };
}

/** A scripted fixture, loaded only when asked for. The import is what keeps it out of the built console. */
async function fixtureSource(scenario: string, params: URLSearchParams, seed: number) {
  const { createMockSource } = await import("../test/fixtures/mock/MockSource.ts");
  const ruling = params.get("ruling");
  const [agents, seconds] = [Number(params.get("agents")), Number(params.get("seconds"))];
  return createMockSource({
    scenario: scenario === "swarm" || scenario === "s2" ? scenario : "s1",
    seed,
    ...(ruling === null ? {} : { ruling }),
    ...(agents > 0 ? { agents } : {}),
    ...(seconds > 0 ? { seconds } : {}),
  });
}

/** True on a screen as narrow as a phone's. */
function useNarrow(): boolean {
  const query = useMemo(() => window.matchMedia("(max-width: 720px)"), []);
  return useSyncExternalStore(
    (notify) => {
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => query.matches,
  );
}

function Page({ route, mode }: { route: Route; mode: Mode }) {
  switch (route.at) {
    case "code":
    case "commits":
    case "commit":
      return <CodePage route={route} mode={mode} />;
    case "changes":
      return <ChangesPage filter={route.filter} shown={route.shown} />;
    case "change":
      return <ChangePage name={route.name} tab={route.tab} mode={mode} />;
    case "conflicts":
      return <ConflictsPage filter={route.filter} shown={route.shown} />;
    case "conflict":
      return <ConflictPage name={route.name} tab={route.tab} mode={mode} />;
    case "escalations":
      return <EscalationsPage filter={route.filter} shown={route.shown} />;
    case "escalation":
      return <EscalationPage name={route.name} />;
    case "mission-control":
      return (
        <MissionControlPage
          mode={mode}
          {...(route.subject === undefined ? {} : { subject: route.subject })}
        />
      );
    case "insights":
      return <InsightsPage tab={route.tab} />;
    default:
      return <Missing />;
  }
}

/** What makes a page a different page: moving between two of them starts the new one at its top. */
function pageOf(route: Route, address: string): string {
  // A list is one page under any filter, and the live graph is one page whichever subject is open beside it.
  // The code is one page among its files, so the list of files beside one keeps what was opened in it.
  if (
    route.at === "changes" ||
    route.at === "conflicts" ||
    route.at === "escalations" ||
    route.at === "mission-control" ||
    route.at === "code" ||
    route.at === "insights"
  )
    return route.at;
  // A thing is one page whichever of its parts is shown, so the tab a reader chose keeps the keyboard's place.
  if (route.at === "change" || route.at === "conflict") return `${route.at}:${route.name}`;
  return address;
}

/** The places read from the project's code, which Keel reads to anyone where the project is public. */
const CODE: ReadonlySet<Route["at"]> = new Set(["code", "commits", "commit"]);

function Console({ mode, seed }: { mode: Mode; seed: number }) {
  const player = usePlayer();
  useWorldVersion();
  const narrow = useNarrow();
  const { project: asked, route } = useAddress();
  const named = player.world.project?.name;
  // Who may read the project: as Keel's own answer about the project has it, or else as its log has it.
  const visibility =
    player.repository.project?.visibility ??
    (asked === null ? undefined : player.projects.named(asked)?.visibility);
  const counts = useSelected(openCounts);
  /** Keel reads its log to an observer, and this reader is a visitor: the console has what Keel reads to anyone. */
  const closed = player.source.descriptor.log === "closed";
  const source = { mode: player.source.descriptor.mode, seed, unread: player.unread, closed };
  // The other projects Keel has named to this reader, for the frame's switcher. A visitor is named none.
  const projects = player.projects.list.map((project) => ({
    name: project.name,
    href: href(project.name, HOME, carriedParams()),
    note: project.visibility,
  }));

  // The page a QR code opens is for answering one question, on whatever screen it is opened. It keeps the address it
  // was given, which holds its capability.
  const linked = new URLSearchParams(window.location.search).has("rule");
  // A narrow screen that can read the log is a phone too. One that cannot is a visitor's, and gets what a visitor gets.
  const answering = asked !== null && (linked || (narrow && !closed));
  // What the project is, and who may read it, is Keel's to say, and is asked once.
  useEffect(() => {
    if (asked !== null) player.repository.wantProject();
  }, [player, asked]);

  // A phone is for one thing: answering the question a QR code brought it to.
  if (answering && closed) {
    return (
      <Notice title="This phone cannot show the question yet">
        Keel reads a question only to an observer today, and what a QR code carries is a way to
        answer one question, not a key to read with. Answer it on the console it was asked on.
      </Notice>
    );
  }
  if (answering) {
    return (
      <Phone
        world={player.world}
        canRule={(escalationId) => player.canRule(escalationId)}
        readOnly={
          player.live
            ? "This console is read-only: it was not opened with the presenter's key."
            : "This fixture's own operator answers this one, a few seconds after it is asked."
        }
        onRule={(escalationId, option) => player.rule(escalationId, option)}
      />
    );
  }

  // The bare address is the instance's own: one Keel is one organisation's, and this lists its projects.
  if (asked === null) {
    return (
      <WhereProvider project="" route={route.at === "missing" ? route : HOME}>
        <Frame source={source}>{route.at === "missing" ? <Missing /> : <HomePage />}</Frame>
      </WhereProvider>
    );
  }
  // An observer's log names every project there is, so a name it does not have is no project's.
  if (!closed && named === undefined) {
    return (
      <WhereProvider project="" route={{ at: "missing" }}>
        <Frame source={source}>
          <Notice title={`There is no project called ${asked} here`}>
            <a href="/" className="a-link">
              See the projects Keel has
            </a>
            .
          </Notice>
        </Frame>
      </WhereProvider>
    );
  }
  return (
    <WhereProvider project={asked} route={route}>
      <NamesProvider>
        <Frame
          source={source}
          counts={counts}
          projects={projects}
          {...(visibility === undefined ? {} : { visibility })}
        >
          {closed && !CODE.has(route.at) && route.at !== "missing" ? (
            <Notice title="This page is not shown to visitors yet">
              It is read from Keel's log, and Keel reads its log only to an observer. The console
              reads it for whoever opens it with the presenter's key.
            </Notice>
          ) : (
            <Page key={pageOf(route, href(asked, route))} route={route} mode={mode} />
          )}
        </Frame>
      </NamesProvider>
    </WhereProvider>
  );
}

export function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const mode: Mode = params.get("theme") === "light" ? "light" : "dark";
  const seed = Number(params.get("seed") ?? "42") || 42;
  const [player, setPlayer] = useState<Player | null>(null);
  const [failure, setFailure] = useState<{ message: string; refused: boolean } | null>(null);

  useEffect(() => {
    applyMode(mode);
  }, [mode]);

  useEffect(() => {
    let live = true;
    const stop = new AbortController();
    const start = async (): Promise<void> => {
      // The console reads Keel. A scripted fixture can stand in for it in development, for tests and for
      // working on a view; it is not in the built console, so this branch is gone from the build.
      const fixture = import.meta.env.DEV ? params.get("scenario") : null;
      const created = new Player(
        fixture === null
          ? await createHttpSource({ ...presenterKey(), ...linkedCapability(params) })
          : await fixtureSource(fixture, params, seed),
      );
      // Keel's log holds every project. What is folded is the project the address names, and it is kept in
      // step with the address before any view reads either.
      created.scopeTo(projectAsked());
      const unhear = onMove(() => created.scopeTo(projectAsked()));
      stop.signal.addEventListener("abort", unhear, { once: true });
      await created.load();
      if (!live) return;
      if (created.live) {
        // Keel's log is followed as it is written. Where in it to stand, and how fast to go, are a fixture's questions.
        created.seek(created.end);
        created.play();
        void created.follow(stop.signal);
      } else {
        created.setRate(Number(params.get("speed")) || (fixture === "swarm" ? 1 : 4));
        created.seek(parseTime(params.get("t")));
        if (params.get("play") !== "0") created.play();
      }
      setPlayer(created);
    };
    start().catch((error: unknown) => {
      // A key the Worker would not have is forgotten, so that the next load reads as a visitor does.
      const refused = error instanceof KeyRefused;
      if (refused) window.sessionStorage.removeItem(PRESENTER_KEY);
      if (live)
        setFailure({
          message: error instanceof Error ? error.message : "Keel's log could not be read",
          refused,
        });
    });
    return () => {
      live = false;
      stop.abort();
    };
  }, [params, seed]);

  if (failure?.refused === true) {
    return (
      <Notice title="That is not the presenter's key">
        This console was opened with a key its Worker does not have. The key has been forgotten:
        load the page again to read as a visitor does.
      </Notice>
    );
  }
  if (failure !== null) {
    return (
      <Notice title="The console could not reach Keel">
        {failure.message}. Check that Keel is up and that this console's Worker can reach it.
        {import.meta.env.DEV
          ? " In development there is no Keel behind this page; the test fixtures are at ?scenario=s1, s2 or swarm."
          : ""}
      </Notice>
    );
  }
  if (player === null) return null;
  return (
    <ConsoleProvider player={player}>
      <Console mode={mode} seed={seed} />
    </ConsoleProvider>
  );
}
