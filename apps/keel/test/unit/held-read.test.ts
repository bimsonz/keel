import { describe, expect, it } from "@effect/vitest";
import { AgentNotKnown } from "@keeltown/core/domain/identity";
import { AgentId } from "@keeltown/core/kernel";
import { NotImplemented } from "@keeltown/core/not-implemented";
import { EventFeed, Inbox } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Schema } from "effect";
import { afterEach, vi } from "vitest";
import { callHeldRead } from "../../src/adapters/driven/do-rpc/answer.ts";
import { EventFeedRpc } from "../../src/adapters/driven/do-rpc/event-feed.ts";
import { InboxRpc } from "../../src/adapters/driven/do-rpc/inbox.ts";
import { AgentSessionCodecs, encodeExit, exitCodec, ProjectorCodecs } from "../../src/rpc/index.ts";

const agentId = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const codec = exitCodec(Schema.String, AgentNotKnown);
const WAIT_MS = 20_000;

/** What a held call is rejected with when its object restarts under it. */
const restarted = () =>
  Object.assign(new Error("Durable Object reset because its code was updated."), {
    durableObjectReset: true,
  });

/** An object that answers each call in turn and keeps how long each was asked to wait. */
function object(...answers: readonly (() => Promise<unknown>)[]) {
  const waits: number[] = [];
  const call = (waitMs: number): Promise<unknown> => {
    const answer = answers[waits.length];
    waits.push(waitMs);
    return answer === undefined
      ? Promise.reject(new Error("the object was called more often than the case allows"))
      : answer();
  };
  return { waits, call };
}
const answers = (exit: Exit.Exit<string, AgentNotKnown>) => () =>
  Promise.resolve(encodeExit(codec, exit));
const rejects = (reason: Error) => () => Promise.reject(reason);
const defectOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? Cause.squash(exit.cause) : undefined;
/** What was logged as read again, one entry a healed read. */
const logged = () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return () => warn.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a read an object holds", () => {
  it.effect(
    "[rpc.held-read] is read once more with no wait when its object restarts under it, and that answer is served and logged",
    () => {
      const warned = logged();
      const o = object(rejects(restarted()), answers(Exit.succeed("the page as it stands")));
      return Effect.gen(function* () {
        expect(yield* callHeldRead(codec, "feed", WAIT_MS, o.call)).toBe("the page as it stands");
        expect(o.waits).toEqual([WAIT_MS, 0]);
        expect(warned()).toEqual([
          {
            ops: "held-read",
            read: "feed",
            readAgain: "Durable Object reset because its code was updated.",
          },
        ]);
      });
    },
  );

  it.effect("[rpc.held-read] is read again the same way when the object itself died in it", () => {
    logged();
    const o = object(
      answers(Exit.die(new Error("stopped at storage"))),
      answers(Exit.succeed("the page as it stands")),
    );
    return Effect.gen(function* () {
      expect(yield* callHeldRead(codec, "feed", WAIT_MS, o.call)).toBe("the page as it stands");
      expect(o.waits).toEqual([WAIT_MS, 0]);
    });
  });

  it.effect(
    "[rpc.held-read] stays a defect when the second read fails too, and is the second's",
    () => {
      logged();
      const o = object(rejects(restarted()), rejects(new Error("still not there")));
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(callHeldRead(codec, "feed", WAIT_MS, o.call));
        expect(defectOf(exit)).toMatchObject({ message: "still not there" });
        expect(o.waits).toEqual([WAIT_MS, 0]);
      });
    },
  );

  it.effect("[rpc.held-read] does not ask an overloaded object again", () => {
    const warned = logged();
    const busy = Object.assign(new Error("Durable Object is overloaded."), { overloaded: true });
    const o = object(rejects(busy));
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(callHeldRead(codec, "feed", WAIT_MS, o.call));
      expect(defectOf(exit)).toBe(busy);
      expect(o.waits).toEqual([WAIT_MS]);
      expect(warned()).toEqual([]);
    });
  });

  it.effect("[rpc.held-read] does not ask again for a method that is not built yet", () => {
    logged();
    const o = object(answers(Exit.die(new NotImplemented("identity/readInbox"))));
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(callHeldRead(codec, "inbox", WAIT_MS, o.call));
      expect(defectOf(exit)).toBeInstanceOf(NotImplemented);
      expect(o.waits).toEqual([WAIT_MS]);
    });
  });

  it.effect("[rpc.held-read] takes a refusal as the read's answer: it is not read again", () => {
    const warned = logged();
    const o = object(answers(Exit.fail(new AgentNotKnown({ agentId }))));
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(callHeldRead(codec, "inbox", WAIT_MS, o.call));
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
      expect(o.waits).toEqual([WAIT_MS]);
      expect(warned()).toEqual([]);
    });
  });

  it.effect("[rpc.held-read] calls a read that answers once, with its wait", () => {
    const o = object(answers(Exit.succeed("a page")));
    return Effect.gen(function* () {
      expect(yield* callHeldRead(codec, "feed", WAIT_MS, o.call)).toBe("a page");
      expect(o.waits).toEqual([WAIT_MS]);
    });
  });
});

describe("the reads the objects hold", () => {
  it.effect(
    "[rpc.held-feed] a feed read whose Projector restarts under it is read again from the same cursor, limit and project with no wait",
    () => {
      logged();
      const sent: unknown[] = [];
      const page = { events: [], cursor: "000000000007" };
      const projector = () => ({
        read: (request: unknown) => {
          sent.push(request);
          return sent.length === 1
            ? Promise.reject(restarted())
            : Promise.resolve(encodeExit(ProjectorCodecs.read, Exit.succeed(page)));
        },
      });
      return Effect.gen(function* () {
        const read = { cursor: "000000000007", limit: 500, waitSeconds: 20 };
        expect(yield* (yield* EventFeed).read(read)).toEqual(page);
        expect(sent).toEqual([
          { cursor: "000000000007", limit: 500, waitMs: 20_000 },
          { cursor: "000000000007", limit: 500, waitMs: 0 },
        ]);
      }).pipe(Effect.provide(EventFeedRpc(projector)));
    },
  );

  it.effect(
    "[rpc.held-inbox] an inbox read whose AgentSession restarts under it is read again from the same cursor with no wait",
    () => {
      logged();
      const sent: unknown[] = [];
      const page = { notices: [], cursor: "42" };
      const agentSession = () => ({
        inbox: (request: unknown) => {
          sent.push(request);
          return sent.length === 1
            ? Promise.reject(restarted())
            : Promise.resolve(encodeExit(AgentSessionCodecs.inbox, Exit.succeed(page)));
        },
      });
      return Effect.gen(function* () {
        expect(yield* (yield* Inbox).read(agentId, "42", 20)).toEqual(page);
        expect(sent).toEqual([
          { cursor: "42", waitMs: 20_000 },
          { cursor: "42", waitMs: 0 },
        ]);
      }).pipe(Effect.provide(InboxRpc(agentSession)));
    },
  );
});
