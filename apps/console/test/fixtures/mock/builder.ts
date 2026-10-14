// Builds a log the way Keel would have written it: one envelope per event,
// gap-free `seq` per entity, ids that sort by time, causation by event id.
// A script says what happened and when; the builder does the bookkeeping, and
// does it the same way for the same seed, every time.

import type { EntityRef, EventType } from "../../../src/contract/envelope.ts";
import type { AnyEvent, EventOf } from "../../../src/contract/events.ts";
import type { VerdictOutcome } from "../../../src/contract/mfp.ts";
import type { Observation } from "../../../src/contract/observations.ts";
import type { LandedFile, Landing } from "../repo.ts";
import { type Rng, ulidAt } from "../prng.ts";
import { funnelFrames } from "./funnel.ts";
import type { ScriptedEvent } from "./scripted.ts";
import type {
  ProbeSource,
  RunRef,
  VerdictPlan,
  VerdictView,
} from "../../../src/contract/keel/index.ts";
import type { ChangeDiff } from "../../../src/source/types.ts";
import { reasonOf } from "./plans.ts";

type EventInput = {
  [Type in EventType]: {
    type: Type;
    entity: EntityRef;
    /** The payload as Keel has it. Its `_tag` is the event's type, and is filled in. */
    payload: Omit<EventOf<Type>["payload"], "_tag">;
    /** The event that triggered this one, when another entity's event did. */
    causation?: AnyEvent;
    /** The short name Keel's Projector gives what this event creates. */
    label?: string;
    actor?: string;
    /** The run the actor's token named, as Keel writes it on the entry. */
    run?: RunRef;
  };
}[EventType];

/** `at` is filled in from the builder's clock. */
type ObservationInput = Observation extends infer O
  ? O extends Observation
    ? Omit<O, "at">
    : never
  : never;

/** A point the story cannot pass until a person rules. */
export interface Gate {
  escalationId: string;
  /** Milliseconds from the epoch: the latest instant reachable without a ruling. */
  t: number;
  options: string[];
  /** The option a replay takes when nobody is asked. */
  scripted: string;
}

export interface GeneratedLog {
  epoch: string;
  /** In log order. `t[i]` is the offset of `events[i]` from the epoch, in ms. */
  events: ScriptedEvent[];
  eventTimes: number[];
  observations: Observation[];
  observationTimes: number[];
  /** Gates not yet decided. An empty list means the story runs to its end. */
  gates: Gate[];
  diffs: Map<string, ChangeDiff>;
  probes: Map<string, ProbeSource>;
  /** Each verdict's evidence, as Keel's read model would serve it. */
  verdicts: Map<string, VerdictView>;
  /** The repository the story is about, where the script has one: what trunk starts with, and what each change lands. */
  repository?: ScriptedRepository;
  /** The story's last instant, in ms from the epoch. */
  end: number;
}

export interface ScriptedRepository {
  base: LandedFile[];
  anchors: Landing["anchors"];
  /** By change id. A change that lands with nothing here leaves trunk's files as they were. */
  landings: Map<string, Landing>;
}

/** Log order: by time, then by the order the script said it. */
function byTime(a: { t: number; order: number }, b: { t: number; order: number }): number {
  return a.t - b.t || a.order - b.order;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The next Crockford base32 string of the same length. */
function increment(id: string): string {
  const digits = id.split("");
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const value = CROCKFORD.indexOf(digits[i] ?? "0");
    if (value < 31) {
      digits[i] = CROCKFORD[value + 1] ?? "0";
      return digits.join("");
    }
    digits[i] = "0";
  }
  return digits.join("");
}

/** The project Keel's own agents belong to: the operators it enrols. */
export const PLATFORM_PROJECT = "prj_0SYSTEM0000000000000000000";

/** The entries of a change that an agent's own command commits. Keel names the agent on each, and its run. */
const COMMANDED: ReadonlySet<string> = new Set([
  "IntentDeclared",
  "IntentRevised",
  "ChangeSubmitted",
]);

export class ScriptBuilder {
  /** Who holds each change, by the change: the agent that declared it. */
  readonly #holders = new Map<string, string>();
  /** The run each agent's token names, for the agents whose token names one. */
  readonly #runs = new Map<string, RunRef>();
  readonly #epochMs: number;
  readonly #epoch: string;
  readonly #ids: Rng;
  readonly #eventIds: Rng;
  #now = 0;
  #order = 0;
  readonly #events: {
    t: number;
    order: number;
    event: ScriptedEvent;
    causation: AnyEvent | undefined;
  }[] = [];
  readonly #observations: { t: number; order: number; observation: Observation }[] = [];
  readonly #gates: Gate[] = [];
  readonly diffs = new Map<string, ChangeDiff>();
  readonly probes = new Map<string, ProbeSource>();
  readonly verdicts = new Map<string, VerdictView>();
  /** Set by a script whose story has a repository to browse. */
  repository: ScriptedRepository | undefined;
  /** The project the story is told in. Every event from here on is stamped with it, as Keel stamps its own. */
  project: string | undefined;

  /** The project's one lane, as Keel addresses it: `lane:<projectId>:main`. */
  get lane(): string {
    return `lane:${this.project ?? ""}:main`;
  }

  constructor(epoch: string, rng: Rng) {
    this.#epoch = epoch;
    this.#epochMs = Date.parse(epoch);
    this.#ids = rng.fork("entity-ids");
    this.#eventIds = rng.fork("event-ids");
  }

  /** The builder's clock, in ms from the epoch. */
  get now(): number {
    return this.#now;
  }

  /**
   * Added to every `at()`, in seconds. A script sets it negative to tell
   * history: things that happened before the story it is about to tell.
   */
  offset = 0;

  /** Move the clock to an absolute offset, in seconds from the epoch. */
  at(seconds: number): this {
    this.#now = Math.round((seconds + this.offset) * 1000);
    return this;
  }

  /** Move the clock forward, in seconds. */
  after(seconds: number): this {
    this.#now += Math.round(seconds * 1000);
    return this;
  }

  iso(t: number = this.#now): string {
    return new Date(this.#epochMs + t).toISOString();
  }

  /** The timestamp of a script second, honouring `offset`. */
  isoAt(seconds: number): string {
    return this.iso(Math.round((seconds + this.offset) * 1000));
  }

  /** An instant as Keel's payloads carry one: milliseconds since 1970. Defaults to the current instant. */
  instant(t: number = this.#now): number {
    return this.#epochMs + t;
  }

  /** The instant of a script second, honouring `offset`, as a payload carries it. */
  instantAt(seconds: number): number {
    return this.instant(Math.round((seconds + this.offset) * 1000));
  }

  /**
   * A verdict's evidence. The event that issues a verdict carries its lines, and Keel's read model serves each line
   * with the plan step it names and that step's class, and the plan the verdict was issued under: this records the
   * second, as Keel's `verdictReasons` reads it, and gives back the first.
   */
  reasons(
    verdictId: string,
    outcome: VerdictOutcome,
    lines: string[],
    plan?: VerdictPlan,
  ): string[] {
    this.verdicts.set(verdictId, {
      id: verdictId,
      outcome,
      reasons: lines.map((line) => reasonOf(line, plan?.steps ?? [])),
      issuedAt: this.iso(),
      ...(plan === undefined ? {} : { plan }),
    });
    return lines;
  }

  /** Mint an id at the current instant, e.g. `id("chg")`. */
  id(prefix: string): string {
    return `${prefix}_${ulidAt(this.#epochMs + this.#now, this.#ids)}`;
  }

  /**
   * The run an agent's token names from here on. One that signed itself up names a run in its token; one a
   * member enrolled exchanges a secret for a token that names none, and is given none here.
   */
  runOf(agentId: string, run: RunRef): this {
    this.#runs.set(agentId, run);
    return this;
  }

  /** Record one event at the current instant. Its id, `seq` and `at` are assigned when the log is built. */
  emit(input: EventInput): AnyEvent {
    const { causation, label, type, entity, payload } = input;
    if (input.type === "IntentDeclared")
      this.#holders.set(input.payload.changeId, input.payload.agentId);
    // What an agent's command commits is the agent's, as Keel writes it on the entry: who, and under which run.
    const holder =
      input.actor === undefined && COMMANDED.has(type) ? this.#holders.get(entity.id) : undefined;
    const actor = input.actor ?? (holder === undefined ? undefined : `agent:${holder}`);
    const run = input.run ?? (holder === undefined ? undefined : this.#runs.get(holder));
    const scripted = {
      type,
      entity,
      payload: {
        _tag: type,
        ...payload,
        ...(type === "IntentDeclared" && run !== undefined ? { run } : {}),
      },
      ...(label === undefined ? {} : { label }),
      ...(actor === undefined ? {} : { actor }),
      ...(run === undefined ? {} : { run }),
      ...(this.project === undefined ? {} : { project: this.project }),
      eventId: "",
      seq: 0,
      at: "",
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the input is checked per event type above; TypeScript cannot follow the tag through the spread
    const event = scripted as unknown as ScriptedEvent;
    this.#events.push({ t: this.#now, order: this.#order, event, causation });
    this.#order += 1;
    return event;
  }

  observe(input: ObservationInput): void {
    this.#observations.push({
      t: this.#now,
      order: this.#order,
      observation: { ...input, at: this.iso() },
    });
    this.#order += 1;
  }

  /** The story holds at the current instant until `escalationId` is ruled on. */
  gate(escalationId: string, options: string[], scripted: string): void {
    this.#gates.push({ escalationId, t: this.#now, options, scripted });
  }

  #lastEventMs = -1;
  #lastEventUlid = "";

  /** Event ids sort in log order, so two in one millisecond count upward, as a monotonic ULID does. */
  #nextEventUlid(t: number): string {
    const fresh = ulidAt(this.#epochMs + t, this.#eventIds);
    const next =
      t === this.#lastEventMs && fresh <= this.#lastEventUlid
        ? increment(this.#lastEventUlid)
        : fresh;
    this.#lastEventMs = t;
    this.#lastEventUlid = next;
    return next;
  }

  build(): GeneratedLog {
    const sorted = this.#events.toSorted(byTime);
    const seqs = new Map<string, number>();
    for (const entry of sorted) {
      const key = `${entry.event.entity.kind}:${entry.event.entity.id}`;
      const seq = (seqs.get(key) ?? 0) + 1;
      seqs.set(key, seq);
      entry.event.seq = seq;
      entry.event.at = this.iso(entry.t);
      entry.event.eventId = `evt_${this.#nextEventUlid(entry.t)}`;
    }
    // Causation is resolved last: every event has its id by now.
    for (const entry of sorted) {
      if (entry.causation !== undefined) entry.event.causation = entry.causation.eventId;
    }
    // The platform's own counters for the review funnel, read off the finished log.
    const counted = funnelFrames(sorted.map((entry) => entry.event)).map(
      ({ index, frame }, order) => {
        const t = sorted[index]?.t ?? 0;
        return {
          t,
          order: this.#order + order,
          observation: { kind: "funnel" as const, at: this.iso(t), ...frame },
        };
      },
    );
    const observations = [...this.#observations, ...counted].toSorted(byTime);
    const lastEvent = sorted.at(-1)?.t ?? 0;
    const lastObservation = observations.at(-1)?.t ?? 0;
    return {
      epoch: this.#epoch,
      events: sorted.map((entry) => entry.event),
      eventTimes: sorted.map((entry) => entry.t),
      observations: observations.map((entry) => entry.observation),
      observationTimes: observations.map((entry) => entry.t),
      gates: [...this.#gates],
      diffs: this.diffs,
      probes: this.probes,
      verdicts: this.verdicts,
      ...(this.repository === undefined ? {} : { repository: this.repository }),
      end: Math.max(lastEvent, lastObservation),
    };
  }
}
