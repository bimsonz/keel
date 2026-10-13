// Lists the places that hold no project and, with --apply, gives them back.
// A create that failed before places were given back left its row in D1's
// `projects`: the name is taken there by a project nobody can read.
//   KEEL_SESSION=<a user's session> node scripts/release-empty-places.ts staging
//       the dry run: every place of that user's own namespace and how it stands
//   KEEL_SESSION=<a user's session> node scripts/release-empty-places.ts staging --apply
//       gives back the empty ones, each looked at once more just before
// Only the signed-in user's own namespace is judged: there, and nowhere else,
// a 404 can only mean that no project answers. Run it once per user whose
// places are to be checked. The places of other namespaces are counted, not
// looked at. Nothing is given back unless a project of the namespace answers
// in the same run, and no place younger than an hour is looked at. KEEL_URL
// overrides the site URL. The session is read and never printed. Exit 1 when
// a place could not be told, or an empty one was kept.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountId, siteHost, wrangler } from "./env.ts";
import {
  type Look,
  type Place,
  PLACES_QUERY,
  placesFromD1,
  release,
  releasedOne,
  releaseStatement,
  survey,
} from "./lib/empty-places.ts";

const USAGE = "usage: KEEL_SESSION=<session> node scripts/release-empty-places.ts <env> [--apply]";

function usage(reason: string): never {
  console.error(`${reason}\n${USAGE}`);
  process.exit(2);
}

const [environment, ...rest] = process.argv.slice(2);
if (environment === undefined || !/^[a-z]+$/.test(environment)) usage("Name the environment.");
for (const word of rest) if (word !== "--apply") usage(`Unknown argument ${word}.`);
const apply = rest.includes("--apply");
const session = process.env["KEEL_SESSION"] ?? usage("KEEL_SESSION is not set.");
// wrangler reads the account from the environment: say so before anything is asked.
accountId();
const keelUrl = process.env["KEEL_URL"] ?? `https://${siteHost(environment)}`;

const field = (from: unknown, name: string): unknown =>
  typeof from === "object" && from !== null ? Reflect.get(from, name) : undefined;

/** A read of Keel's API as the signed-in user: the status, and the body when it is JSON. */
async function read(path: string): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${keelUrl}/v1${path}`, {
    headers: { authorization: `Bearer ${session}`, accept: "application/json" },
  });
  const body: unknown = await response.json().catch(() => undefined);
  return { status: response.status, body };
}

// Run where no wrangler config is, so the database is found by its name in the account.
const nowhere = mkdtempSync(join(tmpdir(), "keel-places-"));
const d1 = (statement: string): unknown =>
  JSON.parse(
    wrangler(
      ["d1", "execute", `keel-${environment}`, "--remote", "--json", "--command", statement],
      { cwd: nowhere, quiet: true },
    ),
  );

let unsettled = false;
try {
  const me = await read("/users/me");
  const userId = field(me.body, "userId");
  const handle = field(field(me.body, "namespace"), "handle");
  if (me.status !== 200 || typeof userId !== "string" || typeof handle !== "string")
    throw new Error(
      `${keelUrl} answered ${me.status} to "who am I?": the session must be a signed-in user's, with a handle`,
    );

  /** A person's own namespace has its account's id, and its owner reads every project in it. */
  const look = async (place: Place): Promise<Look> => {
    try {
      const { status, body } = await read(
        `/namespaces/${encodeURIComponent(handle)}/projects/${encodeURIComponent(place.name)}`,
      );
      if (status === 200) return field(body, "id") === place.id ? "project" : "untold";
      return status === 404 && field(body, "code") === "resource.not_found" ? "none" : "untold";
    } catch {
      return "untold";
    }
  };

  const places = placesFromD1(d1(PLACES_QUERY));
  const surveyed = await survey(places, userId, Date.now(), look);
  const mine = surveyed.filter((s) => s.standing !== "elsewhere");
  console.log(
    `${environment}: ${places.length} places, ${mine.length} in ${handle}'s own namespace; the other ${places.length - mine.length} were not looked at`,
  );
  for (const { place, standing } of mine)
    console.log(
      `  ${standing.padEnd(8)} ${handle}/${place.name}  ${place.id}  placed ${new Date(place.createdAt).toISOString()}`,
    );
  const untold = mine.filter((s) => s.standing === "untold");
  const empty = mine.filter((s) => s.standing === "empty");
  if (untold.length > 0) {
    unsettled = true;
    console.log(
      `${untold.length} could not be told: a look failed, two looks disagreed, or no project of ${handle} answered beside it (a 404 then proves nothing: make one project there and run again)`,
    );
  }
  if (!apply)
    console.log(
      `${empty.length} empty${empty.length === 0 ? "" : `: run again with --apply to give ${empty.length === 1 ? "it" : "them"} back`}`,
    );
  else {
    const { released, kept } = await release(surveyed, look, (place) => {
      if (!releasedOne(d1(releaseStatement(place))))
        throw new Error(`D1 deleted no row for ${place.id}`);
      return Promise.resolve();
    });
    for (const place of released) console.log(`  released ${handle}/${place.name}  ${place.id}`);
    for (const place of kept)
      console.log(`  kept     ${handle}/${place.name}  ${place.id}: it no longer reads as empty`);
    console.log(`${released.length} released, ${kept.length} kept`);
    if (kept.length > 0) unsettled = true;
  }
} finally {
  rmSync(nowhere, { recursive: true, force: true });
}
process.exit(unsettled ? 1 : 0);
