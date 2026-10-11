// The playhead. It reads a source's log, reveals it up to an instant, and
// keeps the world folded to exactly that instant. With a finished or scripted
// log it can be paused, sped up and wound back; with a live one it follows the
// tail. The story never runs past a question nobody has answered.

import type { AnyEvent } from "../contract/events.ts";
import type { Lattice } from "../contract/keel/index.ts";
import type { Observation } from "../contract/observations.ts";
import type {
  KeelCommands,
  KeelEventSource,
  KeelResources,
  ChangeDiff,
  ProbeSource,
  VerdictReasons,
} from "../source/types.ts";
import type { KeelRepository } from "../source/repository.ts";
import { Projects, projectOf } from "./projects.ts";
import { RepositoryReader } from "./repository.ts";
import { World } from "./world.ts";

export type ConsoleSource = KeelEventSource &
  KeelResources &
  KeelRepository &
  KeelCommands & {
    /** The question a scripted story is holding at, if the source knows of one. */
    openGate?(): { escalationId: string; t: number } | undefined;
  };

type Listener = () => void;

export class Player {
  readonly source: ConsoleSource;
  readonly probes = new Map<string, ProbeSource>();
  readonly diffs = new Map<string, ChangeDiff>();
  /** What Keel was asked for beside the log and would not give, by the id of the thing it was asked about. */
  readonly refused = new Set<string>();
  readonly verdicts = new Map<string, VerdictReasons>();
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

  #epochMs: number;
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
  #listeners = new Set<Listener>();
  #timeListeners = new Set<Listener>();
  #requested = new Set<string>();

  constructor(source: ConsoleSource) {
    this.source = source;
    this.#epochMs = Date.parse(source.descriptor.epoch);
    // The repository is read for the project the address names. Its id is the one the log gave it; a reader
    // the log is closed to has only the name.
    this.repository = new RepositoryReader(
      source,
      () => this.#changed(),
      () => {
        if (this.#scope === null) return undefined;
        const known = this.projects.named(this.#scope);
        return known === undefined
          ? { name: this.#scope }
          : { id: known.id, name: known.name, visibility: known.visibility };
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
    // Keel reads them to whoever it reads its log to, so a reader with a closed log is shown no conflict and asks for none.
    if (this.source.descriptor.log === "open")
      void this.#fetch(async () => {
        for (const lattice of (await this.source.getLattices()).items)
          this.lattices.set(lattice.predicate, lattice);
      });
    await this.#drain();
    this.#changed();
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
    for (const event of events) {
      this.projects.note(event);
      // The log's own order is the truth; `at` only says how far along it we are.
      const at = Math.max(Date.parse(event.at) - this.#epochMs, this.#eventTimes.at(-1) ?? 0);
      this.#events.push(event);
      this.#eventTimes.push(at);
    }
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
    // A log Keel will not read to this reader has no tail to follow, and asking again changes nothing.
    if (this.source.descriptor.log === "closed") return;
    while (!signal.aborted) {
      const asked = Date.now();
      try {
        // oxlint-disable-next-line no-await-in-loop -- a long-poll loop reads one page after another by nature
        const page = await this.source.readEvents({
          ...(this.#eventCursor === undefined ? {} : { cursor: this.#eventCursor }),
          waitSec: 25,
          signal,
        });
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
      } catch {
        // The stream dropped. Wait, then pick up from the same cursor: nothing is lost.
      }
      // An empty answer that came straight back means the wait was not honoured; do not spin.
      // oxlint-disable-next-line no-await-in-loop -- as above
      if (!signal.aborted && Date.now() - asked < 1_000)
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async #drain(): Promise<void> {
    const events = await this.source.readEvents(
      this.#eventCursor === undefined ? {} : { cursor: this.#eventCursor },
    );
    this.#append(events.items);
    this.#eventCursor = events.nextCursor;
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
    if (events.items.length > 0 || observations.items.length > 0) await this.#drain();
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
    if (moved) this.#fetchResources();
    return moved;
  }

  /** Sources and diffs are fetched once, when the world first mentions them. */
  #fetchResources(): void {
    for (const probe of this.world.probes.values()) {
      if (this.#requested.has(probe.id)) continue;
      this.#requested.add(probe.id);
      void this.#fetch(async () => {
        this.probes.set(probe.id, await this.source.getProbeSource(probe.id));
      });
    }
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
    void this.#fetch(async () => {
      this.verdicts.set(verdictId, await this.source.getVerdict(verdictId));
    });
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
    // Live, playing means keeping up with the tail. A replay advances at its own rate.
    this.t = this.live ? this.end : Math.min(this.t + elapsedMs * this.rate, this.horizon);
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
  async rule(escalationId: string, option: string): Promise<void> {
    await this.source.giveRuling({
      escalationId,
      option,
      idempotencyKey: `console:${escalationId}:${option}`,
    });
    await this.#drain();
    this.#reveal();
    this.#changed();
  }
}
