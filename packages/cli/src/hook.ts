import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createKeelClient, type KeelClient, KeelProblem } from "@keeltown/sdk";
import { entryName, heldKey } from "./agent-key.ts";
import type { Io } from "./run.ts";

/**
 * Claude Code's hooks, as Keel's memory reaching an agent at the moment it
 * matters: `post-tool-use` runs after the agent reads or edits a file and adds
 * the note of each decision anchored in it; `session-start` primes a session
 * with who the agent is in Keel and what its project holds. A hook never holds
 * the agent up for long and never stands in a tool's way: whatever happens it
 * exits 0, and when it has nothing to say, or Keel is slow or unreachable, it
 * says nothing (what went wrong goes to stderr, which Claude Code keeps in its
 * debug log).
 */
export type HookEvent = "post-tool-use" | "session-start";

/** How long each hook waits for Keel before it gives up and says nothing. */
const DEADLINE_MS: Readonly<Record<HookEvent, number>> = {
  "post-tool-use": 3_000,
  "session-start": 5_000,
};

/** Claude Code's name for each event, which a hook's output must repeat. */
const EVENT_NAME: Readonly<Record<HookEvent, string>> = {
  "post-tool-use": "PostToolUse",
  "session-start": "SessionStart",
};

/** Claude Code cuts a hook's context at 10,000 characters; a note stays under it with room to spare. */
export const NOTE_BUDGET = 9_000;

/** Where Keel's document names its token endpoint. */
const DISCOVERY = "/.well-known/oauth-authorization-server";

/** The run a hook's token names when it was installed without one. */
export const DEFAULT_RUN = "claude-code";

/** The states a change has left for good; any other is open. */
const CLOSED = new Set(["landed", "withdrawn", "superseded"]);

/** How many open changes the primer names; it counts them all. */
const CHANGES_NAMED = 5;

type WhyAnswer = Awaited<ReturnType<KeelClient["why"]>>;
type Link = WhyAnswer["result"]["chain"][number];
type NextAction = WhyAnswer["next"][number];

/** A project as a Keel remote names it, and as Keel knows it. */
interface Place {
  /** The repository's root, as git names it. */
  readonly toplevel: string;
  readonly handle: string;
  readonly name: string;
}

interface Project {
  readonly id: string;
  readonly visibility: string;
}

/** What a session's hooks remember between runs: which decisions it was told of, and its projects' ids. Nothing secret. */
interface SessionState {
  readonly told: readonly string[];
  readonly projects: Readonly<Record<string, Project>>;
}

const text = (value: unknown, name: string): string | undefined => {
  const member: unknown = Reflect.get(Object(value), name);
  return typeof member === "string" && member !== "" ? member : undefined;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A sleep that never keeps the process alive on its own. */
const unrefSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** Runs one hook. Always 0: a hook that fails says why on stderr and nothing on stdout. */
export async function hookCommand(
  io: Io,
  event: string | undefined,
  options: { readonly profile?: string | undefined; readonly run?: string | undefined },
): Promise<0> {
  if (event !== "post-tool-use" && event !== "session-start") {
    io.stderr(`keeltown hook: unknown event ${event ?? "(none)"}`);
    return 0;
  }
  const baseUrl = io.env["KEEL_URL"];
  if (baseUrl === undefined) return 0;
  // The machine's own fetch unless a test brings one, as the SDK's client has it.
  const base: NonNullable<Io["fetch"]> = io.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const asking = new AbortController();
  // Every request the hook makes, the token's among them, stops when the deadline comes.
  const send: NonNullable<Io["fetch"]> = (url, init) =>
    base(url, {
      ...init,
      signal:
        init.signal === undefined || init.signal === null
          ? asking.signal
          : AbortSignal.any([init.signal, asking.signal]),
    });
  // Each client reads Keel's document for where tokens are asked for; one read serves them all.
  const documents = new Map<string, Promise<Response>>();
  const fetch: NonNullable<Io["fetch"]> = (url, init) => {
    if ((init.method ?? "GET") !== "GET" || !url.endsWith(DISCOVERY)) return send(url, init);
    const read = documents.get(url) ?? send(url, init);
    documents.set(url, read);
    return read.then((response) => response.clone());
  };
  const context = {
    io,
    baseUrl,
    fetch,
    signal: asking.signal,
    profile: options.profile ?? io.env["KEEL_PROFILE"],
    run: options.run ?? io.env["KEEL_RUN"] ?? DEFAULT_RUN,
  };
  const work = (async () => {
    const input: unknown = JSON.parse(await (io.stdin?.() ?? Promise.resolve("")));
    return event === "post-tool-use" ? noteFor(context, input) : primerFor(context, input);
  })().catch((error: unknown) => {
    io.stderr(`keeltown hook ${event}: ${messageOf(error)}`);
    return undefined;
  });
  const sleep = io.sleep ?? unrefSleep;
  const said = await Promise.race([
    work,
    sleep(DEADLINE_MS[event]).then(() => {
      io.stderr(`keeltown hook ${event}: Keel did not answer in ${DEADLINE_MS[event]} ms`);
      return undefined;
    }),
  ]);
  asking.abort();
  if (said !== undefined)
    io.stdout(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: EVENT_NAME[event], additionalContext: said },
      }),
    );
  return 0;
}

interface HookContext {
  readonly io: Io;
  readonly baseUrl: string;
  readonly fetch: NonNullable<Io["fetch"]>;
  readonly signal: AbortSignal;
  readonly profile: string | undefined;
  readonly run: string;
}

/** The note for the file a tool just read or wrote: undefined when nothing explains it, or the session was told already. */
async function noteFor(context: HookContext, input: unknown): Promise<string | undefined> {
  const tool = Reflect.get(Object(input), "tool_input");
  const file = text(tool, "file_path") ?? text(tool, "notebook_path");
  const session = text(input, "session_id");
  if (file === undefined || !isAbsolute(file)) return undefined;
  // The key is read from the machine's store while git finds the repository.
  const holding = agentOf(context);
  const place = await placeOf(context, dirname(file));
  if (place === undefined) return undefined;
  const path = repositoryPath(place.toplevel, file);
  if (path === undefined) return undefined;
  const agent = await holding;
  if (agent === undefined) return undefined;
  const { project, state } = await projectOf(context, agent, place, readState(context.io, session));
  let answer: WhyAnswer;
  try {
    answer = await agent.client(project.id).why({ path }, { signal: context.signal });
  } catch (error) {
    if (error instanceof KeelProblem && error.code === "why.nothing_to_explain") return undefined;
    throw error;
  }
  const fresh = decisionsOf(answer).filter((decision) => !state.told.includes(decision.id));
  if (fresh.length === 0) {
    writeState(context.io, session, state);
    return undefined;
  }
  const note = renderDecisions(
    `Keel: ${fresh.length} active ${fresh.length === 1 ? "decision explains" : "decisions explain"} ${path} in ${place.handle}/${place.name}. Each comes with Keel's chain for it, the next action to read it, and the chain as MFP records, one a line.`,
    fresh,
    { budget: NOTE_BUDGET, rest: `\`keeltown why --path ${path}\` prints them all` },
  );
  writeState(context.io, session, { ...state, told: [...state.told, ...note.shown] });
  return note.text;
}

/** The primer for a session in a clone of a Keel project: undefined anywhere else. */
async function primerFor(context: HookContext, input: unknown): Promise<string | undefined> {
  const session = text(input, "session_id");
  const cwd = text(input, "cwd");
  // Compacted, the session has lost the notes it was given: it may be told them again.
  const kept = readState(context.io, session);
  const started = text(input, "source") === "compact" ? { ...kept, told: [] } : kept;
  writeState(context.io, session, started);
  if (cwd === undefined) return undefined;
  const holding = agentOf(context);
  const place = await placeOf(context, cwd);
  if (place === undefined) return undefined;
  const agent = await holding;
  if (agent === undefined) return undefined;
  const { project, state } = await projectOf(context, agent, place, started);
  writeState(context.io, session, state);
  const client = agent.client(project.id);
  const signal = context.signal;
  // One token for the four reads, not one each.
  await client.token();
  const [me, changes, inbox, decisions] = await Promise.allSettled([
    client.whoami({ signal }),
    client.changes({ project: project.id, limit: 100, signal }),
    client.inbox({ signal }),
    client.decisions({ project: project.id, limit: 100, signal }),
  ]);
  const lines = [
    `Keel: this clone is ${place.handle}/${place.name} (${project.id}, ${project.visibility}).`,
  ];
  if (me.status === "fulfilled") lines.push(me.value.summary);
  if (changes.status === "fulfilled") {
    const open = changes.value.items.filter((change) => !CLOSED.has(change.state));
    lines.push(
      `${open.length} open ${open.length === 1 ? "change" : "changes"}${open.length === 0 ? "." : ":"}`,
      ...open.slice(0, CHANGES_NAMED).map((c) => `- #${c.number} ${c.state}: ${c.goal}`),
    );
  }
  if (inbox.status === "fulfilled") {
    const waiting = inbox.value.result.notices.length;
    lines.push(
      `${waiting} ${waiting === 1 ? "notice" : "notices"} waiting${waiting === 0 ? "." : ": `keeltown inbox` reads them."}`,
    );
  }
  if (decisions.status === "fulfilled") {
    const active = decisions.value.items.filter((decision) => decision.state === "active");
    lines.push(
      `${active.length} active ${active.length === 1 ? "decision" : "decisions"}${active.length === 0 ? "." : " (`keeltown why --subject <subject>` prints one's chain):"}`,
      ...active.map((decision) => {
        const anchored = [
          ...new Set(decision.holds.flatMap((held) => (held.anchors ?? []).map((a) => a.path))),
        ];
        return `- ${decision.label} on ${decision.subject ?? "(no subject)"}: ${decision.summary}${anchored.length === 0 ? "" : ` (anchored in ${anchored.join(", ")})`}`;
      }),
      "When you read or edit a file a decision is anchored in, Keel's note on it arrives with the tool's result.",
    );
  }
  return lines.join("\n");
}

/** One active decision's links, from its decision record to the next decision's. */
interface Explained {
  readonly id: string;
  /** The label Keel gives it (`D-1`), as its summary leads with it; its id when the summary has none. */
  readonly label: string;
  readonly links: readonly Link[];
  readonly next: readonly NextAction[];
}

/** A chain's decisions: `why` answers each decision's links in turn, the decision's record first. */
export function decisionsOf(answer: WhyAnswer): Explained[] {
  const decisions: { id: string; label: string; links: Link[] }[] = [];
  for (const link of answer.result.chain) {
    if (link.record.kind === "decision")
      decisions.push({
        id: link.record.id,
        label: /^[A-Z]+-\d+\b/u.exec(link.summary)?.[0] ?? link.record.id,
        links: [],
      });
    decisions.at(-1)?.links.push(link);
  }
  return decisions.map((decision) => ({
    ...decision,
    next: answer.next.filter((action) => text(action.args, "decisionId") === decision.id),
  }));
}

const actionLine = (action: NextAction) =>
  `next: ${action.title}${action.operationId === undefined ? "" : ` [${action.operationId}${action.args === undefined ? "" : ` ${JSON.stringify(action.args)}`}]`}`;

/** One decision as a note tells it: its links' summaries, its next actions, then its records. */
function blockOf(decision: Explained, records: boolean): string {
  const [first, ...rest] = decision.links;
  return [
    first?.summary ?? decision.label,
    ...rest.map((link) => `- ${link.summary}`),
    ...decision.next.map(actionLine),
    ...(records
      ? ["MFP records:", ...decision.links.map((link) => JSON.stringify(link.record))]
      : []),
  ].join("\n");
}

/**
 * Decisions as a note tells them, under `heading`. With a budget, whole
 * decisions past it are left out and named, with `rest` saying how to read
 * them; a first decision too large on its own is told without its records.
 */
export function renderDecisions(
  heading: string,
  decisions: readonly Explained[],
  options: { readonly budget?: number; readonly rest?: string } = {},
): { readonly text: string; readonly shown: readonly string[] } {
  const budget = options.budget ?? Number.POSITIVE_INFINITY;
  const blocks: string[] = [];
  const shown: string[] = [];
  let length = heading.length;
  // Room kept for the line naming what was left out.
  const reserve = 200 + decisions.length * 12;
  for (const decision of decisions) {
    const whole = blockOf(decision, true);
    const block =
      blocks.length === 0 && length + whole.length + reserve > budget
        ? blockOf(decision, false)
        : whole;
    if (length + 2 + block.length + reserve > budget && blocks.length > 0) break;
    blocks.push(block);
    shown.push(decision.id);
    length += 2 + block.length;
  }
  const left = decisions.filter((decision) => !shown.includes(decision.id));
  const omitted =
    left.length === 0
      ? []
      : [
          `Not shown here: ${left.map((d) => d.label).join(", ")}${options.rest === undefined ? "" : ` (${options.rest})`}.`,
        ];
  return { text: [heading, ...blocks, ...omitted].join("\n\n"), shown };
}

/** The path of `file` in the repository at `toplevel`, as Keel's anchors name it; undefined outside it. */
function repositoryPath(toplevel: string, file: string): string | undefined {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return undefined;
  }
  const path = relative(toplevel, real);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) return undefined;
  return path.split(sep).join("/");
}

/** Runs git in `dir`: its output, or undefined when git fails or is not on this machine. */
async function git(io: Io, dir: string, args: readonly string[]): Promise<string | undefined> {
  const done = await io.exec?.("git", ["-C", dir, ...args]);
  return done === undefined || done.code !== 0 ? undefined : done.stdout.trim();
}

/**
 * The Keel project the repository holding `dir` is a clone of: the one its
 * remotes on this Keel name, `origin`'s first. Undefined outside a repository,
 * with no remote on this Keel, or when its remotes name more than one project
 * and none is `origin`.
 */
async function placeOf(context: HookContext, dir: string): Promise<Place | undefined> {
  const toplevel = await git(context.io, dir, ["rev-parse", "--show-toplevel"]);
  if (toplevel === undefined) return undefined;
  const listed = await git(context.io, toplevel, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  const keel = URL.parse(context.baseUrl)?.origin;
  const named = (listed ?? "")
    .split("\n")
    .map((line) => {
      const [key = "", url = ""] = line.split(/\s+/u, 2);
      return { remote: key.replace(/^remote\./u, "").replace(/\.url$/u, ""), at: URL.parse(url) };
    })
    .flatMap(({ remote, at }) => {
      if (at === null || at.origin !== keel) return [];
      const parts = at.pathname
        .replace(/^\/+/u, "")
        .replace(/\/+$/u, "")
        .replace(/\.git$/u, "")
        .split("/");
      const [handle, name] = parts;
      return parts.length === 2 &&
        handle !== undefined &&
        name !== undefined &&
        handle !== "" &&
        name !== ""
        ? [{ remote, handle, name }]
        : [];
    });
  const chosen = named.find((r) => r.remote === "origin") ?? named[0];
  if (chosen === undefined) return undefined;
  const others = named.filter((r) => r.handle !== chosen.handle || r.name !== chosen.name);
  if (chosen.remote !== "origin" && others.length > 0) return undefined;
  return { toplevel, handle: chosen.handle, name: chosen.name };
}

/** The agent this machine holds a key for: a client for any project, each token for that project and the hook's run. */
async function agentOf(
  context: HookContext,
): Promise<{ readonly client: (project?: string) => KeelClient } | undefined> {
  const held = await heldKey(
    context.io.env,
    context.io.keyStore,
    entryName(context.baseUrl, context.profile),
  );
  const agentId = held?.agentId;
  if (held === undefined || agentId === undefined) {
    context.io.stderr(
      `keeltown hook: this machine holds no signed-up agent key${context.profile === undefined ? "" : ` for profile ${context.profile}`}`,
    );
    return undefined;
  }
  return {
    client: (project) =>
      createKeelClient({
        baseUrl: context.baseUrl,
        agentId,
        key: held.signer,
        run: context.run,
        ...(project === undefined ? {} : { project }),
        fetch: context.fetch,
      }),
  };
}

/** The project a place names, as this session found it before or as Keel answers it now; the state, knowing it. */
async function projectOf(
  context: HookContext,
  agent: { readonly client: (project?: string) => KeelClient },
  place: Place,
  state: SessionState,
): Promise<{ readonly project: Project; readonly state: SessionState }> {
  const key = `${context.baseUrl} ${place.handle}/${place.name}`;
  const known = state.projects[key];
  if (known !== undefined) return { project: known, state };
  const found = await agent.client().project(place.handle, place.name, { signal: context.signal });
  const project = { id: found.id, visibility: found.visibility };
  return { project, state: { ...state, projects: { ...state.projects, [key]: project } } };
}

/** Where a session's state is kept: the machine's temp dir, one file a session. */
function stateFile(io: Io, session: string | undefined): string | undefined {
  if (session === undefined || !/^[A-Za-z0-9-]{1,128}$/u.test(session)) return undefined;
  return join(io.env["TMPDIR"] ?? tmpdir(), "keeltown-hooks", `${session}.json`);
}

function readState(io: Io, session: string | undefined): SessionState {
  const file = stateFile(io, session);
  const empty: SessionState = { told: [], projects: {} };
  if (file === undefined) return empty;
  try {
    const read: unknown = JSON.parse(readFileSync(file, "utf8"));
    const told: unknown = Reflect.get(Object(read), "told");
    const projects: unknown = Reflect.get(Object(read), "projects");
    return {
      told: Array.isArray(told) ? told.filter((id): id is string => typeof id === "string") : [],
      projects: typeof projects === "object" && projects !== null ? Object(projects) : {},
    };
  } catch {
    return empty;
  }
}

function writeState(io: Io, session: string | undefined, state: SessionState): void {
  const file = stateFile(io, session);
  if (file === undefined) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state));
  } catch (error) {
    io.stderr(`keeltown hook: could not keep the session's state: ${messageOf(error)}`);
  }
}
