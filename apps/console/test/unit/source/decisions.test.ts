import { describe, expect, it } from "vitest";
import type { AnyEvent } from "../../../src/contract/events.ts";
import type { DecisionView } from "../../../src/contract/keel/index.ts";
import {
  decisionDetailOf,
  decisionRowsOf,
  readDecisions,
  standingOf,
  turnsOf,
} from "../../../src/engine/decisions.ts";
import { decisionNamed, namesIn } from "../../../src/engine/lists.ts";
import { Player } from "../../../src/engine/player.ts";
import { changePageOf } from "../../../src/engine/select.ts";
import { World } from "../../../src/engine/world.ts";
import { createHttpDirectory, createHttpSource } from "../../../src/source/http.ts";
import { type KeelDecisions, KeelRefused } from "../../../src/source/types.ts";
import { SESSION_COOKIE, createFakeKeel } from "../../fixtures/mock/fakeKeel.ts";
import { S1_CHOICES } from "../../fixtures/mock/s1.ts";
import { S2_DECIDED } from "../../fixtures/mock/s2.ts";

const ORIGIN = "https://keel.example";
type Who = "owner" | "member" | "stranger" | "visitor";
type Keel = ReturnType<typeof createFakeKeel>;

/** The browser's part for one reader: its session's cookie on what the page asked, and the page's own request kept apart. */
function as(keel: Keel, who: Who) {
  const fromThePage: Request[] = [];
  const serve: typeof fetch = (input, init) => {
    const address =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const asked = new Request(new URL(address, ORIGIN), init);
    fromThePage.push(asked.clone());
    const headers = new Headers(asked.headers);
    if (who !== "visitor") headers.set("cookie", `${SESSION_COOKIE}=${who}`);
    if (asked.method !== "GET") headers.set("origin", ORIGIN);
    return keel.fetch(new Request(asked, { headers }));
  };
  return { serve, fromThePage };
}

/** The stand-in Keel holding a story's log, and the project's source as `who` reads it. */
async function opened(
  who: Who,
  visibility: "public" | "private" = "private",
  story: "s1" | "s2" = "s2",
) {
  const keel = createFakeKeel({
    story,
    visibility,
    sessions: { owner: "owner", member: "member", stranger: "stranger" },
  });
  // The project's own id, which a reader Keel shows no project never learns: taken as its owner reads it.
  const project = await createHttpDirectory({ fetch: as(keel, "owner").serve }).findProject(
    "acme",
    "demo",
  );
  if (project === null) throw new Error("the stand-in Keel has no project");
  const { serve, fromThePage } = as(keel, who);
  const found = await createHttpDirectory({ fetch: serve }).findProject("acme", "demo");
  const source = createHttpSource(found ?? project, { fetch: serve });
  fromThePage.length = 0;
  const of = <Type extends AnyEvent["type"]>(type: Type) =>
    keel
      .events()
      .filter((event): event is Extract<AnyEvent, { type: Type }> => event.type === type);
  return { keel, source, fromThePage, project, of };
}

/** The project's log folded as `who` is read it, to its end. */
async function folded(open: Awaited<ReturnType<typeof opened>>): Promise<Player> {
  const player = new Player(open.source);
  await player.load();
  player.seek(player.end);
  return player;
}

const refusal = (error: unknown) =>
  error instanceof KeelRefused ? { status: error.status, code: error.code } : String(error);

describe("Keel's memory of a project's decisions, as the page reads it", () => {
  it("[decisions.calls] asks Keel for the list by the project's id and for one decision by its own, with nothing of the page's added", async () => {
    const { source, fromThePage, project } = await opened("member");
    const page = await source.decisions.listDecisions({});
    expect(page.items.map((view) => [view.label, view.summary, view.state])).toEqual([
      ["D-1", S2_DECIDED, "active"],
    ]);
    const id = page.items[0]?.id ?? "";
    expect((await source.decisions.getDecision(id))?.label).toBe("D-1");
    await source.decisions.listDecisions({ subject: "authz.permission-evaluation", cursor: id });
    expect(
      fromThePage.map(
        (request) =>
          `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`,
      ),
    ).toEqual([
      `GET /v1/decisions?project=${project.id}`,
      `GET /v1/decisions/${id}`,
      `GET /v1/decisions?project=${project.id}&subject=authz.permission-evaluation&cursor=${id}`,
    ]);
    expect(
      fromThePage.filter(
        (request) => request.headers.has("authorization") || request.headers.has("cookie"),
      ),
    ).toEqual([]);
  });

  it("[decisions.read-by] is read to whoever reads the project, a visitor to a public one among them, and is not there for anyone else", async () => {
    const read = async (who: Who, visibility: "public" | "private") => {
      const { source, of } = await opened(who, visibility);
      const id = of("DecisionRecorded")[0]?.payload.decisionId ?? "";
      return [
        await source.decisions.listDecisions({}).then((page) => page.items.length, refusal),
        (await source.decisions.getDecision(id))?.label ?? null,
      ];
    };
    expect(await read("visitor", "public")).toEqual([1, "D-1"]);
    expect(await read("stranger", "public")).toEqual([1, "D-1"]);
    expect(await read("member", "private")).toEqual([1, "D-1"]);
    // A private project is not there for a reader it is not read to: the list is Keel's 404, and a decision of
    // it is the same answer as one Keel never recorded.
    const gone = { status: 404, code: "resource.not_found" };
    expect(await read("visitor", "private")).toEqual([gone, null]);
    expect(await read("stranger", "private")).toEqual([gone, null]);
    const { source } = await opened("owner");
    expect(await source.decisions.getDecision("dec_00000000000000000000000000")).toBeNull();
  });

  it("[decisions.not-found] answers a decision that is not this reader's in Keel's own words, naming only what was asked", async () => {
    const { keel, of } = await opened("visitor", "private");
    const id = of("DecisionRecorded")[0]?.payload.decisionId ?? "";
    const answers = await Promise.all(
      [id, "dec_none"].map(async (asked) => {
        const response = await keel.fetch(new Request(`${ORIGIN}/v1/decisions/${asked}`));
        const body: { code?: string; detail?: string; nextActions?: { title: string }[] } =
          await response.json();
        return [
          response.status,
          body.code,
          body.detail,
          body.nextActions?.map((next) => next.title),
        ];
      }),
    );
    expect(answers).toEqual(
      [id, "dec_none"].map((asked) => [
        404,
        "decision.not_found",
        `No decision ${asked} in a project you can read.`,
        ["List the project's decisions"],
      ]),
    );
  });

  it("[decisions.joined] says of a decision what its conflict says: the subject, whom the ruling went against, what it upheld and the guard that holds it", async () => {
    const { source, of, project } = await opened("visitor", "public");
    const [view] = (await source.decisions.listDecisions({})).items;
    const [recorded] = of("DecisionRecorded");
    const [suspected] = of("ConflictSuspected");
    const resolved = of("ConflictResolved").find(
      (event) => event.payload.decisionId === recorded?.payload.decisionId,
    );
    expect(view).toEqual({
      id: recorded?.payload.decisionId,
      label: "D-1",
      option: "invalidate",
      summary: S2_DECIDED,
      scope: "authz.permission-evaluation",
      decidedAt: recorded?.at,
      state: "active",
      escalationId: recorded?.payload.escalationId,
      project: project.id,
      conflictId: suspected?.payload.conflictId,
      subject: "authz.permission-evaluation",
      // The ruling went against the change that makes the effect, so the premise stood, and the guard drawn
      // from the premise holds the decision.
      holds: [suspected?.payload.premise?.proposition],
      against: resolved?.payload.against,
      guards: [of("GuardAdmitted")[0]?.payload.guardId],
    } satisfies Record<keyof DecisionView, unknown>);
    expect(resolved?.payload.against).toEqual([suspected?.payload.effect?.changeId]);
  });

  it("[decisions.upheld] holds the premise where the ruling went against the effect's change, the effect where it went against the premise's holder, and leaves a guard holding only a premise that stood", async () => {
    const told = await Promise.all(
      S1_CHOICES.map(async (choice) => {
        const { source, of, keel } = await opened("owner", "private", "s1");
        expect((await source.decisions.listDecisions({})).items).toEqual([]);
        await source.giveRuling({
          escalationId: of("EscalationRaised")[0]?.payload.escalationId ?? "",
          option: choice.id,
          idempotencyKey: `key-${choice.id}`,
        });
        const [view] = (await source.decisions.listDecisions({})).items;
        const events = keel.events();
        const suspected = events.find((event) => event.type === "ConflictSuspected");
        const sides = suspected?.type === "ConflictSuspected" ? suspected.payload : undefined;
        const against = view?.against ?? [];
        const authorLost = against.includes(sides?.effect?.changeId ?? "");
        const holderLost = against.includes(sides?.premise?.holder ?? "");
        // What Keel's `holds` reads off the two sides, worked out here from the log alone.
        const upheld =
          authorLost === holderLost
            ? []
            : [authorLost ? sides?.premise?.proposition : sides?.effect?.proposition];
        expect(view?.holds).toEqual(upheld);
        expect(view?.guards.length).toBe(authorLost && !holderLost ? 1 : 0);
        return authorLost === holderLost ? "neither" : authorLost ? "premise" : "effect";
      }),
    );
    // The three choices between them uphold the premise and the effect: both rules are met here.
    expect(new Set(told)).toEqual(new Set(["premise", "effect"]));
  });
});

/** A source of Keel's list in pages of one, which keeps what it was asked. */
function paged(
  views: DecisionView[],
): KeelDecisions & { asked: { subject?: string; cursor?: string }[] } {
  const asked: { subject?: string; cursor?: string }[] = [];
  return {
    asked,
    listDecisions: (query) => {
      asked.push(query);
      const from =
        query.cursor === undefined ? 0 : views.findIndex((view) => view.id === query.cursor) + 1;
      const [item] = views.slice(from);
      return Promise.resolve({
        items: item === undefined ? [] : [item],
        ...(from + 1 < views.length && item !== undefined ? { nextCursor: item.id } : {}),
      });
    },
    getDecision: () => Promise.resolve(null),
  };
}

const view = (id: string, more: Partial<DecisionView> = {}): DecisionView => ({
  id,
  label: `D-${id.slice(-1)}`,
  option: "invalidate",
  summary: `decided ${id}`,
  decidedAt: "2026-10-13T10:00:00.000Z",
  state: "active",
  escalationId: "esc_1",
  project: "prj_1",
  holds: [],
  guards: [],
  ...more,
});

describe("Keel's list of decisions, a page at a time", () => {
  it("[decisions.pages] asks for each page with the cursor the page before it gave, and for no more pages than were asked for", async () => {
    const source = paged([view("dec_3"), view("dec_2"), view("dec_1")]);
    expect(await readDecisions(source, undefined, 1)).toMatchObject({ next: "dec_3" });
    expect(source.asked).toEqual([{}]);
    source.asked.length = 0;
    const two = await readDecisions(source, "a.b", 2);
    expect(two.items.map((item) => item.id)).toEqual(["dec_3", "dec_2"]);
    expect(two.next).toBe("dec_2");
    expect(source.asked).toEqual([{ subject: "a.b" }, { subject: "a.b", cursor: "dec_3" }]);
  });

  it("[decisions.last-page] stops at the page that names no cursor, however many pages were asked for", async () => {
    const source = paged([view("dec_2"), view("dec_1")]);
    const all = await readDecisions(source, undefined, 9);
    expect(all.items.map((item) => item.id)).toEqual(["dec_2", "dec_1"]);
    expect(all).not.toHaveProperty("next");
    expect(source.asked).toHaveLength(2);
  });
});

describe("a decision on the page", () => {
  it("[decisions.rows] lists Keel's rows in Keel's order, each with what the project's log calls the conflict it ruled", async () => {
    const open = await opened("visitor", "public");
    const { world } = await folded(open);
    const [first] = (await open.source.decisions.listDecisions({})).items;
    if (first === undefined) throw new Error("the stand-in Keel lists no decision");
    // A second row, older and of a conflict this log does not name: it keeps its place and is called nothing.
    const older = view("dec_1", { conflictId: "cfl_elsewhere", state: "superseded" });
    expect(decisionRowsOf([older, first], world)).toEqual([
      {
        id: "dec_1",
        label: "D-1",
        summary: "decided dec_1",
        decidedAt: older.decidedAt,
        state: "superseded",
        conflict: { id: "cfl_elsewhere", label: "" },
      },
      {
        id: first.id,
        label: "D-1",
        summary: S2_DECIDED,
        decidedAt: first.decidedAt,
        state: "active",
        subject: "authz.permission-evaluation",
        conflict: { id: first.conflictId, label: "C-1" },
      },
    ]);
  });

  it("[decisions.standing] says a guard blocks only for a decision that stands and that a guard holds", () => {
    expect(standingOf({ state: "active", guards: ["grd_1"] })).toBe("blocks");
    expect(standingOf({ state: "active", guards: [] })).toBe("unguarded");
    // Keel's row may still name the guard of a decision that has ended: it blocks for it no longer.
    expect(standingOf({ state: "superseded", guards: ["grd_1"] })).toBe("ended");
    expect(standingOf({ state: "overruled", guards: ["grd_1"] })).toBe("ended");
  });

  it("[decisions.detail] names what Keel's read names as the project's log calls each: the conflict, the changes the ruling went against, the guard and the changes bounced citing it", async () => {
    const open = await opened("visitor", "public");
    const { world } = await folded(open);
    const [read] = (await open.source.decisions.listDecisions({})).items;
    if (read === undefined) throw new Error("the stand-in Keel lists no decision");
    const detail = decisionDetailOf(read, world, true);
    const guard = [...world.guards.values()][0];
    expect(detail).toMatchObject({
      label: "D-1",
      standing: "blocks",
      conflict: { id: read.conflictId, label: "C-1" },
      against: [{ id: read.against?.[0], label: "#1" }],
      guards: [{ id: guard?.id, label: "G-1", conflictId: read.conflictId }],
      bounced: [{ label: "#1205" }],
      holds: read.holds,
    });
    // A change or a guard the log this reader is read does not name is called by Keel's id for it.
    const elsewhere = decisionDetailOf(
      { ...read, against: ["chg_elsewhere"], guards: ["grd_elsewhere"] },
      world,
      true,
    );
    expect(elsewhere.against).toEqual([{ id: "chg_elsewhere", label: "chg_elsewhere" }]);
    expect(elsewhere.guards).toEqual([{ id: "grd_elsewhere", label: "grd_elsewhere" }]);
    expect(elsewhere.standing).toBe("blocks");
  });

  it("[decisions.question-members] names the question a decision answered to a reader Keel reads the project's questions, and to nobody else", async () => {
    const mine = await opened("member");
    const [read] = (await mine.source.decisions.listDecisions({})).items;
    if (read === undefined) throw new Error("the stand-in Keel lists no decision");
    const member = decisionDetailOf(read, (await folded(mine)).world, false);
    expect(member.question).toEqual({ id: read.escalationId, label: "E-1" });
    const theirs = await opened("visitor", "public");
    const visitor = decisionDetailOf(read, (await folded(theirs)).world, true);
    expect(visitor).not.toHaveProperty("question");
    expect(JSON.stringify(visitor)).not.toContain(read.escalationId);
  });

  it("[decisions.citing] keeps every change Keel bounced citing a decision, each once, whatever it bounced on later", async () => {
    const open = await opened("visitor", "public");
    const { world } = await folded(open);
    const bounce = open.of("ChangeBounced").at(-1);
    const decision = open.of("DecisionRecorded")[0]?.payload.decisionId ?? "";
    if (bounce === undefined) throw new Error("scenario 2 bounces nothing");
    expect(world.citing.get(decision)).toEqual([bounce.payload.changeId]);
    // The same bounce again, and then one that cites nothing: the change is still one that was bounced citing it.
    world.apply(bounce, 0);
    world.apply({ ...bounce, payload: { ...bounce.payload, nextActions: [] } }, 0);
    expect(world.citing.get(decision)).toEqual([bounce.payload.changeId]);
    expect(world.changes.get(bounce.payload.changeId)?.bounce).not.toHaveProperty("cites");
  });

  it("[decisions.verdict-tied] shows a change the verdict its bounce names, though the verdict judged its batch", async () => {
    const open = await opened("visitor", "public");
    const player = await folded(open);
    const bounce = open.of("ChangeBounced").at(-1)?.payload;
    const verdict = player.world.verdicts.get(bounce?.verdictId ?? "");
    expect(verdict?.subject).toBe(open.of("BatchFailed").at(-1)?.payload.batchId);
    expect(player.world.changes.get(bounce?.changeId ?? "")?.verdictIds).toEqual([
      bounce?.verdictId,
    ]);
    expect(changePageOf(player.world, bounce?.changeId ?? "", player)?.verdict?.id).toBe(
      bounce?.verdictId,
    );
  });

  it("[decisions.named] calls a decision by Keel's label in an address, and finds it by that or by its id", async () => {
    const { world } = await folded(await opened("visitor", "public"));
    const [decision] = [...world.decisions.values()];
    expect(namesIn(world).decisions.get(decision?.id ?? "")).toBe("D-1");
    expect(decisionNamed(world, "D-1")?.id).toBe(decision?.id);
    expect(decisionNamed(world, decision?.id ?? "")?.label).toBe("D-1");
    expect(decisionNamed(world, "D-2")).toBeUndefined();
  });

  it("[decisions.turns] changes when the log says something Keel's read of a decision is joined from, and at no other time", async () => {
    const open = await opened("visitor", "public");
    const events = open.keel.events();
    const world = new World();
    const turned: string[] = [];
    let before = turnsOf(world);
    for (const event of events) {
      world.apply(event, 0);
      const after = turnsOf(world);
      if (after !== before) turned.push(event.type);
      before = after;
    }
    // History's guard, the resolution that names its decision and the decision; then the careless change's
    // bounce. A bounce by the ruling itself cites nothing, and turns nothing.
    expect(turned).toEqual([
      "GuardAdmitted",
      "ConflictResolved",
      "DecisionRecorded",
      "ChangeBounced",
    ]);
    const decision = open.of("DecisionRecorded")[0];
    const guard = open.of("GuardAdmitted")[0];
    if (decision === undefined || guard === undefined) throw new Error("no decision, or no guard");
    world.apply(
      {
        ...decision,
        type: "DecisionOverruled",
        payload: {
          _tag: "DecisionOverruled",
          decisionId: decision.payload.decisionId,
          by: "dec_9",
          requestedBy: "usr_9",
        },
      },
      0,
    );
    expect(turnsOf(world)).not.toBe(before);
    before = turnsOf(world);
    world.apply(
      {
        ...guard,
        type: "GuardRetired",
        payload: { _tag: "GuardRetired", guardId: guard.payload.guardId, decisionId: "dec_9" },
      },
      0,
    );
    expect(turnsOf(world)).not.toBe(before);
  });
});
