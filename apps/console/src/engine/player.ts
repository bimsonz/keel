// The playhead. It reads a source's log, reveals it up to an instant, and
// keeps the world folded to exactly that instant. With a finished or scripted
// log it can be paused, sped up and wound back; with a live one it follows the
// tail. The story never runs past a question nobody has answered.

import type { AnyEvent } from "../contract/events.ts";
import type {
  AgentCard,
  ChangeSummary,
  Lattice,
  ProbeSource,
  VerdictView,
} from "../contract/keel/index.ts";
import type { Observation } from "../contract/observations.ts";
import type {
  KeelAgents,
  KeelCommands,
  KeelInvited,
  KeelRemembered,
  KeelIssued,
  KeelSettings,
  KeelSync,
  KeelTargeted,
  KeelEventSource,
  KeelResources,
  ChangeDiff,
  Page,
} from "../source/types.ts";
import { backoffMs, pause, retryable } from "../source/backoff.ts";
import type { KeelRepository } from "../source/repository.ts";
import { Projects, type Visibility, projectOf } from "./projects.ts";
import { RepositoryReader } from "./repository.ts";
import { provisionalWorld } from "./seed.ts";
import { World } from "./world.ts";

/** How many times a page of the log is asked for, at most, while Keel is away: about two minutes, backed off. */
const DRAIN_TRIES = 8;

export type ConsoleSource = KeelEventSource &
  KeelResources &
  KeelRepository &
  KeelCommands &
  // A fixture's source holds no settings, no deploy targets, no memory of decisions and no agent's card: only
  // Keel does.
  Partial<KeelSettings> &
  Partial<KeelSync> &
  Partial<KeelInvited> &
  Partial<KeelTargeted> &
  Partial<KeelRemembered> &
  Partial<KeelIssued> &
  Partial<KeelAgents> & {
    /** The question a scripted story is holding at, if the source knows of one. */
    openGate?(): { escalationId: string; t: number } | undefined;
  };

type Listener = () => void;

export class Player {
  readonly source: ConsoleSource;
  readonly probes = new Map<string, ProbeSource>();
  readonly diffs = new Map<string, ChangeDiff>();
  /** Keel's public card of each agent asked for, by its id: null where Keel knows none by that id. */
  readonly cards = new Map<string, AgentCard | null>();
  /** Keel's read model of each change asked for by its number while the log is read: null where it has none. */
  readonly summaries = new Map<number, ChangeSummary | null>();
  /** What Keel was asked for beside the log and would not give, by the id of the thing it was asked about. */
  readonly refused = new Set<string>();
  readonly verdicts = new Map<string, VerdictView>();
  /** Keel's lattices, by predicate. Empty until they have been read, and for good if they cannot be. */
  readonly lattices = new Map<string, Lattice>();
  /** The project's repository, read as the repository view asks for it. */
  readonly repository: RepositoryReader;
  /** Every project the log has named, whichever one is being shown. */
  readonly projects = new Projects();
  world = new World();
  /** Simulated time, in ms from the source's epoch. */
  t = 0;
  playing = false;
  rate = 1;
  /** Bumps whenever what the views show may have changed. */
  version = 0;
  /** Events of the project being shown that could not be folded. They are left out of what is shown, and said. */
  unread = 0;
  /**
   * True once the log has been read to its end for the first time. Until then the world is short of what Keel
   * has said, and a page that is read from the log has nothing to show yet; the code needs none of it.
   */
  loaded = false;

  /** The log's first instant, in ms since 1970. Unknown until the source says, or the log's first entry does. */
  #epochAt: number | undefined;
  #events: AnyEvent[] = [];
  #eventTimes: number[] = [];
  #observations: Observation[] = [];
  #observationTimes: number[] = [];
  #eventCursor: string | undefined;
  #observationCursor: string | undefined;
  #nextEvent = 0;
  #nextObservation = 0;
  /** The name of the project whose events are folded. Null folds none: the bare address is the instance's. */
  #scope: string | null = null;
  /** Keel's snapshot of the log's head, drawn by the list of changes while the log is read. Nothing folds into it. */
  #seeded: World | null = null;
  #listeners = new Set<Listener>();
  #timeListeners = new Set<Listener>();
  #requested = new Set<string>();

  /** The wall clock, in ms since 1970. A live console's "now" is read from it; a test gives its own. */
  readonly #now: () => number;

  constructor(source: ConsoleSource, now: () => number = Date.now) {
    this.source = source;
    this.#now = now;
    const { epoch, project } = source.descriptor;
    if (epoch !== undefined) this.#epochAt = Date.parse(epoch);
    // A source that reads one project says which, in Keel's own words for it: that is the project shown.
    if (project !== undefined) {
      this.projects.know(project);
      this.#scope = project.name;
    }
    // The repository is read for the project being shown, by the id Keel gave it.
    this.repository = new RepositoryReader(
      source,
      () => this.#changed(),
      () => {
        if (this.#scope === null) return undefined;
        const known = this.projects.named(this.#scope);
        if (known === undefined) return { name: this.#scope };
        return { id: known.id, name: known.name, visibility: known.visibility };
      },
    );
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Called on every tick of the clock, whether or not the world changed. */
  subscribeTime = (listener: Listener): (() => void) => {
    this.#timeListeners.add(listener);
    return () => this.#timeListeners.delete(listener);
  };

  /** The log's first instant. A log with nothing in it yet begins now. */
  get #epochMs(): number {
    return this.#epochAt ?? this.#now();
  }

  /**
   * Who may read the project being shown, as Keel answered when its settings were read or replaced. It is
   * Keel's own word and newer than what it said when the project was found; the log says what changes after.
   */
  readBy(visibility: Visibility): void {
    const { project } = this.source.descriptor;
    if (project === undefined || this.projects.named(project.name)?.visibility === visibility)
      return;
    this.projects.know({ id: project.id, name: project.name, visibility });
    this.#changed();
  }

  #changed(): void {
    this.version += 1;
    for (const listener of this.#listeners) listener();
    for (const listener of this.#timeListeners) listener();
  }

  /** The last instant the log reaches. */
  get end(): number {
    return Math.max(this.#eventTimes.at(-1) ?? 0, this.#observationTimes.at(-1) ?? 0);
  }

  /** How far the story may run right now: to its end, or to a question still open. */
  get horizon(): number {
    return this.source.openGate?.()?.t ?? this.end;
  }

  /** True while the story waits at a question for a person. */
  get held(): boolean {
    const gate = this.source.openGate?.();
    return gate !== undefined && this.t >= gate.t;
  }

  /** Read everything the source has, page by page. */
  async load(): Promise<void> {
    // The lattices are the same for the whole run. Without them a conflict's page draws no line; nothing else waits on them.
    void this.#fetch(async () => {
      for (const lattice of (await this.source.getLattices()).items)
        this.lattices.set(lattice.predicate, lattice);
    });
    // Keel's snapshot of the log's head comes in one read: its changes are drawn while the log is read behind them.
    let drained = false;
    void this.#seed(() => !drained);
    await this.#drain();
    drained = true;
    // The log is read, and its own world folded to its end: the snapshot's is put away.
    this.#seeded = null;
    this.loaded = true;
    this.#changed();
  }

  /**
   * Draws a live project's snapshot while its log is read, if the snapshot comes while it is still wanted. The
   * log is never held for it: a snapshot slower than the log is not drawn.
   */
  async #seed(wanted: () => boolean): Promise<void> {
    const read = this.source.readSnapshot?.bind(this.source);
    if (read === undefined || !this.live) return;
    try {
      const snapshot = await read();
      if (!wanted()) return;
      this.#seeded = provisionalWorld(snapshot);
      this.#changed();
    } catch {
      // No snapshot: the pages wait for the log, as they did before there was one.
    }
  }

  /**
   * Show one project: the world is folded again from the log's start, from that project's events alone. The
   * log holds every project an observer may read, and one project's pages must not count another's.
   */
  scopeTo(project: string | null): void {
    if (project === this.#scope) return;
    this.#scope = project;
    this.world = new World();
    this.unread = 0;
    this.#nextEvent = 0;
    this.#nextObservation = 0;
    this.#reveal();
    this.#changed();
  }

  /**
   * Folds one event. Keel's log is read as it comes: an entry this console cannot fold (written before a shape
   * changed, say) is left out and counted, where otherwise one such entry would stop everything after it from
   * being shown. A fixture's log is this console's own, so a fault folding one is a fault here, and is thrown.
   */
  #fold(event: AnyEvent, at: number): void {
    if (!this.live) {
      this.world.apply(event, at);
      return;
    }
    try {
      this.world.apply(event, at);
    } catch (error) {
      this.unread += 1;
      console.warn(`The console could not fold ${event.type} ${event.eventId}:`, error);
    }
  }

  /** Whether an event is one of the project being shown. An event Keel gave no project is no project's. */
  #shown(event: AnyEvent): boolean {
    const project = this.#scope === null ? undefined : this.projects.named(this.#scope);
    return project !== undefined && projectOf(event) === project.id;
  }

  #append(events: readonly AnyEvent[]): void {
    const [first] = events;
    if (first !== undefined) this.#epochAt ??= Date.parse(first.at);
    for (const event of events) {
      this.projects.note(event);
      // The log's own order is the truth; `at` only says how far along it we are.
      const at = Math.max(Date.parse(event.at) - this.#epochMs, this.#eventTimes.at(-1) ?? 0);
      this.#events.push(event);
      this.#eventTimes.push(at);
    }
  }

  /** True while Keel's snapshot of the log's head is drawn, while the log is read. */
  get provisional(): boolean {
    return this.#seeded !== null;
  }

  /** The world of Keel's snapshot of the log's head while the log is read, or null once it is (seed.ts). */
  get seeded(): World | null {
    return this.#seeded;
  }

  /** True when the source is the real stream, which grows while we watch. */
  get live(): boolean {
    return this.source.descriptor.mode === "live";
  }

  /**
   * Keep reading the tail until `signal` aborts. While playing, a live console
   * shows everything that has arrived; paused or scrubbed back, it shows history.
   */
  async follow(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const asked = Date.now();
      let failed: unknown;
      try {
        // oxlint-disable-next-line no-await-in-loop -- a long-poll loop reads one page after another by nature
        const page = await this.source.readEvents({
          ...(this.#eventCursor === undefined ? {} : { cursor: this.#eventCursor }),
          waitSec: 25,
          signal,
        });
        failures = 0;
        const movedOn = page.nextCursor !== this.#eventCursor;
        this.#append(page.items);
        this.#eventCursor = page.nextCursor;
        if (page.items.length > 0) {
          if (this.playing) {
            this.t = this.end;
            this.#reveal();
          }
          this.#changed();
          continue;
        }
        // A stretch of the log that held nothing of this project's: the next is read at once.
        if (movedOn) continue;
      } catch (error) {
        // The stream dropped, or Keel was away for a moment. Pick up from the same cursor, nothing lost, but
        // later each time it fails again and never sooner than Keel asked (backoff.ts): a struggling Keel is
        // not asked harder by every reader at once.
        failures += 1;
        failed = error;
      }
      if (signal.aborted) return;
      // oxlint-disable-next-line no-await-in-loop -- as above
      if (failures > 0) await pause(backoffMs(failed, failures), signal);
      // An empty answer that came straight back means the wait was not honoured; do not spin.
      // oxlint-disable-next-line no-await-in-loop -- as above
      else if (Date.now() - asked < 1_000) await pause(1_000, signal);
    }
  }

  /**
   * Reads the log to its end. Keel's log is the whole instance's, and a page of it is the next stretch with
   * this project's entries picked out: a stretch that holds none is an empty page whose cursor has still moved
   * on. So an empty page is not the end. The end is the page whose cursor has not moved.
   */
  async #drain(): Promise<void> {
    for (;;) {
      const from = this.#eventCursor;
      // oxlint-disable-next-line no-await-in-loop -- a page names the next one
      const events = await this.#page(from);
      this.#append(events.items);
      this.#eventCursor = events.nextCursor;
      // oxlint-disable-next-line no-await-in-loop -- as above
      const observations = await this.source.readObservations(
        this.#observationCursor === undefined ? {} : { cursor: this.#observationCursor },
      );
      for (const observation of observations.items) {
        const at = Math.max(
          Date.parse(observation.at) - this.#epochMs,
          this.#observationTimes.at(-1) ?? 0,
        );
        this.#observations.push(observation);
        this.#observationTimes.push(at);
      }
      this.#observationCursor = observations.nextCursor;
      // Keel's log is shown as it is read: a big project's pages take seconds, and a page asks only for what
      // it names, so what each page brings is folded as it comes rather than once the last has.
      if (this.live && !this.loaded) this.seek(this.end);
      const movedOn = events.nextCursor !== (from ?? "");
      if (events.items.length === 0 && observations.items.length === 0 && !movedOn) return;
    }
  }

  /**
   * One page of the log from `from`. Keel away for a moment, or a read that dropped on the way, is asked again
   * from the same cursor, later each time (backoff.ts), up to `DRAIN_TRIES` times; a refusal is Keel's answer,
   * and fails the read at once.
   */
  async #page(from: string | undefined): Promise<Page<AnyEvent>> {
    for (let failures = 1; ; failures += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- each try waits for the last to fail
        return await this.source.readEvents(from === undefined ? {} : { cursor: from });
      } catch (error) {
        if (!retryable(error) || failures >= DRAIN_TRIES) throw error;
        // oxlint-disable-next-line no-await-in-loop -- as above
        await pause(backoffMs(error, failures));
      }
    }
  }

  /** Fold everything stamped at or before `t` that is not folded yet, in time order. */
  #reveal(): boolean {
    let moved = false;
    for (;;) {
      const eventAt = this.#eventTimes[this.#nextEvent];
      const observationAt = this.#observationTimes[this.#nextObservation];
      const eventDue = eventAt !== undefined && eventAt <= this.t;
      const observationDue = observationAt !== undefined && observationAt <= this.t;
      if (!eventDue && !observationDue) break;
      if (eventDue && (!observationDue || eventAt <= observationAt)) {
        const event = this.#events[this.#nextEvent];
        if (event !== undefined && this.#shown(event)) this.#fold(event, eventAt);
        this.#nextEvent += 1;
      } else {
        const observation = this.#observations[this.#nextObservation];
        if (observation !== undefined) this.world.observe(observation);
        this.#nextObservation += 1;
      }
      moved = true;
    }
    return moved;
  }

  /** Read a probe's source from Keel, once. Called when its conflict's page is opened: a swarm has hundreds. */
  wantProbe(probeId: string): void {
    if (!this.world.probes.has(probeId) || this.#requested.has(probeId)) return;
    this.#requested.add(probeId);
    void this.#fetch(
      async () => {
        this.probes.set(probeId, await this.source.getProbeSource(probeId));
      },
      () => this.refused.add(probeId),
    );
  }

  /**
   * Read Keel's public card of each of these agents, once each: the ones the log names by an id alone.
   * Called by the agents' pages for the rows they show: a swarm's log names hundreds.
   */
  wantCards(agentIds: readonly string[]): void {
    const find = this.source.findAgent?.bind(this.source);
    if (find === undefined) return;
    for (const agentId of agentIds) {
      const asked = `card:${agentId}`;
      if (this.#requested.has(asked)) continue;
      this.#requested.add(asked);
      void this.#fetch(async () => {
        this.cards.set(agentId, await find(agentId));
      });
    }
  }

  /**
   * Ask Keel where one change stands now, by its number, once: what its page draws while the log is read. Only
   * Keel's own source has it; a fixture's page is drawn from its log.
   */
  wantSummary(number: number): void {
    const read = this.source.readChange?.bind(this.source);
    if (read === undefined || !this.live) return;
    const asked = `summary:${number}`;
    if (this.#requested.has(asked)) return;
    this.#requested.add(asked);
    void this.#fetch(
      async () => {
        this.summaries.set(number, await read(number));
      },
      () => this.summaries.set(number, null),
    );
  }

  /**
   * Whether the log as folded so far holds every entry up to the instant `at`: it has been read past it and
   * the playhead stands at or beyond it.
   */
  readThrough(at: string): boolean {
    const due = Date.parse(at) - this.#epochMs;
    return (this.#eventTimes.at(-1) ?? Number.NEGATIVE_INFINITY) >= due && this.t >= due;
  }

  /** Ask Keel which open questions it lists to this reader, once. Called when a question's page is opened. */
  wantAsked(): void {
    if (this.#requested.has("asked")) return;
    this.#requested.add("asked");
    void this.#fetch(async () => {
      await this.source.readAsked?.();
    });
  }

  /** Fetch a change's diff, once. Called when its page is opened: a swarm has thousands. */
  wantDiff(changeId: string): void {
    if (this.world.changes.get(changeId)?.commit === undefined || this.#requested.has(changeId))
      return;
    this.#requested.add(changeId);
    void this.#fetch(
      async () => {
        this.diffs.set(changeId, await this.source.getDiff(changeId));
      },
      () => this.refused.add(changeId),
    );
  }

  /** Fetch the evidence behind a change's latest verdict, once. Called when its page is opened. */
  wantVerdict(changeId: string): void {
    const verdictId = this.world.changes.get(changeId)?.verdictIds.at(-1);
    if (verdictId === undefined || this.#requested.has(verdictId)) return;
    this.#requested.add(verdictId);
    // Where Keel serves no view of the verdict, the page is told so: what the verdict's own event recorded is
    // then all there is to show of its evidence.
    void this.#fetch(
      async () => {
        this.verdicts.set(verdictId, await this.source.getVerdict(verdictId));
      },
      () => this.refused.add(verdictId),
    );
  }

  async #fetch(load: () => Promise<void>, failed?: () => void): Promise<void> {
    try {
      await load();
    } catch {
      // A missing resource leaves its panel empty, and where the panel says why, it is told; the story goes on.
      failed?.();
    }
    this.#changed();
  }

  /** Move to an instant. Going back replays from the start, so the world is always exactly the log up to `t`. */
  seek(t: number): void {
    const target = Math.min(Math.max(0, t), this.horizon);
    if (target < this.t) {
      this.#seeded = null;
      this.world = new World();
      this.unread = 0;
      this.#nextEvent = 0;
      this.#nextObservation = 0;
    }
    this.t = target;
    this.#reveal();
    this.#changed();
  }

  play(): void {
    this.playing = true;
    this.#changed();
  }

  pause(): void {
    this.playing = false;
    this.#changed();
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.#changed();
  }

  /** Advance by `elapsedMs` of real time. Returns whether anything a view shows changed. */
  tick(elapsedMs: number): boolean {
    if (!this.playing) return false;
    const before = this.t;
    // Live, playing means now: the wall clock, which goes on when Keel's log is quiet, so what finished a
    // while ago is seen to have. It is never behind the log's own end, whatever this machine's clock says.
    // A replay advances at its own rate.
    this.t = this.live
      ? Math.max(this.end, this.#now() - this.#epochMs)
      : Math.min(this.t + elapsedMs * this.rate, this.horizon);
    if (this.t === before) return false;
    // Views re-read only when the world moved; the clock's readers hear every tick.
    if (this.#reveal() || this.t === this.horizon) this.#changed();
    else for (const listener of this.#timeListeners) listener();
    return true;
  }

  /** Whether this console may rule on a question. A fixture takes a ruling only where its story holds for one. */
  canRule(escalationId: string): boolean {
    return (
      this.source.canRule?.(escalationId) ?? this.source.openGate?.()?.escalationId === escalationId
    );
  }

  /** Answer a question. The answer is never applied here: its effect arrives through the log. */
  async rule(escalationId: string, option: string, rationale?: string): Promise<void> {
    await this.source.giveRuling({
      escalationId,
      option,
      idempotencyKey: `console:${escalationId}:${option}`,
      ...(rationale === undefined ? {} : { rationale }),
    });
    await this.#drain();
    this.#reveal();
    this.#changed();
  }
}
