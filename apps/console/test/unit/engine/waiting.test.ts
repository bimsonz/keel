import { afterEach, describe, expect, it, vi } from "vitest";
import type { EscalationView } from "../../../src/contract/keel/index.ts";
import { TURNS, followTurns, waitingRows } from "../../../src/engine/waiting.ts";
import { KeelRefused, type Page, type ReadRequest } from "../../../src/source/types.ts";
import { SESSION_COOKIE, createFakeKeel } from "../../fixtures/mock/fakeKeel.ts";

/** The question as the stand-in Keel lists it to a maintainer: Keel's own shape for one. */
async function listedOne(): Promise<EscalationView> {
  const keel = createFakeKeel({ sessions: { maintainer: "maintainer" } });
  const answer = await keel.fetch(
    new Request("https://keel.example/v1/escalations?state=open", {
      headers: { cookie: `${SESSION_COOKIE}=maintainer` },
    }),
  );
  const page: { items: EscalationView[] } = await answer.json();
  const [one] = page.items;
  if (one === undefined) throw new Error("the stand-in listed no question");
  return one;
}

/**
 * A feed that answers from a script, a page a read, and is then Keel's tail with nothing new on it: a read is
 * held for as long as it asked to wait and answered with no entry and the cursor where it was.
 */
function scripted(pages: (Page<string> | Error)[]) {
  const asked: Omit<ReadRequest, "signal">[] = [];
  const readOwnFeed = ({ signal, ...request }: ReadRequest): Promise<Page<string>> => {
    asked.push(request);
    const next = pages.shift();
    if (next === undefined)
      return new Promise((resolve, reject) => {
        const held = setTimeout(
          () => resolve({ items: [], nextCursor: request.cursor ?? "0" }),
          (request.waitSec ?? 0) * 1000,
        );
        signal?.addEventListener("abort", () => {
          clearTimeout(held);
          reject(new Error("aborted"));
        });
      });
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { asked, readOwnFeed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the questions waiting for someone", () => {
  it("[waiting.rows] lists what Keel listed, in its order, each by Keel's label and its project's place, and nothing that is no longer open", async () => {
    const one = await listedOne();
    const rows = waitingRows([
      { ...one, id: "esc_b", label: "E-7", project: { ...one.project, namespace: "keel" } },
      { ...one, id: "esc_closed", state: "ruled" },
      one,
      { ...one, id: "esc_gone", state: "withdrawn" },
    ]);
    expect(rows.map((row) => `${row.namespace}/${row.project} ${row.label} ${row.id}`)).toEqual([
      `keel/demo E-7 esc_b`,
      `acme/demo E-1 ${one.id}`,
    ]);
    expect(rows[1]).toMatchObject({
      question: one.question,
      category: one.category,
      raisedAt: one.raisedAt,
    });
  });

  it("[waiting.follow] joins the reader's feed at its head in one read, and reads the list again when the feed then puts a question or closes one, and for nothing else", async () => {
    const feed = scripted([
      // The head: Keel answers no entry, and where its log ends now.
      { items: [], nextCursor: "2" },
      // The tail: an entry that is no question's, then one that closes a question.
      { items: ["ChangeDeclared"], nextCursor: "3" },
      { items: ["RulingGiven"], nextCursor: "4" },
    ]);
    const stop = new AbortController();
    const again = vi.fn<() => void>();
    const following = followTurns(feed, again, stop.signal);
    await vi.waitFor(() => expect(feed.asked).toHaveLength(4));
    // Once at the head, for whatever came since the list was read, and once for the ruling: not for the change.
    expect(again).toHaveBeenCalledTimes(2);
    // The first read asks for the head by Keel's own word, and waits for nothing: no entry from before is read.
    expect(feed.asked).toEqual([
      { cursor: "end" },
      { cursor: "2", waitSec: 25 },
      { cursor: "3", waitSec: 25 },
      { cursor: "4", waitSec: 25 },
    ]);
    stop.abort();
    await following;
    for (const turn of [
      "EscalationRaised",
      "EscalationWithdrawn",
      "RulingGiven",
      "ConflictResolved",
    ])
      expect(TURNS.has(turn)).toBe(true);
  });

  it("[waiting.no-clock] asks for nothing while Keel's log says nothing: no read is made by the clock", async () => {
    vi.useFakeTimers();
    const feed = scripted([
      { items: [], nextCursor: "0" },
      { items: [], nextCursor: "0" },
    ]);
    const stop = new AbortController();
    const again = vi.fn<() => void>();
    const following = followTurns(feed, again, stop.signal);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    // The end of the log, and then an hour of waits on the tail that each ran out with nothing new: the wait is
    // asked again, and the list is not.
    expect(again).toHaveBeenCalledTimes(1);
    expect(feed.asked.length).toBeGreaterThan(100);
    expect(feed.asked[0]).toEqual({ cursor: "end" });
    expect(feed.asked.slice(1).every((read) => read.waitSec === 25)).toBe(true);
    stop.abort();
    await following;
  });

  it("[waiting.refused] stops where Keel refuses the feed, and picks a dropped read up from where it was", async () => {
    const refusing = scripted([new KeelRefused("Sign in", "auth.required", 401)]);
    const never = vi.fn<() => void>();
    await followTurns(refusing, never, new AbortController().signal);
    expect(never).not.toHaveBeenCalled();
    expect(refusing.asked).toEqual([{ cursor: "end" }]);

    vi.useFakeTimers();
    const dropping = scripted([
      // The head is asked for again where that read dropped, and a wait where it did.
      new Error("the network dropped"),
      { items: [], nextCursor: "1" },
      new Error("the network dropped"),
      { items: [], nextCursor: "1" },
    ]);
    const stop = new AbortController();
    const again = vi.fn<() => void>();
    const following = followTurns(dropping, again, stop.signal);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(dropping.asked.slice(0, 4)).toEqual([
      { cursor: "end" },
      { cursor: "end" },
      { cursor: "1", waitSec: 25 },
      { cursor: "1", waitSec: 25 },
    ]);
    expect(again).toHaveBeenCalledTimes(1);
    stop.abort();
    await following;
  });
});
