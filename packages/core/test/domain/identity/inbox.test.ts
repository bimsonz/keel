import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InboxEntry, noticeOf, notifies } from "../../../src/domain/identity/index.ts";
import {
  agentActor,
  type EventEnvelope,
  Instant,
  makeId,
  type NextAction,
  userActor,
} from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const AGENT = makeId("agt", ulid(1));
const OTHER = makeId("agt", ulid(2));
/** A user whose id has the agent's own ULID: an event they cause is not the agent's own. */
const USER = makeId("usr", ulid(1));
const CHANGE = makeId("chg", ulid(3));

const envelope = (payload: object, actor?: EventEnvelope["actor"]): EventEnvelope => ({
  eventId: makeId("evt", ulid(4)),
  type: String(Reflect.get(payload, "_tag")),
  entity: { kind: "change", id: CHANGE },
  seq: 1,
  at: Instant(1_760_000_000_000),
  dedupeKey: `change:${CHANGE}/note#1`,
  ...(actor === undefined ? {} : { actor }),
  affected: [],
  notified: [],
  payload,
});

const noted = (policy: "advise" | "annotate") => ({
  _tag: "ConflictNoted",
  changeId: CHANGE,
  conflictId: makeId("cfl", ulid(5)),
  predicate: "freshness",
  policy,
});

const POSITION = "000000000007";
const bare: InboxEntry = {
  eventId: makeId("evt", ulid(4)),
  type: "AlternativeDeclared",
  entity: { kind: "change", id: CHANGE },
  seq: 3,
  at: Instant(1_760_000_000_000),
};

const nextActionArb: fc.Arbitrary<NextAction> = fc
  .record({
    kind: fc.constantFrom("call" as const, "wait" as const, "read" as const, "escalate" as const),
    title: fc.constantFrom("Read the other change", "Rebase your change", "Withdraw your change"),
    operationId: fc.option(fc.constantFrom("change", "rebase", "abandon"), {
      nil: undefined,
    }),
    args: fc.option(fc.constant({ changeId: CHANGE }), { nil: undefined }),
  })
  .map(({ kind, title, operationId, args }) => ({
    kind,
    title,
    ...(operationId === undefined ? {} : { operationId }),
    ...(args === undefined ? {} : { args }),
  }));

/** An inbox entry with or without a detail and next actions. */
const entryArb: fc.Arbitrary<InboxEntry> = fc
  .record({
    detail: fc.option(fc.constantFrom("chg_2 declares the same effects", "it landed first"), {
      nil: undefined,
    }),
    nextActions: fc.option(fc.array(nextActionArb, { maxLength: 4 }), { nil: undefined }),
  })
  .map(({ detail, nextActions }) => ({
    ...bare,
    ...(detail === undefined ? {} : { detail }),
    ...(nextActions === undefined ? {} : { nextActions }),
  }));

const stored = (entry: InboxEntry): InboxEntry =>
  Schema.decodeUnknownSync(InboxEntry)(
    JSON.parse(JSON.stringify(Schema.encodeSync(InboxEntry)(entry))),
  );

describe("the inbox", () => {
  it("[inbox.notice-next-actions] a notice carries its entry's next actions unchanged and in order, and none when the entry has none; they survive the entry being stored and read back", () => {
    fc.assert(
      fc.property(entryArb, (entry) => {
        const notice = noticeOf(entry, POSITION);
        const expected = (entry.nextActions ?? []).length === 0 ? undefined : entry.nextActions;
        return (
          JSON.stringify(notice.nextActions) === JSON.stringify(expected) &&
          "nextActions" in notice === (expected !== undefined) &&
          JSON.stringify(noticeOf(stored(entry), POSITION)) === JSON.stringify(notice)
        );
      }),
    );
    const actions: NextAction[] = [
      { kind: "read", title: "Read the other change", operationId: "change" },
      {
        kind: "call",
        title: "Rebase your change",
        operationId: "rebase",
        args: { changeId: CHANGE },
      },
      { kind: "call", title: "Withdraw your change", operationId: "abandon" },
    ];
    expect(noticeOf({ ...bare, nextActions: actions }, POSITION).nextActions).toEqual(actions);
    expect(noticeOf(stored({ ...bare, nextActions: actions }), POSITION).nextActions).toEqual(
      actions,
    );
    expect(noticeOf(bare, POSITION)).not.toHaveProperty("nextActions");
    expect(noticeOf({ ...bare, nextActions: [] }, POSITION)).not.toHaveProperty("nextActions");
  });

  it("[inbox.notice-detail] a notice carries its entry's detail unchanged and none when the entry has none; the rest of the notice is the same with or without detail and next actions", () => {
    const plain = noticeOf(bare, POSITION);
    fc.assert(
      fc.property(entryArb, (entry) => {
        const { detail, nextActions: _nextActions, ...rest } = noticeOf(entry, POSITION);
        return (
          detail === entry.detail &&
          "detail" in noticeOf(entry, POSITION) === (entry.detail !== undefined) &&
          JSON.stringify(rest) === JSON.stringify(plain)
        );
      }),
    );
    expect(plain).toEqual({
      id: bare.eventId,
      at: bare.at,
      kind: "AlternativeDeclared",
      title: `Alternative declared: ${CHANGE}`,
      ref: `change:${CHANGE}`,
      cursor: POSITION,
    });
    expect(noticeOf({ ...bare, detail: "it landed first" }, POSITION)).toEqual({
      ...plain,
      detail: "it landed first",
    });
  });

  it("[inbox.annotate-silent] a conflict noted under annotate notifies no one; under advise it notifies as any event does, never the agent that caused it", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("advise" as const, "annotate" as const),
        fc.constantFrom(undefined, agentActor(AGENT), agentActor(OTHER), userActor(USER)),
        (policy, actor) =>
          notifies(AGENT, envelope(noted(policy), actor)) ===
          (policy === "advise" && actor !== agentActor(AGENT)),
      ),
    );
    expect(notifies(AGENT, envelope(noted("annotate")))).toBe(false);
    expect(notifies(AGENT, envelope(noted("advise")))).toBe(true);
    // Only a ConflictNoted is silenced: another event with the same field still notifies.
    expect(notifies(AGENT, envelope({ _tag: "ChangeBounced", policy: "annotate" }))).toBe(true);
  });
});
