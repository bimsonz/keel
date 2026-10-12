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

export interface ProbeSource {
  probeId: string;
  path: string;
  source: string;
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
  getProbeSource(probeId: string, signal?: AbortSignal): Promise<ProbeSource>;
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
 * The one thing the console may change, so it is its own port. Keel decides who may: the reader's own session
 * is all the console sends. A ruling is never applied optimistically: its effect arrives through the log.
 */
export interface KeelCommands {
  giveRuling(command: RulingCommand): Promise<void>;
  /** Whether to offer this reader the ruling's buttons. Absent: the source decides some other way. */
  canRule?(escalationId: string): boolean;
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
