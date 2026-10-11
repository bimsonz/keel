// Keel, as the page reaches it: through the console's own Worker, which holds
// the credentials the page never sees. Events are read from `/api/v1/events`
// by cursor, long-polling at the tail. A ruling goes to `/rule/<capability>`,
// where the capability names one question and is either the one this page was
// opened with (a phone that scanned a QR code) or one the Worker gives the
// presenter's console.
//
// What the API does not offer yet is absent here too, honestly: there are no
// observations, and diffs and probe sources are refused (QUESTIONS.md, B and
// D). The console's views show their empty states for those. A verdict's
// evidence is read from Keel's own view of the verdict.

import { readClaim } from "../capability.ts";
import { EVENT_TYPES } from "../contract/envelope.ts";
import type { AnyEvent } from "../contract/events.ts";
import type {
  EventPage,
  EventRecord,
  Inbox_listEventsInput,
  LatticeSet,
  RepoBlob,
  RepoCommitDiff,
  RepoCommitPage,
  RepoTree,
  Repo_getBlobInput,
  Repo_getTreeInput,
  Repo_listCommitsInput,
  RulingRequest,
  VerdictView,
} from "../contract/keel/index.ts";
import { type KeelRepository, RepoRefused } from "./repository.ts";
import type {
  ChangeDiff,
  KeelCommands,
  KeelEventSource,
  KeelResources,
  Page,
  ProbeSource,
  ReadRequest,
  RulingCommand,
  SourceDescriptor,
  VerdictReasons,
} from "./types.ts";

export interface HttpSourceOptions {
  /** Where the console's Worker is. The page's own origin, so nothing, unless a test says otherwise. */
  origin?: string;
  /** The presenter's key. With it this console may ask for a capability; without it, it only reads. */
  presenterKey?: string;
  /** A capability this page was opened with. */
  capability?: string;
  fetch?: typeof fetch;
}

/** Keel would not read its log to this reader: a visitor, where the log is an observer's to read. */
class LogClosed extends Error {}

/** The Worker would not have the key this console was opened with. */
export class KeyRefused extends Error {
  constructor() {
    super("That is not the presenter's key");
  }
}

/** A capability is asked for again once it has less than this long left, in seconds. */
const FRESH_FOR = 120;

export type HttpSource = KeelEventSource & KeelResources & KeelRepository & KeelCommands;

const KNOWN: ReadonlySet<string> = new Set(EVENT_TYPES);

/** What the console's Worker answers besides Keel's own bodies. */
interface Answer {
  capability?: unknown;
  expires?: unknown;
  reason?: unknown;
}

/** An entry of the log, as the console reads one. An event its catalogue does not know yet is left out, not guessed at. */
function toEvent(record: EventRecord): AnyEvent | null {
  if (!KNOWN.has(record.type)) return null;
  // Keel validates each payload against its catalogue, and `type` is the payload's own tag. Where the console
  // reads a field that is decided and not built yet (events.ts, `Ahead`), the field is simply not there.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a wire boundary: the type was checked by name above
  return record as unknown as AnyEvent;
}

/** A query string of what was given, by Keel's own names for an operation's inputs. */
const queryOf = (input: Record<string, string | number | undefined>): string => {
  const query = new URLSearchParams(
    Object.entries(input).flatMap(([name, value]) =>
      value === undefined || value === "" ? [] : [[name, String(value)]],
    ),
  ).toString();
  return query === "" ? "" : `?${query}`;
};

export async function createHttpSource(options: HttpSourceOptions): Promise<HttpSource> {
  const request = options.fetch ?? fetch;
  const origin = options.origin ?? "";
  const linked =
    options.capability === undefined
      ? null
      : { capability: options.capability, claim: readClaim(options.capability) };
  const minted = new Map<string, { capability: string; expires: number }>();
  /**
   * A read of Keel, through the Worker. The presenter's key rides on every one: it is what makes the Worker
   * read as an observer. Without it the Worker asks Keel with no token, as for any visitor.
   */
  const read = (path: string, signal?: AbortSignal): Promise<Response> =>
    request(`${origin}/api${path}`, {
      ...(options.presenterKey === undefined
        ? {}
        : { headers: { authorization: `Bearer ${options.presenterKey}` } }),
      ...(signal === undefined ? {} : { signal }),
    });

  /** A capability for one question: the one this page was opened with, or one asked of the Worker. */
  const capabilityFor = async (escalationId: string): Promise<string | null> => {
    if (linked?.claim?.escalationId === escalationId) return linked.capability;
    if (options.presenterKey === undefined) return null;
    const held = minted.get(escalationId);
    if (held !== undefined && held.expires - Date.now() / 1000 > FRESH_FOR) return held.capability;
    const response = await request(`${origin}/present/capability`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.presenterKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ escalationId }),
    });
    if (!response.ok) return null;
    const answer: Answer = await response.json();
    if (typeof answer.capability !== "string" || typeof answer.expires !== "number") return null;
    minted.set(escalationId, { capability: answer.capability, expires: answer.expires });
    return answer.capability;
  };

  /**
   * One of Keel's reads of a project's repository. Keel says why it refuses one by its own code: no such
   * project for this reader, no such ref, no such path.
   */
  const repo = async <Body>(
    projectId: string,
    rest: string,
    signal?: AbortSignal,
  ): Promise<Body> => {
    const response = await read(
      `/v1/projects/${encodeURIComponent(projectId)}/repo${rest}`,
      signal,
    );
    if (!response.ok) {
      const refusal: { code?: unknown } = await response.json().catch(() => ({}));
      throw new RepoRefused(typeof refusal.code === "string" ? refusal.code : "", response.status);
    }
    const body: Body = await response.json();
    return body;
  };

  const events = async (asked: ReadRequest): Promise<Page<AnyEvent>> => {
    // The operation's own input, by Keel's names for it.
    const input: Inbox_listEventsInput = {
      limit: Math.min(asked.limit ?? 500, 500),
      ...(asked.cursor === undefined || asked.cursor === "" ? {} : { cursor: asked.cursor }),
      ...((asked.waitSec ?? 0) > 0 ? { wait: Math.min(asked.waitSec ?? 0, 30) } : {}),
    };
    const query = new URLSearchParams(
      Object.entries(input).map(([name, value]) => [name, String(value)]),
    );
    const response = await read(`/v1/events?${query.toString()}`, asked.signal);
    // Keel reads its log to an observer. A 401 or a 403 is its answer to anyone else: to a visitor, that the
    // log is not theirs to read; to a console opened with a key, that the key is not the presenter's.
    if (response.status === 401 || response.status === 403) {
      if (options.presenterKey === undefined) throw new LogClosed();
      throw new KeyRefused();
    }
    if (!response.ok) throw new Error(`reading events failed: ${response.status}`);
    const page: Partial<EventPage> = await response.json();
    // Keel's page always says where to read next. A reader that carried on without that would start again from
    // the beginning, for ever, so a page that does not is refused.
    if (page.items === undefined || typeof page.nextCursor !== "string")
      throw new Error("reading events failed: the page has no cursor");
    return {
      items: page.items.flatMap((record) => toEvent(record) ?? []),
      nextCursor: page.nextCursor,
    };
  };

  // Simulated time is measured from the log's first event, so read one page to learn when that was. This is
  // also where a visitor learns the log is not theirs: the console stands all the same, with what Keel does
  // read to anyone.
  const first = await events({}).catch((error: unknown) => {
    if (error instanceof LogClosed) return null;
    throw error;
  });
  let firstPage: Page<AnyEvent> | null = first;
  const descriptor: SourceDescriptor = {
    mode: "live",
    log: first === null ? "closed" : "open",
    epoch: first?.items[0]?.at ?? new Date().toISOString(),
  };

  return {
    descriptor,
    readEvents(asked = {}) {
      if (first === null) return Promise.resolve({ items: [], nextCursor: asked.cursor ?? "" });
      if (firstPage !== null && asked.cursor === undefined) {
        const page = firstPage;
        firstPage = null;
        return Promise.resolve(page);
      }
      return events(asked);
    },
    readObservations: (asked = {}) =>
      Promise.resolve({ items: [], nextCursor: asked.cursor ?? "" }),
    getTree: (projectId, at, signal) =>
      repo<RepoTree>(
        projectId,
        `/tree${queryOf({ ...at } satisfies Omit<Repo_getTreeInput, "projectId">)}`,
        signal,
      ),
    getBlob: (projectId, at, signal) =>
      repo<RepoBlob>(
        projectId,
        `/blob${queryOf({ ...at } satisfies Omit<Repo_getBlobInput, "projectId">)}`,
        signal,
      ),
    getCommits: (projectId, asked, signal) =>
      repo<RepoCommitPage>(
        projectId,
        `/commits${queryOf({ ...asked } satisfies Omit<Repo_listCommitsInput, "projectId">)}`,
        signal,
      ),
    getCommit: (projectId, sha, signal) =>
      repo<RepoCommitDiff>(projectId, `/commits/${encodeURIComponent(sha)}`, signal),
    getDiff: (changeId: string): Promise<ChangeDiff> =>
      Promise.reject(new Error(`the API has no diff endpoint yet (${changeId})`)),
    getProbeSource: (probeId: string): Promise<ProbeSource> =>
      Promise.reject(new Error(`the API has no probe-source endpoint yet (${probeId})`)),
    async getLattices(signal?: AbortSignal): Promise<LatticeSet> {
      const response = await read("/v1/lattices", signal);
      if (!response.ok) throw new Error(`reading lattices failed: ${response.status}`);
      const lattices: LatticeSet = await response.json();
      return lattices;
    },
    async getVerdict(verdictId: string, signal?: AbortSignal): Promise<VerdictReasons> {
      const response = await read(`/v1/verdicts/${encodeURIComponent(verdictId)}`, signal);
      if (!response.ok) throw new Error(`reading verdict ${verdictId} failed: ${response.status}`);
      const view: VerdictView = await response.json();
      return view;
    },
    canRule: (escalationId: string): boolean =>
      options.presenterKey !== undefined || linked?.claim?.escalationId === escalationId,
    capabilityFor,
    async giveRuling(command: RulingCommand): Promise<void> {
      const capability = await capabilityFor(command.escalationId);
      if (capability === null) throw new Error("This console is read-only.");
      const response = await request(`${origin}/rule/${capability}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          option: command.option,
          ...(command.rationale === undefined ? {} : { rationale: command.rationale }),
        } satisfies RulingRequest),
      });
      if (response.ok) return;
      const refused: Answer = await response.json().catch(() => ({}));
      throw new Error(
        typeof refused.reason === "string" ? refused.reason : "The ruling was not taken.",
      );
    },
  };
}
