import { describe, expect, it } from "vitest";
import {
  type Look,
  type Place,
  PLACES_QUERY,
  PlacesRefused,
  placesFromD1,
  release,
  releasedOne,
  releaseStatement,
  SETTLED_AFTER_MS,
  survey,
} from "../../../scripts/lib/empty-places.ts";

const MINE = "usr_01M4S2MJTNG88WTBB0JSDHKCKA";
const THEIRS = "usr_01M4RZBDSFSC5H0BA1PM87E40B";
const NOW = 1_760_000_000_000;
const OLD = NOW - SETTLED_AFTER_MS;

const place = (
  name: string,
  serial: string,
  namespace: string = MINE,
  createdAt: number = OLD,
): Place => ({
  id: `prj_01M4S2MJTNG88WTBB0JSDHKC${serial}`,
  namespace,
  name,
  createdAt,
});

const LIVE = place("forge-lite", "0A");
const SMOKE = place("smoke", "0B");
const OTHERS = place("private", "0C", THEIRS);

/** Keel as a caller meets it: each place's answers in the order asked, the last one repeated. */
function keel(answers: Readonly<Record<string, readonly Look[]>>) {
  const asked: string[] = [];
  const look = (at: Place): Promise<Look> => {
    const mine = answers[at.name] ?? [];
    const nth = asked.filter((name) => name === at.name).length;
    asked.push(at.name);
    return Promise.resolve(mine[Math.min(nth, mine.length - 1)] ?? "untold");
  };
  return { asked, look };
}

const standings = (surveyed: Awaited<ReturnType<typeof survey>>) =>
  Object.fromEntries(surveyed.map((s) => [s.place.name, s.standing]));

const d1 = (results: unknown, success = true) => [{ results, success, meta: { changes: 0 } }];
const rowOf = (at: Place) => ({
  id: at.id,
  namespace_id: at.namespace,
  name: at.name,
  created_at: at.createdAt,
});

describe("the places D1 holds", () => {
  it("[places.d1] reads each row of the one statement D1 answered as a place", () => {
    expect(PLACES_QUERY).toContain("FROM projects");
    expect(placesFromD1(d1([rowOf(LIVE), rowOf(OTHERS)]))).toEqual([LIVE, OTHERS]);
    expect(placesFromD1(d1([]))).toEqual([]);
  });

  it("[places.d1-refused] refuses an answer that is not the places, and a row Keel could not have written", () => {
    expect(() => placesFromD1(d1([rowOf(LIVE)], false))).toThrow(PlacesRefused);
    expect(() => placesFromD1([...d1([]), ...d1([])])).toThrow(PlacesRefused);
    expect(() => placesFromD1(d1(undefined))).toThrow(PlacesRefused);
    for (const broken of [
      { ...rowOf(LIVE), id: "prj_1' OR '1'='1" },
      { ...rowOf(LIVE), id: LIVE.namespace },
      { ...rowOf(LIVE), namespace_id: "" },
      { ...rowOf(LIVE), name: 7 },
      { ...rowOf(LIVE), created_at: "yesterday" },
    ])
      expect(() => placesFromD1(d1([broken]))).toThrow(/row 0 is not a place/);
  });
});

describe("which places hold no project", () => {
  it("[places.empty] finds the place Keel twice says holds none, beside a project of the namespace that answers", async () => {
    const { asked, look } = keel({ "forge-lite": ["project"], smoke: ["none"] });
    expect(standings(await survey([LIVE, SMOKE], MINE, NOW, look))).toEqual({
      "forge-lite": "project",
      smoke: "empty",
    });
    expect(asked).toEqual(["forge-lite", "smoke", "forge-lite", "smoke"]);
  });

  it("[places.elsewhere] never looks at a place of another namespace, and never calls it empty", async () => {
    const { asked, look } = keel({ "forge-lite": ["project"], private: ["none"] });
    expect(standings(await survey([LIVE, OTHERS], MINE, NOW, look))).toEqual({
      "forge-lite": "project",
      private: "elsewhere",
    });
    expect(asked).not.toContain("private");
  });

  it("[places.too-new] never looks at a place younger than an hour: its create may be in flight", async () => {
    const young = place("just-made", "0D", MINE, OLD + 1);
    const { asked, look } = keel({ "forge-lite": ["project"], "just-made": ["none"] });
    expect(standings(await survey([LIVE, young], MINE, NOW, look))).toEqual({
      "forge-lite": "project",
      "just-made": "too-new",
    });
    expect(asked).not.toContain("just-made");
  });

  it.each([
    ["a look that failed", ["untold", "none"]],
    ["a second look that failed", ["none", "untold"]],
    ["a project that answers the second look", ["none", "project"]],
    ["a project that stops answering", ["project", "none"]],
  ] as const)("[places.untold] calls a place untold after %s", async (_what, answers) => {
    const { look } = keel({ "forge-lite": ["project"], smoke: answers });
    expect(standings(await survey([LIVE, SMOKE], MINE, NOW, look))).toEqual({
      "forge-lite": "project",
      smoke: "untold",
    });
  });

  it("[places.witness] believes no empty place when nothing of the namespace answers: the caller may be refused everything", async () => {
    const other = place("other", "0E");
    const { look } = keel({ smoke: ["none"], other: ["none"], "forge-lite": ["project", "none"] });
    expect(standings(await survey([SMOKE, other], MINE, NOW, look))).toEqual({
      smoke: "untold",
      other: "untold",
    });
    expect(standings(await survey([LIVE, SMOKE], MINE, NOW, look))).toEqual({
      "forge-lite": "untold",
      smoke: "untold",
    });
  });
});

describe("giving the empty places back", () => {
  it("[places.release] drops each empty place and nothing else", async () => {
    const young = place("just-made", "0D", MINE, NOW);
    const { look } = keel({ "forge-lite": ["project"], smoke: ["none"], private: ["none"] });
    const surveyed = await survey([LIVE, SMOKE, OTHERS, young], MINE, NOW, look);
    const dropped: Place[] = [];
    const answer = await release(surveyed, look, (at) => {
      dropped.push(at);
      return Promise.resolve();
    });
    expect(dropped).toEqual([SMOKE]);
    expect(answer).toEqual({ released: [SMOKE], kept: [] });
  });

  it("[places.release-looks-again] keeps a place whose project answers by the time it would go", async () => {
    const { look } = keel({ "forge-lite": ["project"], smoke: ["none", "none", "project"] });
    const surveyed = await survey([LIVE, SMOKE], MINE, NOW, look);
    expect(standings(surveyed)).toMatchObject({ smoke: "empty" });
    const dropped: Place[] = [];
    const answer = await release(surveyed, look, (at) => {
      dropped.push(at);
      return Promise.resolve();
    });
    expect(dropped).toEqual([]);
    expect(answer).toEqual({ released: [], kept: [SMOKE] });
  });

  it("[places.release-witness] keeps every place once the project that answered the survey answers no more", async () => {
    const { look } = keel({ "forge-lite": ["project", "project", "none"], smoke: ["none"] });
    const surveyed = await survey([LIVE, SMOKE], MINE, NOW, look);
    expect(standings(surveyed)).toMatchObject({ smoke: "empty" });
    const dropped: Place[] = [];
    const answer = await release(surveyed, look, (at) => {
      dropped.push(at);
      return Promise.resolve();
    });
    expect(dropped).toEqual([]);
    expect(answer).toEqual({ released: [], kept: [SMOKE] });
  });

  it("[places.statement] deletes one row by its project's id, and writes no statement for anything else", () => {
    expect(releaseStatement(SMOKE)).toBe(`DELETE FROM projects WHERE id = '${SMOKE.id}'`);
    expect(() => releaseStatement({ ...SMOKE, id: "x' OR name <> '" })).toThrow(PlacesRefused);
    expect(releasedOne([{ results: [], success: true, meta: { changes: 1 } }])).toBe(true);
    expect(releasedOne([{ results: [], success: true, meta: { changes: 0 } }])).toBe(false);
    expect(() => releasedOne([{ results: [], success: false, meta: { changes: 1 } }])).toThrow(
      PlacesRefused,
    );
  });
});
