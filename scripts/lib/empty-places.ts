// Finding the places that hold no project. A place is a row of D1's
// `projects`: a name in a namespace, assigned before the Project object is
// made. A create that failed before places were given back left its row
// behind, and the name is taken by a project nobody can read.
//
// Keel answers "there is no project" and "you may not read it" alike, so a
// 404 says a place is empty only to a caller who may read every project of
// its namespace, and only while that holds. So only the caller's own
// namespace is looked at, and an empty place is believed only beside a place
// of that namespace that answered in the same pass.

/** A place as D1 holds it. `createdAt` is in milliseconds. */
export interface Place {
  readonly id: string;
  readonly namespace: string;
  readonly name: string;
  readonly createdAt: number;
}

/** D1's answer is not the places, or a place is not one Keel could have written. */
export class PlacesRefused extends Error {}

export const PLACES_QUERY =
  "SELECT id, namespace_id, name, created_at FROM projects ORDER BY namespace_id, name";

const PROJECT_ID = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;

const field = (from: unknown, name: string): unknown =>
  typeof from === "object" && from !== null ? Reflect.get(from, name) : undefined;

/** The one statement of what `wrangler d1 execute --json` prints, when it succeeded. */
function statementOf(answer: unknown): unknown {
  const statement: unknown = Array.isArray(answer) && answer.length === 1 ? answer[0] : undefined;
  if (field(statement, "success") !== true)
    throw new PlacesRefused("D1 did not answer the one statement");
  return statement;
}

/** The places in what `wrangler d1 execute --json` prints for `PLACES_QUERY`. */
export function placesFromD1(answer: unknown): readonly Place[] {
  const rows = field(statementOf(answer), "results");
  if (!Array.isArray(rows)) throw new PlacesRefused("D1 answered no rows");
  return rows.map((row: unknown, index): Place => {
    const [id, namespace, name, createdAt] = ["id", "namespace_id", "name", "created_at"].map((k) =>
      field(row, k),
    );
    if (
      typeof id !== "string" ||
      !PROJECT_ID.test(id) ||
      typeof namespace !== "string" ||
      namespace === "" ||
      typeof name !== "string" ||
      name === "" ||
      typeof createdAt !== "number" ||
      !Number.isSafeInteger(createdAt)
    )
      throw new PlacesRefused(`row ${index} is not a place: ${JSON.stringify(row)}`);
    return { id, namespace, name, createdAt };
  });
}

/** The statement that gives a place back, by its project's id alone. */
export function releaseStatement(place: Place): string {
  if (!PROJECT_ID.test(place.id)) throw new PlacesRefused(`${place.id} is not a project id`);
  return `DELETE FROM projects WHERE id = '${place.id}'`;
}

/** Whether what `wrangler d1 execute --json` prints for a release says one row went. */
export function releasedOne(answer: unknown): boolean {
  return field(field(statementOf(answer), "meta"), "changes") === 1;
}

/**
 * One look at a place: its project answered, Keel said there is none, or
 * neither could be told (the request failed, or another project answered).
 */
export type Look = "project" | "none" | "untold";

/**
 * How a place stands after a survey:
 * - `project`: its project answered every look;
 * - `empty`: every look found none, beside a project of the namespace that answered;
 * - `untold`: the looks failed or disagreed, or nothing of the namespace answered;
 * - `too-new`: placed within `SETTLED_AFTER_MS`, so not looked at;
 * - `elsewhere`: in another namespace, so not looked at.
 */
export type Standing = "project" | "empty" | "untold" | "too-new" | "elsewhere";

export interface Surveyed {
  readonly place: Place;
  readonly standing: Standing;
}

/** A create assigns its place before it makes the project: a place this young may be one in flight. */
export const SETTLED_AFTER_MS = 60 * 60_000;

/** How many times a survey looks at each place. */
export const LOOKS = 2;

/**
 * Every place with how it stands. The places of `namespace` old enough to
 * judge are looked at `LOOKS` times, a whole pass at a time so one place's
 * looks are apart.
 */
export async function survey(
  places: readonly Place[],
  namespace: string,
  now: number,
  look: (place: Place) => Promise<Look>,
): Promise<readonly Surveyed[]> {
  const judged = places.filter(
    (place) => place.namespace === namespace && now - place.createdAt >= SETTLED_AFTER_MS,
  );
  const looks = new Map<string, Look[]>(judged.map((place) => [place.id, []]));
  // oxlint-disable no-await-in-loop -- one look after another: the passes are meant to be apart
  for (let pass = 0; pass < LOOKS; pass += 1)
    for (const place of judged) looks.get(place.id)?.push(await look(place));
  // oxlint-enable no-await-in-loop
  const every = (place: Place, found: Look) =>
    (looks.get(place.id) ?? []).every((seen) => seen === found);
  const witnessed = judged.some((place) => every(place, "project"));
  return places.map((place) => {
    if (!looks.has(place.id))
      return { place, standing: place.namespace === namespace ? "too-new" : "elsewhere" };
    if (every(place, "project")) return { place, standing: "project" };
    return { place, standing: witnessed && every(place, "none") ? "empty" : "untold" };
  });
}

export interface Released {
  readonly released: readonly Place[];
  /** The empty places kept: by now their project answers, or nothing of the namespace does. */
  readonly kept: readonly Place[];
}

/**
 * Gives back each place the survey found empty. Just before each, a project
 * the survey saw answer must answer still and the place must still hold
 * none; otherwise the place is kept.
 */
export async function release(
  surveyed: readonly Surveyed[],
  look: (place: Place) => Promise<Look>,
  drop: (place: Place) => Promise<void>,
): Promise<Released> {
  const witness = surveyed.find((s) => s.standing === "project")?.place;
  const released: Place[] = [];
  const kept: Place[] = [];
  // oxlint-disable no-await-in-loop -- one place after another, each looked at just before it goes
  for (const { place, standing } of surveyed) {
    if (standing !== "empty") continue;
    const still =
      witness !== undefined &&
      (await look(witness)) === "project" &&
      (await look(place)) === "none";
    if (still) {
      await drop(place);
      released.push(place);
    } else kept.push(place);
  }
  // oxlint-enable no-await-in-loop
  return { released, kept };
}
