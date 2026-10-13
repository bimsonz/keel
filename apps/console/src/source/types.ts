// The console's three ports onto Keel. Views never import a transport: they
// read projections built from whatever implements these.
//
// KeelEventSource is pull-only and shaped like `GET /v1/events`: a page of the
// log from a cursor, optionally waiting for the tail. Virtual time, pacing and
// seeking live above it, so the mock needs no timers and the real stream needs
// no changes to the views.

import type { AnyEvent } from "../contract/events.ts";
import type * as Keel from "../contract/keel/index.ts";
import type { Observation } from "../contract/observations.ts";
import type { EvidenceLine } from "../contract/provisional.ts";

/** An opaque position in a log. */
export type Cursor = string;

export interface ReadRequest {
  /** Omit to read from the beginning. */
  cursor?: Cursor;
  /** At most this many items. The real endpoint allows up to 500. */
  limit?: number;
  /** Long-poll: wait up to this many seconds for something new. 0 reads history only. */
  waitSec?: number;
  signal?: AbortSignal;
}

export interface Page<Item> {
  items: readonly Item[];
  /** Where to read from next: the position just after the last item returned. Always present, as Keel's page has it. */
  nextCursor: Cursor;
}

/**
 * Keel's projects, as it names them to whoever asks: its answer to `GET /v1/orgs/{org}/projects/{name}` and
 * each entry of `GET /v1/projects`, in Keel's own model. A reader with no session is named the public ones.
 */
export interface KeelDirectory {
  /**
   * The project an address names, or null where Keel shows this reader none of that name. A private project
   * and one that is not there are the same answer, and the console tells neither apart.
   */
  findProject(org: string, name: string, signal?: AbortSignal): Promise<Keel.ProjectView | null>;
  /** Every project Keel lists to this reader. */
  listProjects(signal?: AbortSignal): Promise<Keel.ProjectView[]>;
  /**
   * The open questions Keel lists to whoever is signed in, across every project it reads them, newest first:
   * one whose agent they sponsor, and one of a namespace they maintain once Keel puts it to its maintainers.
   * Keel refuses a reader with no session, so a visitor's page never asks.
   */
  listWaiting(signal?: AbortSignal): Promise<Keel.EscalationView[]>;
  /**
   * The next stretch of the reader's own feed, `GET /v1/events` with no project named: Keel's log across every
   * project it reads them. Only what kind each entry is, which is enough to know a question was put or closed.
   */
  readOwnFeed(asked: ReadRequest): Promise<Page<string>>;
}

export interface SourceDescriptor {
  /** `live` is Keel. `fixture` is a scripted log, which exists only in development and in tests. */
  mode: "fixture" | "live";
  scenario?: string;
  seed?: number;
  /**
   * The log's first instant, ISO 8601. Simulated time is measured from here. Absent where the log has not been
   * read yet: its first instant is then its first entry's.
   */
  epoch?: string;
  /** The one project this source reads, where Keel has said what it is. Its log holds that project's events alone. */
  project?: Keel.ProjectView;
}

export interface KeelEventSource {
  readonly descriptor: SourceDescriptor;
  readEvents(request?: ReadRequest): Promise<Page<AnyEvent>>;
  /** Timed facts that are not catalogue events. See contract/observations.ts. */
  readObservations(request?: ReadRequest): Promise<Page<Observation>>;
}

export interface ChangeDiff {
  changeId: string;
  commit: string;
  files: { path: string; before: string | null; after: string | null }[];
  /** Code tied to subjects: where a proposition is anchored. */
  anchors: {
    path: string;
    symbol?: string;
    line: number;
    side: "additions" | "deletions";
    subjectKey: string;
  }[];
}

/**
 * A verdict as Keel's read model gives it (`GET /v1/verdicts/{id}`): the event that issued it carries only
 * references to its evidence, and this carries the evidence itself.
 */
export interface VerdictReasons extends Omit<Keel.VerdictView, "reasons"> {
  reasons: EvidenceLine[];
}

/** Things the console fetches on demand rather than folds from the log. */
export interface KeelResources {
  getDiff(changeId: string, signal?: AbortSignal): Promise<ChangeDiff>;
  /** A probe's source, file by file, as its bundle holds it (`GET /v1/probes/{probeId}/source`). */
  getProbeSource(probeId: string, signal?: AbortSignal): Promise<Keel.ProbeSource>;
  getVerdict(verdictId: string, signal?: AbortSignal): Promise<VerdictReasons>;
  /** Every predicate's lattice, as Keel's domain has it (`GET /v1/lattices`). */
  getLattices(signal?: AbortSignal): Promise<Keel.LatticeSet>;
}

export interface RulingCommand {
  escalationId: string;
  /** The id of the option chosen. */
  option: string;
  rationale?: string;
  idempotencyKey: string;
}

/**
 * A project's settings as Keel holds them, and replacing them. Keel reads them to a member of the project's
 * org and lets a maintainer or an owner replace them; whoever else asks is given its refusal. Keel replaces
 * the settings whole, so what is sent is everything it answered with what the reader changed.
 */
export interface KeelSettings {
  getSettings(signal?: AbortSignal): Promise<Keel.ProjectSettings>;
  /** Answers with the settings as Keel then holds them. */
  putSettings(settings: Keel.ProjectSettings): Promise<Keel.ProjectSettings>;
}

/**
 * What the console may change in a project's log, so it is its own port. Keel decides who may: the reader's own session
 * is all the console sends. A ruling is never applied optimistically: its effect arrives through the log.
 */
export interface KeelCommands {
  giveRuling(command: RulingCommand): Promise<void>;
  /** Whether to offer this reader the ruling's buttons. Absent: the source decides some other way. */
  canRule?(escalationId: string): boolean;
  /**
   * Asks Keel which open questions it lists to this reader, where `canRule` waits on that: Keel takes a ruling
   * from the person a question was put to first, whatever their role. Absent where nothing is to be asked.
   */
  readAsked?(signal?: AbortSignal): Promise<void>;
}

/** Keel refused something, and said why. `next` is the ways forward it gave, each by its title. */
export class KeelRefused extends Error {
  readonly code: string;
  readonly status: number;
  readonly next: readonly string[];
  constructor(said: string, code: string, status: number, next: readonly string[] = []) {
    super(said);
    this.name = "KeelRefused";
    this.code = code;
    this.status = status;
    this.next = next;
  }
}
