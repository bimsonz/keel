// The mock behind the console's three ports. It serves a generated log by
// cursor, exactly as the real endpoint will; it has no clock of its own. The
// one thing that changes it is a ruling, which appends that option's
// continuation to the log.

import type { AnyEvent } from "../../../src/contract/events.ts";
import type {
  NamespaceRef,
  ProbeSource,
  ProjectView,
  VerdictView,
} from "../../../src/contract/keel/index.ts";
import type { Observation } from "../../../src/contract/observations.ts";
import { Projects } from "../../../src/engine/projects.ts";
import type {
  ChangeDiff,
  KeelCommands,
  KeelDirectory,
  KeelEventSource,
  KeelResources,
  Page,
  ReadRequest,
  RulingCommand,
  SourceDescriptor,
} from "../../../src/source/types.ts";
import { LATTICES } from "../lattices.ts";
import type { KeelRepository } from "../../../src/source/repository.ts";
import type { Gate, GeneratedLog } from "./builder.ts";
import { generateS3, generateS4 } from "./proven.ts";
import { createMockRepository } from "./repository.ts";
import { type S1Ruling, generateS1 } from "./s1.ts";
import { generateS2 } from "./s2.ts";
import { generateS5 } from "./same.ts";
import { generateS6 } from "./doubt.ts";
import { generateSwarm } from "./swarm.ts";

/**
 * `s1` is the two-agent conflict and `s2` its sequel nine days on. `s3` and `s4` are the same conflict in a
 * project that asks nobody: proven, and then noted on both changes (`s3`) or bouncing both (`s4`). `s5` is
 * three agents with the same intent, shown to each other. `s6` is a premise Keel put in doubt, by an edit and by an
 * effect. `swarm` is hundreds of hosted agents.
 */
export const SCENARIOS = ["s1", "s2", "s3", "s4", "s5", "s6", "swarm"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function isScenario(value: string): value is Scenario {
  return SCENARIOS.some((scenario) => scenario === value);
}

export interface MockOptions {
  scenario: Scenario;
  seed: number;
  /** For the swarm: how many hosted agents, and for how many simulated seconds they keep starting changes. */
  agents?: number;
  seconds?: number;
  /** An option id plays the story through with that ruling. `live` holds at the question for a person. */
  ruling?: string;
}

export interface MockSource extends KeelEventSource, KeelResources, KeelRepository, KeelCommands {
  /** The question the story is holding at, if any. */
  openGate(): Gate | undefined;
}

/** The org every fixture's projects are in: the first segment of a fixture's addresses. */
/** The namespace every fixture's project is in: an org, which the fixture's reader owns. */
export const FIXTURE_NAMESPACE: NamespaceRef = { handle: "acme", kind: "org" };

/**
 * A fixture's projects, named as Keel names its own: by namespace and name. They are the ones the fixture's
 * log creates, all in one org, and the fixture's reader is a member of it.
 */
export async function fixtureDirectory(source: MockSource): Promise<KeelDirectory> {
  const named = new Projects();
  const createdAt = new Map<string, string>();
  let cursor: string | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a page names the next one
    const read = await source.readEvents(cursor === undefined ? {} : { cursor });
    for (const event of read.items) {
      named.note(event);
      if (event.type === "ProjectCreated") createdAt.set(event.payload.projectId, event.at);
    }
    if (read.items.length === 0) break;
    cursor = read.nextCursor;
  }
  const listed = (): ProjectView[] =>
    named.list.map((project) => ({
      id: project.id,
      namespace: FIXTURE_NAMESPACE,
      name: project.name,
      visibility: project.visibility,
      createdAt: createdAt.get(project.id) ?? "",
      viewer: { role: "owner" },
    }));
  return {
    // Only Keel makes a project: a test fixture's log is what it is.
    createProject: () => Promise.reject(new Error("A test fixture makes no project")),
    findNamespace: (handle) =>
      Promise.resolve(
        handle === FIXTURE_NAMESPACE.handle
          ? { id: "org_0000000000000000000000ACME", ...FIXTURE_NAMESPACE }
          : null,
      ),
    findProject: (namespace, name) =>
      Promise.resolve(
        namespace === FIXTURE_NAMESPACE.handle
          ? (listed().find((project) => project.name === name) ?? null)
          : null,
      ),
    listProjects: () => Promise.resolve(listed()),
    // A fixture has nobody signed in: no question is listed to anyone, and no feed is anyone's own.
    listWaiting: () => Promise.resolve([]),
    readOwnFeed: (asked) => Promise.resolve({ items: [], nextCursor: asked.cursor ?? "0" }),
  };
}

const S1_RULINGS: ReadonlySet<string> = new Set(["no-cache", "invalidate", "allow-stale"]);

function isS1Ruling(value: string): value is S1Ruling {
  return S1_RULINGS.has(value);
}

function generate(options: MockOptions, ruling: string | undefined): GeneratedLog {
  if (options.scenario === "swarm") {
    return generateSwarm(options.seed, {
      ...(options.agents === undefined ? {} : { agents: options.agents }),
      ...(options.seconds === undefined ? {} : { seconds: options.seconds }),
    });
  }
  if (options.scenario === "s2") return generateS2(options.seed);
  if (options.scenario === "s3") return generateS3(options.seed);
  if (options.scenario === "s4") return generateS4(options.seed);
  if (options.scenario === "s5") return generateS5(options.seed);
  if (options.scenario === "s6") return generateS6(options.seed);
  if (ruling === undefined || ruling === "live") return generateS1(options.seed);
  if (!isS1Ruling(ruling)) throw new Error(`scenario s1 has no ruling "${ruling}"`);
  return generateS1(options.seed, ruling);
}

function page<Item>(items: readonly Item[], request: ReadRequest): Page<Item> {
  const start = Math.max(0, Number(request.cursor ?? "0") || 0);
  const limit = Math.min(Math.max(request.limit ?? 500, 1), 500);
  const slice = items.slice(start, start + limit);
  return { items: slice, nextCursor: String(start + slice.length) };
}

export function createMockSource(options: MockOptions): MockSource {
  // A deep link past the question implies the scripted ruling unless it names one.
  const unruled = generate(options, undefined);
  const scripted = unruled.gates[0]?.scripted;
  let log = options.ruling === "live" ? unruled : generate(options, options.ruling ?? scripted);
  let waiters: (() => void)[] = [];

  const descriptor: SourceDescriptor = {
    mode: "fixture",
    scenario: options.scenario,
    seed: options.seed,
    epoch: log.epoch,
  };

  async function read<Item>(
    items: () => readonly Item[],
    request: ReadRequest,
  ): Promise<Page<Item>> {
    const first = page(items(), request);
    if (first.items.length > 0 || (request.waitSec ?? 0) <= 0) return first;
    // Nothing new: wait for the log to grow, the request to be abandoned, or the wait to run out.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, (request.waitSec ?? 0) * 1000);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(done);
      request.signal?.addEventListener("abort", done, { once: true });
    });
    return page(items(), request);
  }

  return {
    descriptor,
    openGate: () => log.gates[0],
    readEvents: (request = {}) => read<AnyEvent>(() => log.events, request),
    readObservations: (request = {}) => read<Observation>(() => log.observations, request),

    getDiff(changeId: string): Promise<ChangeDiff> {
      const diff = log.diffs.get(changeId);
      return diff === undefined
        ? Promise.reject(new Error(`no diff for ${changeId}`))
        : Promise.resolve(diff);
    },
    getProbeSource(probeId: string): Promise<ProbeSource> {
      const probe = log.probes.get(probeId);
      return probe === undefined
        ? Promise.reject(new Error(`no source for ${probeId}`))
        : Promise.resolve(probe);
    },
    // The repository follows the log, so a ruling that replaces the log changes what trunk holds.
    ...createMockRepository(() => log),
    getLattices: () => Promise.resolve(LATTICES),
    getVerdict(verdictId: string): Promise<VerdictView> {
      const verdict = log.verdicts.get(verdictId);
      return verdict === undefined
        ? Promise.reject(new Error(`no verdict ${verdictId}`))
        : Promise.resolve(verdict);
    },

    giveRuling(command: RulingCommand): Promise<void> {
      const gate = log.gates[0];
      if (gate === undefined || gate.escalationId !== command.escalationId) {
        return Promise.reject(new Error(`${command.escalationId} is not open`));
      }
      if (!gate.options.includes(command.option)) {
        return Promise.reject(new Error(`${command.option} is not one of its options`));
      }
      const ruled = generate(options, command.option);
      // The continuation only ever adds to the log: what a reader already has stays true.
      const known = log.events.length;
      if (
        ruled.events
          .slice(0, known)
          .some((event, index) => event.eventId !== log.events[index]?.eventId)
      ) {
        return Promise.reject(new Error("the ruled log does not continue the one already served"));
      }
      log = ruled;
      const woken = waiters;
      waiters = [];
      for (const wake of woken) wake();
      return Promise.resolve();
    },
  };
}
