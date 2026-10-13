import { createHash } from "node:crypto";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  Actor,
  agentActor,
  byAgent,
  canBlock,
  canonicalJson,
  CommandActor,
  contentHashOf,
  EventEnvelope,
  EvidenceClass,
  globsMayOverlap,
  Instant,
  type Json,
  makeId,
  matchesGlob,
  RunRef,
  sha256Hex,
  sha256HexOfBytes,
  userActor,
  weakest,
} from "../../../src/domain/kernel/index.ts";
import { eventActorOf } from "../../../src/domain/identity/index.ts";
import { fc } from "../../support/fast-check.ts";

const reference = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

describe("sha256", () => {
  it("[kernel.sha256-fips-vectors] matches the FIPS 180-4 examples", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("[kernel.sha256-matches-reference] agrees with node:crypto on any string, lone surrogates included", () => {
    const codeUnit = fc.integer({ min: 0, max: 0xffff }).map((n) => String.fromCharCode(n));
    const text = fc.oneof(
      fc.string({ unit: codeUnit, maxLength: 200 }),
      fc.string({ unit: "grapheme", maxLength: 200 }),
    );
    fc.assert(
      fc.property(text, (s) => {
        expect(sha256Hex(s)).toBe(reference(s));
      }),
    );
  });

  it("[kernel.sha256-bytes] hashes bytes as they are, not as text, across every padding length", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(sha256HexOfBytes(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
      }),
    );
    expect(sha256HexOfBytes(Uint8Array.of(0xff, 0xfe))).toBe(
      createHash("sha256").update(Uint8Array.of(0xff, 0xfe)).digest("hex"),
    );
  });
});

/** Rebuilds every object with its keys in a pseudo-random order. */
const shuffle = (value: Json, rand: () => number): Json => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v: Json) => shuffle(v, rand));
  const entries = Object.entries(value)
    .map(([k, v]) => [k, shuffle(v, rand), rand()] as const)
    .toSorted((x, y) => x[2] - y[2])
    .map(([k, v]) => [k, v] as const);
  return Object.fromEntries(entries);
};

const jsonValue: fc.Arbitrary<Json> = fc.letrec<{ json: Json }>((tie) => ({
  json: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string(),
    fc.array(tie("json"), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie("json"), { maxKeys: 4 }),
  ),
})).json;

describe("canonical JSON", () => {
  it("[kernel.canonical-json-rfc8785] produces the RFC 8785 (JCS) example output", () => {
    // The RFC's input text, parsed as JSON, so its number literals reach the encoder as written.
    const rfcInput = String.raw`{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/", "literals": [null, true, false]}`;
    const input: Json = JSON.parse(rfcInput);
    expect(canonicalJson(input)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
    expect(contentHashOf(input)).toBe(`sha256:${reference(canonicalJson(input))}`);
  });

  it("[kernel.canonical-json-key-order] is independent of key insertion order and loses nothing", () => {
    fc.assert(
      fc.property(jsonValue, fc.integer(), (json, seed) => {
        let state = seed;
        const rand = (): number => {
          state = (state * 1103515245 + 12345) & 0x7fffffff;
          return state / 0x7fffffff;
        };
        expect(canonicalJson(shuffle(json, rand))).toBe(canonicalJson(json));
        expect(JSON.parse(canonicalJson(json))).toEqual(JSON.parse(JSON.stringify(json)));
      }),
    );
  });
});

// An independent oracle: the glob as a regular expression over `path + "/"`.
const segmentRegex = (segment: string): string =>
  segment
    .split("")
    .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");

const oracle = (glob: string, p: string): boolean => {
  const body = glob
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (s === "**" ? "(?:[^/]+/)*" : `${segmentRegex(s)}/`))
    .join("");
  return new RegExp(`^${body}$`).test(`${p}/`);
};

describe("globs", () => {
  const segment = fc.constantFrom("a", "b", "ab", "ba");
  const path = fc.array(segment, { minLength: 1, maxLength: 3 }).map((s) => s.join("/"));
  const patternSegment = fc.constantFrom("a", "b", "ab", "*", "?", "a*", "*b", "**");
  const pattern = fc.array(patternSegment, { minLength: 1, maxLength: 3 }).map((s) => s.join("/"));
  const allPaths = (() => {
    const segs = ["a", "b", "ab", "ba"];
    const out: string[] = [];
    const walk = (prefix: string[]): void => {
      if (prefix.length > 0) out.push(prefix.join("/"));
      if (prefix.length < 3) for (const s of segs) walk([...prefix, s]);
    };
    walk([]);
    return out;
  })();

  it("[kernel.glob-matches-oracle] agrees with a regular-expression oracle", () => {
    fc.assert(
      fc.property(pattern, path, (g, p) => {
        expect(matchesGlob(g, p)).toBe(oracle(g, p));
      }),
    );
  });

  it("[kernel.glob-overlap-sound] never says two globs are disjoint when some path matches both", () => {
    let overlapping = 0;
    fc.assert(
      fc.property(pattern, pattern, (a, b) => {
        const witness = allPaths.find((p) => matchesGlob(a, p) && matchesGlob(b, p));
        if (witness !== undefined) overlapping++;
        return witness === undefined || globsMayOverlap(a, b);
      }),
    );
    expect(overlapping).toBeGreaterThan(0);
  });
});

const evidenceClasses = EvidenceClass.literals;
const rank = (c: EvidenceClass): number => ["opinion", "testimony", "ruling", "proof"].indexOf(c);

describe("evidence classes", () => {
  const cls = fc.constantFrom(...evidenceClasses);

  it("[kernel.evidence-weakest-is-meet] weakest is the lighter of the two, commutative and idempotent", () => {
    fc.assert(
      fc.property(cls, cls, (a, b) => {
        const w = weakest(a, b);
        expect(rank(w)).toBe(Math.min(rank(a), rank(b)));
        expect(weakest(b, a)).toBe(w);
        expect(weakest(a, a)).toBe(a);
      }),
    );
  });

  it("[kernel.only-proof-or-ruling-decide] only proof and rulings can block or clear", () => {
    expect(evidenceClasses.filter(canBlock).toSorted()).toEqual(["proof", "ruling"]);
  });
});

const ulid = (n: number): string => String(n).padStart(26, "0");
/** Any ULID: 26 characters of Crockford's alphabet. */
const ulidArb = fc.string({
  unit: fc.constantFrom(..."0123456789ABCDEFGHJKMNPQRSTVWXYZ".split("")),
  minLength: 26,
  maxLength: 26,
});
const isActor = Schema.is(Actor);
const isWritten = Schema.is(CommandActor);

/** The actor an envelope carries once it has been encoded, sent as JSON and decoded. */
const actorThroughTheWire = (actor: Actor): unknown => {
  const sent = Schema.encodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulid(4)),
    type: "ChangeWithdrawn",
    entity: { kind: "change", id: makeId("chg", ulid(3)) },
    seq: 1,
    at: Instant(1_760_000_000_000),
    dedupeKey: "withdraw#1",
    actor,
    affected: [],
    notified: [],
    payload: {},
  });
  return Schema.decodeUnknownSync(EventEnvelope)(JSON.parse(JSON.stringify(sent))).actor;
};

/**
 * The actor of an envelope stored long ago once it has been read, encoded
 * again and stored again, as a feed rebuilt over old events does, then read.
 */
const storedAgain = (actor: string): unknown => {
  const stored = {
    eventId: makeId("evt", ulid(4)),
    type: "AgentSuspended",
    entity: { kind: "agent", id: makeId("agt", ulid(3)) },
    seq: 1,
    at: 1_760_000_000_000,
    dedupeKey: "suspend#1",
    actor,
    affected: [],
    notified: [],
    payload: {},
  };
  const read = Schema.decodeUnknownSync(EventEnvelope)(JSON.parse(JSON.stringify(stored)));
  const again = JSON.stringify(Schema.encodeSync(EventEnvelope)(read));
  return Schema.decodeUnknownSync(EventEnvelope)(JSON.parse(again)).actor;
};

describe("an event's actor", () => {
  it("[kernel.actor-shape] names an agent or a user by its id, still reads an operator by name, and is nothing else", () => {
    const agent = makeId("agt", ulid(1));
    const user = makeId("usr", ulid(1));
    expect(agentActor(agent)).toBe("agent:agt_00000000000000000000000001");
    expect(userActor(user)).toBe("user:usr_00000000000000000000000001");

    // An id with letters in it, so that its lower-case spelling is another string.
    const lettered = makeId("usr", "01JZ8PT2C4E6G8J0M2N4Q6S8V0");
    const lawful = [
      `agent:${agent}`,
      `user:${user}`,
      `user:${lettered}`,
      "operator:ops",
      `operator:${agent}`,
    ];
    expect(lawful.filter((actor) => !isActor(actor))).toEqual([]);

    const unlawful = [
      "user:",
      "user:ada",
      `user:${agent}`,
      `user:${lettered.toLowerCase()}`,
      `user:${user}0`,
      `user: ${user}`,
      `User:${user}`,
      "agent:",
      `agent:${user}`,
      agent,
      user,
      `org:${makeId("org", ulid(1))}`,
      "operator:",
      "",
    ];
    expect(unlawful.filter((actor) => isActor(actor))).toEqual([]);

    fc.assert(
      fc.property(ulidArb, ulidArb, (a, u) => {
        const anAgent = agentActor(makeId("agt", a));
        const aUser = userActor(makeId("usr", u));
        return (
          isActor(anAgent) &&
          isActor(aUser) &&
          anAgent !== aUser &&
          actorThroughTheWire(anAgent) === anAgent &&
          actorThroughTheWire(aUser) === aUser
        );
      }),
    );
  });

  it("[actor.written-forms] a command is by an agent or a user, each by its id, and never by an operator's name", () => {
    const agent = makeId("agt", ulid(1));
    const user = makeId("usr", ulid(1));
    expect([`agent:${agent}`, `user:${user}`].filter((actor) => !isWritten(actor))).toEqual([]);

    const unwritten = [
      "operator:ops",
      `operator:${agent}`,
      `operator:${user}`,
      agent,
      user,
      `agent:${user}`,
      `user:${agent}`,
      "agent:",
      "user:",
      "",
    ];
    expect(unwritten.filter((actor) => isWritten(actor))).toEqual([]);

    // Whatever names an actor for a command names one of the two.
    fc.assert(
      fc.property(ulidArb, ulidArb, fc.string({ minLength: 1 }), (a, u, name) => {
        const agentId = makeId("agt", a);
        const userId = makeId("usr", u);
        return (
          isWritten(agentActor(agentId)) &&
          isWritten(userActor(userId)) &&
          isWritten(byAgent(agentId, undefined).actor) &&
          isWritten(eventActorOf({ _tag: "Agent", agentId })) &&
          isWritten(eventActorOf({ _tag: "User", userId })) &&
          !isWritten(`operator:${name}`)
        );
      }),
    );
  });

  it("[actor.operator-still-read] an operator's name on a stored event is read, and written back as it was", () => {
    expect(isActor("operator:")).toBe(false);
    fc.assert(
      fc.property(ulidArb, ulidArb, fc.string({ minLength: 1 }), (a, u, name) => {
        const stored = `operator:${name}`;
        const read = Schema.decodeUnknownSync(Actor)(stored);
        return (
          read === stored &&
          Schema.encodeSync(Actor)(read) === stored &&
          storedAgain(stored) === stored &&
          // What is written is read too.
          isActor(agentActor(makeId("agt", a))) &&
          isActor(userActor(makeId("usr", u)))
        );
      }),
    );
  });
});

/** Whether an envelope naming `run` decodes, and the run it then carries, once sent as JSON. */
const runThroughTheWire = (run: unknown): { readonly decoded: boolean; readonly run?: unknown } => {
  const sent = {
    eventId: makeId("evt", ulid(4)),
    type: "IntentDeclared",
    entity: { kind: "change", id: makeId("chg", ulid(3)) },
    seq: 1,
    at: 1_760_000_000_000,
    dedupeKey: "declare#1",
    actor: agentActor(makeId("agt", ulid(1))),
    ...(run === undefined ? {} : { run }),
    affected: [],
    notified: [],
    payload: {},
  };
  const read = Schema.decodeUnknownResult(EventEnvelope)(JSON.parse(JSON.stringify(sent)));
  if (read._tag === "Failure") return { decoded: false };
  const again = Schema.decodeUnknownSync(EventEnvelope)(
    JSON.parse(JSON.stringify(Schema.encodeSync(EventEnvelope)(read.success))),
  );
  return { decoded: true, ...(again.run === undefined ? {} : { run: again.run }) };
};

describe("an event's run", () => {
  it("[kernel.envelope-run] an envelope names a run only by its id with an optional label, the run survives the wire, and byAgent names it exactly when it is given one", () => {
    const agent = makeId("agt", ulid(1));
    const id = makeId("run", ulid(7));
    const bare = { id };
    const labelled = { id, label: "nightly.build-2" };
    expect(runThroughTheWire(undefined)).toEqual({ decoded: true });
    expect(runThroughTheWire(bare)).toEqual({ decoded: true, run: bare });
    expect(runThroughTheWire(labelled)).toEqual({ decoded: true, run: labelled });

    const unlawful: readonly unknown[] = [
      id,
      "nightly.build-2",
      7,
      [],
      {},
      { label: "nightly.build-2" },
      { id: "nightly" },
      { id: agent },
      { id, label: "" },
      { id, label: "Nightly Build" },
      { id, label: "-nightly" },
      { id, label: "n".repeat(65) },
    ];
    expect(unlawful.filter((run) => runThroughTheWire(run).decoded)).toEqual([]);

    const run = Schema.decodeUnknownSync(RunRef)(labelled);
    expect(byAgent(agent, run)).toEqual({ actor: `agent:${agent}`, run: labelled });
    const alone = byAgent(agent, undefined);
    expect(alone).toEqual({ actor: `agent:${agent}` });
    // No key at all for a token that named no run: an absent run is absent, never a run of `undefined`.
    expect(Object.keys(alone)).toEqual(["actor"]);
  });
});
