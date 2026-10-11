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

export interface SourceDescriptor {
  /** `live` is Keel. `fixture` is a scripted log, which exists only in development and in tests. */
  mode: "fixture" | "live";
  /**
   * Whether Keel reads its log to this reader. `closed` is a visitor on a Keel that reads its log to observers
   * only: there are no events, and there will be none however long the console waits.
   */
  log: "open" | "closed";
  scenario?: string;
  seed?: number;
  /** The log's first instant, ISO 8601. Simulated time is measured from here. */
  epoch: string;
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
 * The one thing the console may change. It needs different authority from
 * everything above (operator, not observer), so it is its own port. A ruling
 * is never applied optimistically: its effect arrives through the log.
 */
export interface KeelCommands {
  giveRuling(command: RulingCommand): Promise<void>;
  /** Whether this console may rule on a question. Absent: the source decides some other way. */
  canRule?(escalationId: string): boolean;
  /** A capability to rule on one question, to hand to a phone. Null when this console may not ask for one. */
  capabilityFor?(escalationId: string): Promise<string | null>;
}
