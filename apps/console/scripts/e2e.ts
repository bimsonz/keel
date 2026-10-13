// Drives the real page in a real browser.
//
// Two servers are under test. The dev server (`pnpm dev`, port 5311) serves the
// scripted fixtures, and the pages are checked against those. The console is
// then built and served here (port 5312) and checked the way it is deployed:
// one page that reads Keel under /v1 on its own origin, as whoever is signed
// in. What answers /v1 here is test code: the real Better Auth for Keel's
// identity, and a stand-in for the rest of Keel.
//
//   node scripts/e2e.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, type Locator, type Page, chromium } from "playwright";
import { encode } from "uqr";
import { build, preview } from "vite";
import { createAccount } from "../src/account/account.ts";
import { type Identity, createIdentity } from "../test/fixtures/identity/standIn.ts";
import {
  type Call,
  type FakeKeel,
  PUBLIC_REPOSITORY,
  type Reader,
  createFakeKeel,
} from "../test/fixtures/mock/fakeKeel.ts";

const dev = process.argv[2] ?? "http://localhost:5311";
const BUILT_PORT = 5312;
const built = `http://localhost:${BUILT_PORT}`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors: string[] = [];
const watch = (page: Page, who: string): Page => {
  page.on("console", (message) => {
    // A request the stand-in refuses on purpose is logged by the browser; it is not a fault of the page.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
      errors.push(`${who}: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${who}: ${error.message}`));
  return page;
};

const failures: string[] = [];
const expectEqual = (what: string, actual: string, expected: string): void => {
  console.log(
    `${actual === expected ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(actual)}${actual === expected ? "" : `, expected ${JSON.stringify(expected)}`}`,
  );
  if (actual !== expected) failures.push(what);
};
const squash = (text: string): string => text.replaceAll(/\s+/g, " ").trim();
const statOn = async (page: Page, label: string): Promise<string> =>
  squash(
    await page
      .locator("dl dt", { hasText: label })
      .locator("xpath=following-sibling::dd[1]")
      .innerText(),
  );
const pathOf = (page: Page): string => new URL(page.url()).pathname;
/** A capture of a page as it stands, kept only when a folder is named for them (`SHOTS=<folder>`). */
/** Waits for Mission Control's graph to be drawn, or for five seconds: the check after it says which. */
const graphDrawn = async (shown: Page): Promise<void> => {
  await shown
    .locator(".a-fn")
    .first()
    .waitFor({ timeout: 5_000 })
    .catch(() => undefined);
};
const shot = async (shown: Page, name: string): Promise<void> => {
  const folder = process.env["SHOTS"];
  if (folder !== undefined && folder !== "")
    await shown.screenshot({ path: `${folder}/${name}.png` });
};
/** The frame's tabs: the places a project has. */
const tabsOf = (page: Page) => page.getByRole("navigation", { name: "Project" }).getByRole("link");
const qrOn = (page: Page) =>
  page.locator("svg", { has: page.locator("title", { hasText: "QR code" }) });
/** The review funnel's three tables: the changes, the conflicts, and the comparisons where a source reports them. */
type FunnelTable = "changes" | "conflicts" | "comparisons";
const funnelRows = (page: Page, table: FunnelTable) =>
  page.locator(`table.a-funnel[data-funnel="${table}"] tbody tr`);
const stageOn = async (page: Page, table: FunnelTable, index: number): Promise<string> =>
  (await funnelRows(page, table).nth(index).locator("td").allInnerTexts()).map(squash).join(" | ");

// ─────────────────────────────────────────────────────────────────────────────
// The pages, on the fixtures the dev server serves
// ─────────────────────────────────────────────────────────────────────────────
const page = watch(await browser.newPage({ viewport: { width: 1920, height: 1080 } }), "fixtures");
const stat = (label: string): Promise<string> => statOn(page, label);
const stage = (table: FunnelTable, index: number): Promise<string> => stageOn(page, table, index);
const tabs = tabsOf(page);
const at = (place: string, fixture: string): string =>
  `${dev}/acme/demo${place}${place.includes("?") ? "&" : "?"}${fixture}`;
const QUESTION = /May permission checks be cached within a session\?/;

// Scenario 1 is held at the question: nothing has landed, and one person has been asked.
await page.goto(at("/escalations/E-1", "scenario=s1&t=470&ruling=live&speed=16"), {
  waitUntil: "networkidle",
});
await page.getByRole("heading", { level: 1, name: QUESTION }).waitFor();
expectEqual(
  "fixture: labelled as one",
  String(await page.getByText("Test fixture · seed 42").count()),
  "1",
);
expectEqual("options offered", String(await page.locator(".a-option").count()), "3");
// The question's default is what stands until someone answers: it is said, and it is not one of the things to tap.
expectEqual(
  "the default is said",
  String(await page.getByText("Both changes wait. Nothing lands on this subject.").count()),
  "1",
);
expectEqual(
  "the default is not offered",
  String(await page.locator(".a-option", { hasText: "Both changes wait" }).count()),
  "0",
);
// Changes go by the numbers Keel gives them.
expectEqual(
  "the parked changes, by Keel's numbers",
  String(await page.getByText("parked on this: #1 and #2").count()),
  "1",
);
// An open question has a QR code beside it, of its own address: the way to it from a phone.
expectEqual(
  "an open question offers its address as a QR code",
  String(await qrOn(page).count()),
  "1",
);

// The project is the frame. Each of its places is a tab, each tab is a link with an address of its own, and what is still open is counted on it.
expectEqual(
  "frame: every tab is a link to its own address",
  (
    await tabs.evaluateAll((links) =>
      links.map((link) =>
        link instanceof HTMLAnchorElement ? new URL(link.href).pathname : "not a link",
      ),
    )
  ).join(" "),
  "/acme/demo /acme/demo/changes /acme/demo/conflicts /acme/demo/escalations /acme/demo/mission-control /acme/demo/agents /acme/demo/insights",
);
expectEqual(
  "frame: what is open, counted on the tabs",
  (await tabs.allInnerTexts()).map(squash).join(" | "),
  "Code | Changes 2 open | Conflicts 1 open | Escalations 1 waiting for a person | Mission Control | Agents | Insights",
);
// A question is a thing in Escalations, not its list: the tab is marked as where the reader is, and not as the page.
expectEqual(
  "frame: the tab the reader is under is marked",
  squash(
    await page.getByRole("navigation", { name: "Project" }).locator("[aria-current]").innerText(),
  ),
  "Escalations 1 waiting for a person",
);
expectEqual(
  "frame: and is not called the page, which the question is",
  (await page
    .getByRole("navigation", { name: "Project" })
    .locator("[aria-current]")
    .getAttribute("aria-current")) ?? "",
  "true",
);
// In development a link keeps the fixture being looked at.
expectEqual(
  "frame: links carry the fixture",
  String(
    await tabs.evaluateAll((links) =>
      links.every(
        (link) =>
          link instanceof HTMLAnchorElement &&
          new URL(link.href).searchParams.get("scenario") === "s1",
      ),
    ),
  ),
  "true",
);

// Trunk's numbers ride above the live graph. Moving there does not load the page again: the fixture is still held where it was.
await tabs.filter({ hasText: "Mission Control" }).click();
await page.getByText("Holding: a person is being asked").waitFor();
expectEqual("people asked / landed, held", await stat("People asked / changes landed"), "1/0");
expectEqual("advances, held", await stat("Advances"), "0");
// Left alone, it stays held: the default is hold.
await page.waitForTimeout(2_500);
expectEqual("advances, still held after waiting", await stat("Advances"), "0");

// From there to the list of what is waiting for a person, to the question, and back the way one came.
await page.getByRole("link", { name: "Holding: a person is being asked" }).click();
await page.getByRole("list", { name: "Escalations, newest first" }).waitFor();
expectEqual("escalations: listed at their own address", pathOf(page), "/acme/demo/escalations");
expectEqual(
  "escalations: one row, open, with what waits on it",
  String(
    (await page.locator(".a-list > li").allInnerTexts())
      .map(squash)
      .join(" | ")
      .includes("2 changes are parked on this"),
  ),
  "true",
);
await page.locator(".a-list-title a", { hasText: QUESTION }).click();
await page.getByRole("heading", { level: 1, name: QUESTION }).waitFor();
expectEqual("escalation: named in its address", pathOf(page), "/acme/demo/escalations/E-1");
await page.goBack();
await page.getByRole("list", { name: "Escalations, newest first" }).waitFor();
expectEqual("Back returns to the list it was opened from", pathOf(page), "/acme/demo/escalations");
await page.goBack();
await page.getByText("Holding: a person is being asked").waitFor();
expectEqual(
  "Back again returns to the page before that",
  pathOf(page),
  "/acme/demo/mission-control",
);
await page.goForward();
await page.goForward();
await page.getByRole("heading", { level: 1, name: QUESTION }).waitFor();

// One tap answers it, and the story runs on by itself: both changes land and trunk stays green.
await page.locator(".a-option", { hasText: "Cache allowed if revocation invalidates it" }).click();
await page
  .getByRole("heading", { name: "Ruled: Cache allowed if revocation invalidates it" })
  .waitFor({ timeout: 10_000 });
await page.getByText("Recorded as decision D-1").waitFor({ timeout: 10_000 });
// The answer was given on one page and is read on another, with no page load between: what was ruled is still ruled.
await tabs.filter({ hasText: "Mission Control" }).click();
await page.waitForFunction(
  () =>
    [...document.querySelectorAll("dl dt")].find((dt) => dt.textContent === "Advances")
      ?.nextElementSibling?.textContent === "2",
  undefined,
  {
    timeout: 30_000,
  },
);
// The landing follows its advance by a moment, so wait for the count rather than reading it at once.
await page
  .waitForFunction(
    () =>
      [...document.querySelectorAll("dl dt")]
        .find((dt) => dt.textContent === "People asked / changes landed")
        ?.nextElementSibling?.textContent?.replaceAll(/\s+/g, "") === "1/2",
    undefined,
    { timeout: 10_000 },
  )
  .catch(() => undefined);
expectEqual(
  "people asked / landed, after the ruling",
  await stat("People asked / changes landed"),
  "1/2",
);
expectEqual("trunk red", await stat("Trunk red"), "0");
expectEqual(
  "frame: nothing is left open",
  (await tabs.allInnerTexts()).map(squash).join(" | "),
  "Code | Changes | Conflicts | Escalations | Mission Control | Agents | Insights",
);

// The conflict is settled, and is found where settled conflicts are listed. Its matrix is still the probe's record.
await tabs.filter({ hasText: "Conflicts" }).click();
await page.getByRole("heading", { name: "No conflict is open" }).waitFor();
await page
  .getByRole("navigation", { name: "Conflicts, by state" })
  .getByRole("link", { name: /Settled/ })
  .click();
expectEqual(
  "conflicts: a filter is part of the address",
  `${pathOf(page)}?state=${new URL(page.url()).searchParams.get("state") ?? ""}`,
  "/acme/demo/conflicts?state=settled",
);
await page.locator(".a-list-title a").first().click();
await page.getByRole("heading", { name: "World matrix" }).waitFor();
expectEqual("conflict: named in its address", pathOf(page), "/acme/demo/conflicts/C-1");
expectEqual(
  "conflict: called by Keel's own fields, its subject and predicate, and by Keel's label",
  squash(await page.getByRole("heading", { level: 1 }).innerText()),
  "authz.permission-evaluation · freshness C-1",
);
// How the effect is known is what Keel's suspicion said of it, and each side is the change Keel named.
expectEqual(
  "conflict: side B's effect is known as Keel said, derived by an extractor",
  squash(await page.getByRole("region", { name: "The two sides" }).innerText()).includes(
    "Keel derived it, by an extractor",
  )
    ? "said"
    : "not said",
  "said",
);
// The two sides are A and B, as Keel names the worlds, and each says which change it is.
expectEqual(
  "conflict: A is the change that relies, B the one that alters",
  `${await page.locator('[title="Change #2"]').count()}/${await page.locator('[title="Change #1"]').count()}`,
  "1/1",
);
expectEqual(
  "conflict: the combined world names both",
  String(await page.getByText("#2 and #1, composed").count()),
  "1",
);
// The line the two propositions sit on is Keel's own lattice: the branch of freshness that holds both. A TTL is on the other branch.
expectEqual(
  "conflict: the lattice's line, from Keel",
  (await page.locator("[data-lattice-value]").allInnerTexts()).join(" < "),
  "per-call < per-request < per-session < static",
);
// The proof stays where the probe found it: A+B failed three times, and Keel runs nothing in these worlds once
// the conflict is settled. The control row's fails are apart: the probe is meant to fail there.
expectEqual(
  "the proof stays in a settled conflict's matrix",
  String(await page.locator('.a-matrix [data-outcome="fail"]:not([data-control="true"])').count()),
  "3",
);
// What came of the conflict is the verdict Keel gave each side afterwards, and that is where #1 is seen to pass.
expectEqual(
  "conflict: what came of each side, from the verdicts given since",
  (
    await page
      .getByRole("list", { name: "What came of each side" })
      .getByRole("listitem")
      .allInnerTexts()
  )
    .map(squash)
    .join(" | "),
  "#2 was judged: verdict land · Verified: nothing it could have broken is broken | #1 came back as revision 2: verdict land · Verified: nothing it could have broken is broken",
);
expectEqual(
  "the control row: the probe fails there, three times",
  String(
    await page
      .locator('.a-matrix tr[data-world="A-noop"] [data-outcome="fail"][data-control="true"]')
      .count(),
  ),
  "3",
);
// Keel runs five suites in a conflict's matrix: trunk's own on trunk, each side's own in its world, and both
// where the two are composed. Each is in its world, and no cell waits on a run Keel never makes.
expectEqual(
  "conflict: the matrix holds the five suites Keel runs, each in its world",
  (
    await page
      .locator(".a-matrix tbody tr")
      .evaluateAll((rows) =>
        rows.map(
          (row) =>
            `${row.getAttribute("data-world") ?? ""}:${[...row.querySelectorAll("[data-check]")].map((suite) => (suite.getAttribute("data-check") ?? "").replace(/^suite:chg_.+$/, "suite:change")).join("+")}`,
        ),
      )
  ).join(" "),
  "trunk:suite:trunk A-noop: A:suite:change B:suite:change AB:suite:change+suite:change",
);
// What it is tied to is beside it, each a link.
expectEqual(
  "conflict: its two changes are links to them",
  (
    await page
      .locator(".a-side a")
      .evaluateAll((links) =>
        links.map((link) => (link instanceof HTMLAnchorElement ? new URL(link.href).pathname : "")),
      )
  )
    .filter((path) => path.startsWith("/acme/demo/changes/"))
    .join(" "),
  "/acme/demo/changes/2 /acme/demo/changes/1",
);

// Once the agent has said what its change does, its page shows the claim beside what Keel derived.
await page.goto(at("/changes/1", "scenario=s1&t=700&play=0"), { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "Derived by Keel" }).waitFor();
expectEqual(
  "change: called by its goal, and by Keel's number",
  squash(await page.getByRole("heading", { level: 1 }).innerText()),
  "Speed up permission checks #1",
);
expectEqual(
  "change: a declared effect, and that Keel derived one there too",
  String(await page.getByText("Keel derived an effect here too.").count()),
  "1",
);
expectEqual(
  "change: no longer says none was declared",
  String(await page.getByText("None declared.").count()),
  "0",
);
// Its parts are tabs, and each has its own address.
const parts = page.getByRole("navigation", { name: "Change" }).getByRole("link");
expectEqual(
  "change: its parts",
  (await parts.allInnerTexts()).map(squash).join(" | "),
  "Overview | Verification 8 | Files changed 2",
);
await parts.filter({ hasText: "Files changed" }).click();
await page.locator("section.a-panel[aria-label]").first().waitFor();
expectEqual("change: its files have an address", pathOf(page), "/acme/demo/changes/1/files");
// A part's address opens that part, from nowhere.
await page.goto(at("/changes/1/files", "scenario=s1&t=700&play=0"), { waitUntil: "networkidle" });
await page.locator("section.a-panel[aria-label]").first().waitFor();
expectEqual(
  "change: its diff, opened cold",
  String(await page.locator("section.a-panel[aria-label]").count()),
  "2",
);

// A hosted agent says so.
await page.goto(at("/changes/1205", "scenario=s2&t=200&play=0"), { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "Derived by Keel" }).waitFor();
expectEqual(
  "change: a hosted agent is labelled HOSTED",
  String((await page.getByText("HOSTED").count()) > 0),
  "true",
);
expectEqual(
  "change: its number, in its title",
  String(squash(await page.getByRole("heading", { level: 1 }).innerText()).endsWith("#1205")),
  "true",
);
// The verdict's event carries references. The evidence shown was read from Keel's view of the verdict.
await page
  .getByRole("navigation", { name: "Change" })
  .getByRole("link", { name: /Verification/ })
  .click();
await page
  .getByText("Guard G-1 fails against this change, three runs out of three")
  .first()
  .waitFor({ timeout: 10_000 });
expectEqual(
  "change: the verdict's evidence, read from the verdict's view",
  String(
    (await page.getByText("Guard G-1 fails against this change, three runs out of three").count()) >
      0,
  ),
  "true",
);

// A proof, and what it does to a change. Where the changes' plans block on the conflict's predicate, both
// bounce on the conflict itself: Keel issues no verdict for that, and the page shows none.
const WAYS_FORWARD =
  "Read the conflict and the proof against the change | Revise the change's intent around the conflict | Resolve the conflict with a move";
const standing = page.getByRole("region", { name: "Verdict" });
await page.goto(at("/changes/1", "scenario=s4&t=460&play=0"), { waitUntil: "networkidle" });
await standing.getByRole("heading", { level: 2 }).waitFor();
expectEqual(
  "change: bounced on a proven conflict, it says which, and shows no verdict",
  `${squash(await standing.getByRole("heading", { level: 2 }).innerText())} | ${await standing.getByText(/^Issued/).count()}`,
  "Bounced on conflict C-1 | 0",
);
expectEqual(
  "change: it says why: its plan blocks on the conflict's predicate",
  squash(await standing.locator("p").first().innerText()),
  "Keel proved conflict C-1 against this change, and its plan blocks on freshness. It bounced on the conflict itself: no verdict was issued.",
);
expectEqual(
  "change: the ways forward Keel gave its agent, in Keel's words",
  (
    await standing
      .getByRole("list", { name: "Ways forward Keel gave its agent" })
      .getByRole("listitem")
      .allInnerTexts()
  )
    .map(squash)
    .join(" | "),
  WAYS_FORWARD,
);
// A link that is not there is a failed check below, by its name, and not a wait that runs out.
const follow = async (link: ReturnType<Page["locator"]>, arrived: string): Promise<void> => {
  if ((await link.count()) === 0) return;
  await link.click();
  await page.locator(arrived).first().waitFor();
};
await follow(standing.getByRole("link", { name: "conflict C-1" }), "table.a-matrix");
expectEqual(
  "change: the bounce links to its conflict, which stays proven",
  `${pathOf(page)} ${squash(
    await page
      .locator(".a-chip", { hasText: /^proven$/ })
      .first()
      .innerText(),
  )}`,
  "/acme/demo/conflicts/C-1 proven",
);
await page.goto(at("/changes?state=bounced", "scenario=s4&t=460&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("list", { name: "Changes, newest first" }).waitFor();
expectEqual(
  "changes: both sides of a conflict their plans block on are bounced",
  (await page.locator(".a-list > li b.a-mono").allInnerTexts()).join(" "),
  "#2 #1",
);

// Where the plans say nothing of the predicate, Keel notes the conflict on both changes and holds neither.
await page.goto(at("/changes/1", "scenario=s3&t=495&play=0"), { waitUntil: "networkidle" });
const noted = page.locator("section", { has: page.getByRole("heading", { name: "Noted" }) }).last();
const notedText = async (): Promise<string> =>
  (await noted.count()) === 0 ? "nothing noted" : squash(await noted.innerText());
await standing.getByRole("heading", { level: 2 }).waitFor();
expectEqual(
  "change: a conflict noted against it did not hold it, and it landed",
  `${squash(await standing.getByRole("heading", { level: 2 }).innerText())} | ${await notedText()}`,
  "Landed on trunk | Noted C-1 advise on freshness Proven against this change, which went on: its plan does not block on that predicate. Keel told its agent, and held nothing.",
);
await follow(noted.getByRole("link", { name: "C-1" }), ".a-timeline");
expectEqual(
  "change: what is noted links to the conflict",
  pathOf(page),
  "/acme/demo/conflicts/C-1",
);
// While the probe is still running, a run Keel has not recorded is still to come, and none is said to be
// running: Keel says nothing of a run before it has ended. Two runs are in where the changes are composed.
await page.goto(at("/conflicts/C-1", "scenario=s1&t=443&play=0"), { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "World matrix" }).waitFor();
const composed = page.locator('.a-matrix tr[data-world="AB"]');
expectEqual(
  "conflict: a run Keel has not recorded is still to come, and none is said to be running",
  `${await composed.locator('[data-outcome="fail"]').count()} in, ${await composed.locator('[data-outcome="pending"]').count()} to come, ${await page.locator('.a-matrix [data-outcome="running"]').count()} running`,
  "2 in, 1 to come, 0 running",
);
// A probe's source is on its own tab, file by file, under the path Keel keeps it at.
await page.goto(at("/conflicts/C-1/probe", "scenario=s1&t=443&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("region", { name: "Probe P-1" }).waitFor();
await page
  .getByText("probes/authz.permission-evaluation/freshness.probe.ts")
  .first()
  .waitFor({ timeout: 5_000 })
  .catch(() => undefined);
expectEqual(
  "conflict: its probe's source, file by file",
  String(
    await page
      .getByRole("region", { name: "Probe P-1" })
      .getByText("probes/authz.permission-evaluation/freshness.probe.ts")
      .count(),
  ),
  "1",
);
// A conflict Keel suspected without naming a premise and an effect has a page all the same: its parties, how
// it was proven, and that Keel named no two sides. Scenario 2's is a change against a tenet on trunk.
await page.goto(at("/conflicts/C-2", "scenario=s2&t=200&play=0"), { waitUntil: "networkidle" });
// Whether it has a page is the thing looked for: the heading is given a moment, and what is there is compared.
await page
  .getByRole("heading", { level: 1 })
  .waitFor({ timeout: 5_000 })
  .catch(() => undefined);
expectEqual(
  "conflict: one with no sides has a page, which says Keel named none",
  [
    squash(
      await page
        .getByRole("heading", { level: 1 })
        .innerText({ timeout: 1_000 })
        .catch(() => "no page"),
    ),
    String(await page.getByText("Keel named no premise and no effect for this conflict.").count()),
    String(await page.getByText("a tenet on trunk").count()),
    String(await page.getByText("Proven by a guard").count()),
    String(await page.getByRole("heading", { name: "World matrix" }).count()),
  ].join(" | "),
  "authz.permission-evaluation · freshness C-2 | 1 | 1 | 1 | 0",
);
await page.goto(at("/conflicts/C-1", "scenario=s3&t=495&play=0"), { waitUntil: "networkidle" });
await page.locator(".a-timeline").waitFor();
expectEqual(
  "conflict: what happened says it was noted against each side, under which policy, by which event",
  (await page.locator(".a-timeline > li", { hasText: "Noted against" }).allInnerTexts())
    .map(squash)
    .map((line) => line.replace(/^[\d:]+ /, ""))
    .join(" | "),
  "Noted against #1 policy: advise ConflictNoted | Noted against #2 policy: advise ConflictNoted",
);
await page.goto(at("/changes/2", "scenario=s3&t=495&play=0"), { waitUntil: "networkidle" });
await standing.getByRole("heading", { level: 2 }).waitFor();
expectEqual(
  "change: the other side is noted too, and is still being verified",
  `${squash(await standing.getByRole("heading", { level: 2 }).innerText())} | ${String((await notedText()).startsWith("Noted C-1 advise on freshness"))}`,
  "No verdict yet | true",
);

// A ruling that goes against a change bounces it by the ruling's decision. The page names the decision, what it
// chose and the conflict it settled, gives Keel's reason in Keel's words, and shows no verdict as the cause.
const RULED = "scenario=s1&ruling=invalidate&t=473&play=0";
const RULED_WAYS = [
  "Revise the change's intent so that it no longer contradicts what was ruled",
  "Withdraw the change",
];
await page.goto(at("/changes/1", RULED), { waitUntil: "networkidle" });
await standing.getByRole("heading", { level: 2 }).waitFor();
expectEqual(
  "change: bounced on a ruling, it names the decision, and shows no verdict",
  `${squash(await standing.getByRole("heading", { level: 2 }).innerText())} | ${await standing.getByText(/^Issued/).count()}`,
  "Bounced on decision D-1 | 0",
);
expectEqual(
  "change: it says the ruling went against it, what the decision chose, and the conflict it settled",
  squash(await standing.locator("p").first().innerText()),
  "A ruling went against this change: decision D-1 chose “Cache allowed if revocation invalidates it”, on conflict C-1. It bounced on the ruling: no verdict was issued.",
);
expectEqual(
  "change: Keel's reason for a ruling's bounce, in Keel's words",
  (await standing.locator('[data-part="ruling-reasons"]').allInnerTexts()).map(squash).join(" | "),
  "Keel gave this reason: #1 revises to drop a session's cached roles on revocation. Both changes land. The probe stays as a guard.",
);
expectEqual(
  "change: the ways forward Keel gave the agent of a change a ruling went against",
  (
    await standing
      .getByRole("list", { name: "Ways forward Keel gave its agent" })
      .getByRole("listitem")
      .allInnerTexts()
  )
    .map(squash)
    .join(" | "),
  RULED_WAYS.join(" | "),
);
await follow(standing.getByRole("link", { name: "conflict C-1" }), "table.a-matrix");
expectEqual(
  "change: a ruling's bounce links to the conflict the ruling settled",
  pathOf(page),
  "/acme/demo/conflicts/C-1",
);
// The other side went on: the ruling did not go against it, and its page says nothing of one.
await page.goto(at("/changes/2", RULED), { waitUntil: "networkidle" });
await standing.getByRole("heading", { level: 2 }).waitFor();
expectEqual(
  "change: the side the ruling let stand is not said to have had it go against it",
  `${await standing.getByText(/A ruling went against this change/).count()} | ${await standing.locator('[data-part="ruling-reasons"]').count()}`,
  "0 | 0",
);

// What Keel told each side of a conflict is said in Keel's words, where one of its events told them anything.
const toldOn = async (fixture: string): Promise<string> => {
  await page.goto(at("/conflicts/C-1", fixture), { waitUntil: "networkidle" });
  await page.locator("table.a-matrix").waitFor();
  return (
    await page
      .getByText(/^Keel (bounced it on this conflict|noted this against it)/)
      .allInnerTexts()
  )
    .map(squash)
    .join(" | ");
};
const KEELS_WAYS =
  "Read the conflict and the proof against the change · Revise the change's intent around the conflict · Resolve the conflict with a move";
expectEqual(
  "conflict: each side bounced on it is said to be, with the ways forward Keel gave its agent",
  await toldOn("scenario=s4&t=460&play=0"),
  `Keel bounced it on this conflict, and told its agent: ${KEELS_WAYS} | Keel bounced it on this conflict, and told its agent: ${KEELS_WAYS}`,
);
expectEqual(
  "conflict: each side it was noted against is said to be, with the ways forward Keel gave",
  await toldOn("scenario=s3&t=495&play=0"),
  `Keel noted this against it, and told its agent: ${KEELS_WAYS} | Keel noted this against it, and told its agent: ${KEELS_WAYS}`,
);
expectEqual(
  "conflict: where Keel told a side nothing, the page says nothing for it",
  `${await toldOn("scenario=s1&t=470&ruling=live&play=0")}${await page.getByText(/Notice:/).count()}`,
  "0",
);
// The side a ruling went against says so, on its own row and on no other: the resolution names it.
const ruledOn = async (fixture: string): Promise<string> => {
  await page.goto(at("/conflicts/C-1", fixture), { waitUntil: "networkidle" });
  await page.locator("table.a-matrix").waitFor();
  const rows = page.locator("[data-party]");
  const said: string[] = [];
  for (const row of await rows.all()) {
    const line = row.getByText(/^The ruling went against it/);
    // oxlint-disable-next-line no-await-in-loop -- two rows, read in the page's order
    said.push(
      `${await row.getAttribute("data-party")}: ${(await line.allInnerTexts()).map(squash).join(" ")}`,
    );
  }
  return said.join(" | ");
};
expectEqual(
  "conflict: the side its ruling went against says so, with the decision and what Keel told its agent, and the other side says nothing",
  await ruledOn(RULED),
  `A:  | B: The ruling went against it: Keel bounced it on decision D-1, and told its agent: ${RULED_WAYS.join(" · ")}`,
);
expectEqual(
  "conflict: a ruling that lets the effect stand goes against the side that holds the premise",
  await ruledOn("scenario=s1&ruling=allow-stale&t=473&play=0"),
  `A: The ruling went against it: Keel bounced it on decision D-1, and told its agent: ${RULED_WAYS.join(" · ")} | B: `,
);
expectEqual(
  "conflict: before a ruling, no side is said to have had one go against it",
  await ruledOn("scenario=s1&t=470&ruling=live&play=0"),
  "A:  | B: ",
);

// The same intent. Three agents declared the same effect; Keel shows them to each other and picks none.
await page.goto(at("/changes/2", "scenario=s5&t=160&play=0"), { waitUntil: "networkidle" });
await standing.getByRole("heading", { level: 2 }).waitFor();
const same = page
  .locator("section", { has: page.getByRole("heading", { name: "Same intent" }) })
  .last();
const sameText = async (): Promise<string> =>
  (await same.count()) === 0 ? "no alternatives shown" : squash(await same.innerText());
expectEqual(
  "change: the others Keel told it have its intent, each as it stands now, in Keel's order",
  await sameText(),
  "Same intent #1 landed “Rate-limit the collaborators API” #3 working “Throttle the collaborators endpoints” Declared to do the same thing as this change. Keel shows them to each other and picks none. Set them side by side",
);
expectEqual(
  "change: they have a place of their own, counted on its tab",
  (
    await page
      .getByRole("navigation", { name: "Change" })
      .getByRole("link", { name: /Alternatives/ })
      .allInnerTexts()
  )
    .map(squash)
    .join(""),
  "Alternatives 2",
);
await follow(same.getByRole("link", { name: "Set them side by side" }), "table");
const compared = page.getByRole("table", { name: "This change and its alternatives" });
const rowsOf = async (): Promise<string> =>
  (await compared.locator("tbody tr").allInnerTexts()).map(squash).join(" | ");
expectEqual(
  "alternatives: this change and the others side by side, by state, verdict and conflicts, never ranked",
  `${pathOf(page)} | ${await rowsOf()}`,
  "/acme/demo/changes/2/alternatives | #2 this change “Add a rate limit to collaborator routes” hosted-112 HOSTED withdrawn none yet 0 09:30:24, revision 1 | #1 “Rate-limit the collaborators API” hosted-041 HOSTED landed Land, on 1 piece of evidence 0 09:30:10, revision 1 | #3 “Throttle the collaborators endpoints” hosted-207 HOSTED working none yet 0 09:30:41, revision 1",
);
expectEqual(
  "alternatives: the claim they share is given whole, with its unit and its scope",
  (
    await page
      .getByRole("list", { name: "What each of them declares" })
      .getByRole("listitem")
      .allInnerTexts()
  )
    .map(squash)
    .join(" | "),
  "api.collaborators/bound at most 100 requests/minute, per caller",
);
expectEqual(
  "alternatives: what Keel told this change's agent of each, in Keel's words",
  (
    await page
      .getByRole("list", { name: "What Keel told this change's agent" })
      .locator("> li")
      .allInnerTexts()
  )
    .map(squash)
    .join(" | "),
  "#1 has the same intent, and landed. Read the other change: its intent, its state and its evidence Read what is near your change, the other change included Rebase your change onto trunk as it is now Withdraw your change | #3 was declared with the same intent. Read the other change: its intent, its state and its evidence Read what is near your change, the other change included Rebase your change onto trunk as it is now Withdraw your change",
);
await follow(compared.getByRole("link", { name: "#1" }), 'section[aria-label="Verdict"]');
expectEqual(
  "alternatives: each one is a link to that change",
  pathOf(page),
  "/acme/demo/changes/1",
);
await page.goto(at("/changes/1/alternatives", "scenario=s5&t=160&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("navigation", { name: "Change" }).waitFor();
expectEqual(
  "alternatives: the change declared first lists the ones Keel told it of afterwards",
  (await compared.locator("tbody tr b.a-mono, tbody tr a.a-mono").allInnerTexts()).join(" "),
  "#1 #2 #3",
);
// Another limit on the same subject is another claim: that change has no alternatives, and no tab for them.
await page.goto(at("/changes/4", "scenario=s5&t=160&play=0"), { waitUntil: "networkidle" });
await standing.getByRole("heading", { level: 2 }).waitFor();
expectEqual(
  "change: one that shares a subject and not the claim is shown no alternatives",
  `${await sameText()} | ${await page
    .getByRole("navigation", { name: "Change" })
    .getByRole("link", { name: /Alternatives/ })
    .count()}`,
  "no alternatives shown | 0",
);

// The changes are listed, each under one filter.
await page.goto(at("/changes?state=landed", "scenario=s1&t=700&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("list", { name: "Changes, newest first" }).waitFor();
expectEqual(
  "changes: the filters, with how many under each",
  (
    await page
      .getByRole("navigation", { name: "Changes, by state" })
      .getByRole("link")
      .allInnerTexts()
  )
    .map(squash)
    .join(" | "),
  "In flight 0 | Parked 0 | Bounced 0 | Landed 2 | Not landed 0",
);
expectEqual(
  "changes: by Keel's numbers, newest first",
  (await page.locator(".a-list > li b.a-mono").allInnerTexts()).join(" "),
  "#2 #1",
);
await page.locator(".a-list-title a", { hasText: "Speed up permission checks" }).click();
await page.getByRole("heading", { name: "Derived by Keel" }).waitFor();
await page.goBack();
await page.getByRole("list", { name: "Changes, newest first" }).waitFor();
expectEqual(
  "changes: Back from a change returns to the list, under the filter it had",
  `${pathOf(page)}?state=${new URL(page.url()).searchParams.get("state") ?? ""}`,
  "/acme/demo/changes?state=landed",
);

// The code: the project's files with its README beneath, a file with the reasons beside its lines, and trunk's history.
await page.goto(at("", "scenario=s1&t=700&play=0"), { waitUntil: "networkidle" });
await page.locator(".a-prose h2").first().waitFor();
// Keel serves no clone address yet, and the console makes none up.
expectEqual("code: no clone address", String(await page.getByText("git clone").count()), "0");
expectEqual(
  "code: the root, directories first",
  (await page.locator(".a-tree li").allInnerTexts()).map(squash).join(" | "),
  "src | package.json | README.md",
);
expectEqual(
  "code: the README, read into headings",
  (await page.locator(".a-prose h2").allInnerTexts()).join(" | "),
  "Layout | Run",
);
const tree = page.getByRole("navigation", { name: "File tree" });
// The root is the whole list of files already, so nothing stands beside it.
expectEqual("code: no list of files beside the root", String(await tree.count()), "0");
await page.locator(".a-tree a", { hasText: "src" }).click();
await page.locator(".a-tree a", { hasText: "authz" }).click();
await page.locator(".a-tree a", { hasText: "cache.ts" }).click();
await page.locator("[data-why]").waitFor();
expectEqual(
  "code: a file's address can be shared",
  pathOf(page),
  "/acme/demo/blob/trunk/src/authz/cache.ts",
);
expectEqual(
  "code: why a line is as it is",
  (await page.locator("[data-why] li").allInnerTexts()).map(squash).join(" | "),
  "Decision D-1 Cache allowed if revocation invalidates it | Guard G-1 guards this since conflict C-1 was proven | Tenet T-1 trunk holds freshness per-request | Premise #1 relies on invariant is unchanged | Premise #2 relies on freshness at most per-request",
);
// Beside a file stand the files it sits among: the directories on the way to it open, the rest closed, and the file marked.
expectEqual(
  "code: the files beside a file",
  (await tree.locator("li").allInnerTexts()).map(squash).join(" | "),
  "src | authz | actions.ts | cache.ts | check.ts | roles.ts | collaborators | http.ts | package.json | README.md",
);
expectEqual(
  "code: the file being read is marked among them",
  squash(await tree.locator('[aria-current="page"]').innerText()),
  "cache.ts",
);
// A directory opens where it is, without going anywhere.
await tree.getByRole("button", { name: "Open src/collaborators" }).click();
await tree.getByRole("link", { name: "revoke.ts" }).waitFor();
expectEqual(
  "code: a directory opens beside the file, and the file stays",
  pathOf(page),
  "/acme/demo/blob/trunk/src/authz/cache.ts",
);
// Another file is one click away, and the list is as the reader left it.
await tree.getByRole("link", { name: "check.ts" }).click();
await page.waitForFunction(
  () =>
    document.querySelector('nav[aria-label="File tree"] [aria-current="page"]')?.textContent ===
    "check.ts",
);
expectEqual(
  "code: a file opened from the list beside",
  pathOf(page),
  "/acme/demo/blob/trunk/src/authz/check.ts",
);
expectEqual(
  "code: what the reader opened in the list is still open",
  String(await tree.getByRole("link", { name: "revoke.ts" }).count()),
  "1",
);
await tree.getByRole("button", { name: "Close src/collaborators" }).click();
expectEqual(
  "code: and a directory closes again",
  String(await tree.getByRole("link", { name: "revoke.ts" }).count()),
  "0",
);
await page.goBack();
await page.locator("[data-why]").waitFor();
expectEqual(
  "code: Back returns to the file before",
  squash(await tree.locator('[aria-current="page"]').innerText()),
  "cache.ts",
);

// Each place in the code is a page of its own: Back returns to the last.
await page.goBack();
await page.locator(".a-tree a", { hasText: "cache.ts" }).waitFor();
expectEqual("code: Back returns to the directory", pathOf(page), "/acme/demo/tree/trunk/src/authz");
await page.goForward();
await page.locator("[data-why] a", { hasText: "#2" }).click();
await page.getByRole("heading", { level: 1, name: /Owners can revoke collaborators/ }).waitFor();
expectEqual(
  "code: the change that holds a premise opens its page",
  pathOf(page),
  "/acme/demo/changes/2",
);
// A file's address opens the file from nowhere, dots and all. And an address that calls a file a directory is put right.
await page.goto(at("/blob/trunk/src/authz/cache.ts", "scenario=s1&t=700&play=0"), {
  waitUntil: "networkidle",
});
await page.locator("[data-why]").waitFor();
expectEqual("code: a file, opened cold", String(await page.locator("[data-why]").count()), "1");
await page.goto(at("/tree/trunk/src/authz/cache.ts", "scenario=s1&t=700&play=0"), {
  waitUntil: "networkidle",
});
await page.locator("[data-why]").waitFor();
expectEqual(
  "code: a file addressed as a directory is addressed as a file",
  pathOf(page),
  "/acme/demo/blob/trunk/src/authz/cache.ts",
);

await page.goto(at("/commits", "scenario=s1&t=700&play=0"), { waitUntil: "networkidle" });
await page.locator(".a-history li").first().waitFor();
expectEqual(
  "code: history, newest first, each commit with what it landed",
  (await page.locator(".a-history li").allInnerTexts())
    .map((row) => squash(row).replace(/ [0-9a-f]{7} \d{4}-.*$/, ""))
    .join(" | "),
  "Speed up permission checks landed #1 height 2 | Owners can revoke collaborators, effective immediately landed #2 height 1 | Start of trunk height 0",
);
await page.locator(".a-history a", { hasText: "Owners can revoke collaborators" }).click();
await page.getByText("Browse the files at this commit").waitFor();
expectEqual(
  "code: a commit has an address",
  String(/^\/acme\/demo\/commit\/[0-9a-f]+$/.test(pathOf(page))),
  "true",
);
expectEqual(
  "code: a commit's diff, file by file",
  (
    await page
      .locator("section.a-panel[aria-label]")
      .evaluateAll((sections) => sections.map((section) => section.getAttribute("aria-label")))
  ).join(" | "),
  "src/collaborators/revoke.ts | src/collaborators/routes.ts",
);
await page.getByText("Browse the files at this commit").click();
await page.locator(".a-tree li").first().waitFor();
expectEqual(
  "code: the files as they stood at that commit",
  String(await page.getByText("as it stood at").count()),
  "1",
);
await page.locator(".a-tree a", { hasText: "src" }).click();
await page.locator(".a-tree a", { hasText: "authz" }).click();
await page.locator(".a-tree a", { hasText: "check.ts" }).waitFor();
// The cache had not landed yet.
expectEqual(
  "code: at that commit there was no cache",
  (await page.locator(".a-tree li").allInnerTexts())
    .map(squash)
    .map((row) => row.split(" ")[0])
    .join(" | "),
  "actions.ts | check.ts | roles.ts",
);

// A fixture with no repository says so, and shows nothing in its place.
await page.goto(at("", "scenario=swarm&t=100&play=0"), { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "Keel has no code to show here" }).waitFor();
expectEqual(
  "code: nothing is shown where there is none",
  String(await page.locator(".a-tree, .a-clone").count()),
  "0",
);

// An address that names nothing says so, inside the project's frame, with the way back.
await page.goto(at("/nowhere", "scenario=s1&t=700&play=0"), { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "There is nothing at this address" }).waitFor();
expectEqual("missing: the frame is still there", String(await tabs.count()), "7");
await page.getByRole("link", { name: "Go to the project's code" }).click();
await page.locator(".a-prose h2").first().waitFor();
expectEqual("missing: the way back is the project's code", pathOf(page), "/acme/demo");
// The bare address is the home: the projects Keel names to this reader, each under its org, each a link to its own address.
await page.goto(`${dev}/?scenario=s1&t=700&play=0`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "Projects" }).waitFor();
const listed = page.getByRole("list", { name: "Projects" }).getByRole("link");
expectEqual(
  "the bare address lists the projects, each under its org",
  (await listed.allInnerTexts()).join(" "),
  "acme demo",
);
expectEqual("the bare address has no project's tabs", String(await tabs.count()), "0");
await listed.filter({ hasText: /^demo$/ }).click();
await page.locator(".a-prose h2").first().waitFor();
expectEqual(
  "a project in the list opens at its own address, still on the fixture",
  `${pathOf(page)} ${new URL(page.url()).searchParams.get("scenario")}`,
  "/acme/demo s1",
);
// And Back returns to the list, which has folded nothing of the project's since.
await page.goBack();
await page.getByRole("heading", { name: "Projects" }).waitFor();
expectEqual("Back from a project is the list of them", pathOf(page), "/");

// With nothing asked for, the page reads Keel, even in development. There is none behind the dev server, and it says so.
await page.goto(`${dev}/acme/demo`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "The console could not reach Keel" }).waitFor();
expectEqual(
  "dev, with no fixture asked for: none is shown",
  String(await page.locator(".a-root").count()),
  "0",
);
await page.goto(`${dev}/`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "Keel did not list its projects" }).waitFor();
expectEqual(
  "dev, with no fixture asked for: the home says what answered was not Keel, and lists nothing",
  `${squash(await page.getByRole("main").innerText())} | ${await page.getByRole("list", { name: "Projects" }).count()}`,
  "Keel did not list its projects What answered at /v1 was not Keel. | 0",
);

// Mission Control on the swarm, with six conflicts open at once. There is one lane to a subject and one column to
// each kind of thing; what a person is being asked about comes first; and nothing is left out for good.
const graph = at("/mission-control", "scenario=swarm&t=100&play=0");
await page.goto(graph, { waitUntil: "networkidle" });
await page.locator('.a-fn[data-kind="conflict"]').first().waitFor();
const leftOf = (kind: string): Promise<number[]> =>
  page
    .locator(`.a-fn[data-kind="${kind}"]`)
    .evaluateAll((nodes) => [
      ...new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().left))),
    ]);
expectEqual(
  "swarm: the columns, named",
  (await page.locator(".a-mission-head span").allInnerTexts()).join(" | "),
  "Agent | Change | Subject | Conflict | Probe | Outcome",
);
// Each kind of thing stands in one column, in every lane. What came of a conflict is in the last, whatever it was.
expectEqual("swarm: every conflict in one column", String((await leftOf("conflict")).length), "1");
expectEqual("swarm: every subject in one column", String((await leftOf("subject")).length), "1");
expectEqual(
  "swarm: a question and a guard share the column of what came of it",
  String((await leftOf("escalation"))[0] === (await leftOf("guard"))[0]),
  "true",
);
expectEqual(
  "swarm: drawn at no less than 0.8 of life size",
  String(Number(await page.locator(".a-mission").getAttribute("data-zoom")) >= 0.8),
  "true",
);
// Every open conflict is drawn. None is folded away where it cannot be reached.
expectEqual(
  "swarm: conflicts drawn",
  String(await page.locator('.a-fn[data-kind="conflict"]').count()),
  "6",
);
expectEqual(
  "swarm: the lane of what a person is being asked about comes first",
  String(
    squash(await page.locator('.a-fn[data-kind="subject"]').first().innerText()).includes(
      "storage.gc.safety",
    ),
  ),
  "true",
);
// The load generator's agents are counted, and called what they are. They are not a node with a line to everything.
expectEqual(
  "swarm: the agents, counted above the graph",
  squash(await page.locator("[data-working]").innerText()),
  "3 REAL · 800 SYNTHETIC agents · 736 changes open",
);
expectEqual(
  "swarm: and the Changes tab counts the same changes as open",
  squash(await tabs.filter({ hasText: "Changes" }).innerText()),
  "Changes 736 open",
);
expectEqual(
  "swarm: none of them is called hosted",
  String(await page.getByText("HOSTED").count()),
  "0",
);
expectEqual(
  "swarm: the question a person is being asked is drawn",
  String(await page.locator('.a-fn[data-kind="escalation"]').count()),
  "1",
);
expectEqual(
  "swarm: the question says what stands until it is answered",
  String(
    await page
      .locator('.a-fn[data-kind="escalation"]')
      .getByText("Until answered: The change waits.")
      .count(),
  ),
  "1",
);
// The names of the columns stay where they are while the lanes go by beneath them.
const headAt = (): Promise<number> =>
  page.locator(".a-mission-head").evaluate((head) => Math.round(head.getBoundingClientRect().top));
const headBefore = await headAt();
await page.locator(".a-mission").evaluate((scroller) => scroller.scrollTo({ top: 900 }));
expectEqual(
  "swarm: the lanes scroll",
  String(await page.locator(".a-mission").evaluate((scroller) => scroller.scrollTop > 0)),
  "true",
);
expectEqual("swarm: the columns' names stay put", String((await headAt()) === headBefore), "true");
// A lane with nothing contested is one line, until it is opened. Opened, it draws its subject; closed again, it is one line.
const quiet = page.locator('button.a-lane[data-open="false"]');
const quietBefore = await quiet.count();
const subjectsBefore = await page.locator('.a-fn[data-kind="subject"]').count();
expectEqual("swarm: quiet lanes are one line each", String(quietBefore > 0), "true");
const opening = (await quiet.first().getAttribute("data-lane")) ?? "";
// What the row says is its name to whoever cannot see it: the subject, and how much is going on there.
expectEqual(
  "swarm: a quiet lane says what is on it",
  String(/\d+ changes?/.test(squash(await quiet.first().innerText()))),
  "true",
);
await quiet.first().click();
await page.waitForFunction(
  (before) => document.querySelectorAll('.a-fn[data-kind="subject"]').length === before + 1,
  subjectsBefore,
);
expectEqual(
  "swarm: a lane opens when asked",
  `${await quiet.count()} closed, ${await page.locator('.a-fn[data-kind="subject"]').count()} subjects drawn`,
  `${quietBefore - 1} closed, ${subjectsBefore + 1} subjects drawn`,
);
await page.getByRole("button", { name: `Close the lane of ${opening}` }).click();
await page.waitForFunction(
  (before) => document.querySelectorAll('.a-fn[data-kind="subject"]').length === before,
  subjectsBefore,
);
expectEqual("swarm: and closes again", String(await quiet.count()), String(quietBefore));
// The lanes not shown are said, with what is on them, and shown when asked for.
const lanesBefore = await page.locator(".a-lane").count();
await page.getByRole("button", { name: /^Show \d+ more subjects/ }).click();
await page.waitForFunction(
  (before) => document.querySelectorAll(".a-lane").length > before,
  lanesBefore,
);
expectEqual(
  "swarm: more lanes, when asked for",
  String((await page.locator(".a-lane").count()) > lanesBefore),
  "true",
);

// While the log plays, things arrive and leave. The graph is drawn at the size it was, where it was: nothing re-fits.
await page.goto(at("/mission-control", "scenario=swarm&t=60&speed=4"), {
  waitUntil: "networkidle",
});
await page.locator('.a-fn[data-kind="subject"]').first().waitFor();
const framed = (): Promise<string> =>
  page.locator(".react-flow__viewport").evaluate((element) => getComputedStyle(element).transform);
const [frameBefore, nodesBefore] = [
  await framed(),
  await page
    .locator(".a-fn")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") ?? "").join()),
];
await page.waitForFunction(
  (before) =>
    [...document.querySelectorAll(".a-fn")]
      .map((node) => node.getAttribute("href") ?? "")
      .join() !== before,
  nodesBefore,
  { timeout: 20_000 },
);
expectEqual(
  "swarm, playing: the graph is not re-framed when something arrives",
  await framed(),
  frameBefore,
);

// A subject opens beside the graph; its address can be shared; a conflict in it leads to the conflict's page.
await page.goto(graph, { waitUntil: "networkidle" });
await page.locator('.a-fn[data-kind="subject"]', { hasText: "storage.gc.safety" }).click();
const panel = page.getByRole("complementary", { name: "Subject storage.gc.safety" });
await panel.waitFor();
expectEqual("subject: named in the address", pathOf(page), "/acme/demo/subjects/storage.gc.safety");
expectEqual(
  "subject: premises, by what they say",
  (await panel.locator("section").first().locator("li").allInnerTexts()).map(squash).join(" | "),
  "cardinality at most exactly-once 22 open · 22 landed | cardinality at most at-most-once 11 open · 12 landed",
);
expectEqual(
  "subject: changes in flight",
  squash(await panel.locator("section").last().locator("header").innerText()),
  "Changes 33 open",
);
expectEqual(
  "subject: marked on the graph",
  String(await page.locator('.a-fn[data-selected="true"]').count()),
  "1",
);
// It stands beside the graph, not over it: the subject it is about is still to be seen.
expectEqual(
  "subject: beside the graph, not over it",
  String(
    (await page
      .locator('.a-fn[data-selected="true"]')
      .evaluate((node) => node.getBoundingClientRect().right)) <=
      (await panel.evaluate((aside) => aside.getBoundingClientRect().left)),
  ),
  "true",
);
await panel.getByRole("link", { name: /C-7/ }).click();
await page.getByRole("heading", { name: "World matrix" }).waitFor();
expectEqual(
  "subject: its conflict opens on the conflict's page",
  pathOf(page),
  "/acme/demo/conflicts/C-7",
);
await page.goBack();
await panel.waitFor();
expectEqual(
  "subject: Back returns to it, open as it was",
  pathOf(page),
  "/acme/demo/subjects/storage.gc.safety",
);
// A subject's address opens it from nowhere, dots and all.
await page.goto(at("/subjects/storage.gc.safety", "scenario=swarm&t=100&play=0"), {
  waitUntil: "networkidle",
});
await panel.waitFor();
// The graph is a file of its own and is drawn a moment after the panel beside it: waited for, and read either way.
await graphDrawn(page);
expectEqual(
  "subject: opened cold",
  String(await page.locator('.a-fn[data-selected="true"]').count()),
  "1",
);

// A subject whose lane comes after those first shown: opened from its address, its lane is shown all the same, and marked.
await page.goto(graph, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /^Show \d+ more subjects/ }).waitFor();
const shownAtFirst = await page
  .locator(".a-lane")
  .evaluateAll((lanes) => lanes.map((lane) => lane.getAttribute("data-lane") ?? ""));
await page.getByRole("button", { name: /^Show \d+ more subjects/ }).click();
await page.waitForFunction(
  (before) => document.querySelectorAll(".a-lane").length > before,
  shownAtFirst.length,
);
const far =
  (
    await page
      .locator(".a-lane")
      .evaluateAll((lanes) => lanes.map((lane) => lane.getAttribute("data-lane") ?? ""))
  ).find((key) => !shownAtFirst.includes(key)) ?? "";
await page.goto(at(`/subjects/${far}`, "scenario=swarm&t=100&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("complementary", { name: `Subject ${far}` }).waitFor();
await graphDrawn(page);
expectEqual(
  "subject: one far down the list has its lane shown when it is opened",
  String(await page.locator('.a-fn[data-selected="true"]').count()),
  "1",
);
// It is brought to the reader a few frames after it is drawn.
await page
  .waitForFunction(
    () => {
      const box = document.querySelector('.a-fn[data-selected="true"]')?.getBoundingClientRect();
      return box !== undefined && box.top >= 0 && box.bottom <= window.innerHeight;
    },
    undefined,
    { timeout: 5_000 },
  )
  .catch(() => undefined);
expectEqual(
  "subject: and is brought into view",
  String(
    await page.locator('.a-fn[data-selected="true"]').evaluate((node) => {
      const box = node.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    }),
  ),
  "true",
);
// A subject Keel has not heard of says so, where its panel would be.
await page.goto(at("/subjects/no.such.subject", "scenario=swarm&t=100&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("complementary", { name: "Subject no.such.subject" }).waitFor();
expectEqual(
  "subject: one Keel has not heard of says so",
  String(
    await page
      .getByRole("complementary", { name: "Subject no.such.subject" })
      .getByText("Keel has said nothing about a subject of this name")
      .count(),
  ),
  "1",
);

// A change stands in one lane and is counted there. In the lane of each other subject it touches it is shown
// again, as a reference to it. In scenario 1 the first change comes back relying on a second subject, which Keel
// mints at an agent's first word about it.
await page.goto(at("/mission-control", "scenario=s1&t=8:30&play=0"), { waitUntil: "networkidle" });
await page.locator('.a-fn[data-kind="subject"]').first().waitFor({ timeout: 20_000 });
const reference = page.locator('.a-fn[data-kind="reference"]');
expectEqual(
  "graph: a change that relies on a second subject is shown in that subject's lane too, with what ties it there",
  squash((await reference.allInnerTexts()).join(" / ")),
  "Change #1 working relies on: is true in the lane of authz.permission-evaluation",
);
expectEqual(
  "graph: and it stands inside the band of the subject it relies on",
  String(
    await page.evaluate(() => {
      const band = document
        .querySelector('.a-lane[data-lane="collab.revocation"]')
        ?.getBoundingClientRect();
      const box = document.querySelector('.a-fn[data-kind="reference"]')?.getBoundingClientRect();
      return (
        band !== undefined && box !== undefined && box.top >= band.top && box.bottom <= band.bottom
      );
    }),
  ),
  "true",
);
expectEqual(
  "graph: the change itself is drawn once, with its agent beside it, and counted once",
  `${await page.locator('.a-fn[data-kind="change"]').count()} change, ${await page.locator('.a-fn[data-kind="agent"]').count()} agent, ${squash(await page.locator("[data-working]").innerText())}`,
  "1 change, 1 agent, 2 REAL agents · 1 change open",
);
expectEqual(
  "graph: a subject's counts stay on one line when it has premises, a guard and a decision",
  String(
    await page
      .locator('.a-fn[data-kind="subject"] [data-counts]')
      .first()
      .evaluate((row) => row.getBoundingClientRect().height <= 22),
  ),
  "true",
);
// Closed, that lane says that what it shows is another lane's change.
await page
  .locator('.a-lane[data-lane="collab.revocation"] .a-lane-toggle')
  .click({ timeout: 5000 })
  .catch(() => {});
const closedLane = page.locator('button.a-lane[data-lane="collab.revocation"]');
await closedLane.waitFor({ timeout: 5000 }).catch(() => {});
expectEqual(
  "graph: a closed lane counts no change as its own, and says one of another lane touches it",
  squash((await closedLane.allInnerTexts()).join(" / ")).includes("0 changes · 1 from another lane")
    ? "said"
    : squash((await closedLane.allInnerTexts()).join(" / ")),
  "said",
);
await closedLane.click({ timeout: 5000 }).catch(() => {});
await reference
  .first()
  .click({ timeout: 5000 })
  .catch(() => {});
await page.waitForURL("**/acme/demo/changes/1**", { timeout: 5000 }).catch(() => {});
expectEqual("graph: a reference opens the change's own page", pathOf(page), "/acme/demo/changes/1");

// The graph's size is measured from the room there is, even where the page opened with nothing to draw.
await page.setViewportSize({ width: 1400, height: 900 });
await page.goto(at("/mission-control", "scenario=s1&t=20&speed=16"), { waitUntil: "networkidle" });
await page.locator('.a-fn[data-kind="subject"]').first().waitFor({ timeout: 20_000 });
expectEqual(
  "graph: sized to a narrower window though it opened empty",
  String(Number(await page.locator(".a-mission").getAttribute("data-zoom")) < 1),
  "true",
);
await page.setViewportSize({ width: 1920, height: 1080 });

// A change and a conflict open from the graph too.
await page.goto(graph, { waitUntil: "networkidle" });
// A change is named by Keel's own number for it.
await page.locator('.a-fn[data-kind="change"]', { hasText: "#496" }).click();
await page.getByRole("navigation", { name: "Change" }).waitFor();
expectEqual("graph: a change opens its page", pathOf(page), "/acme/demo/changes/496");
await page.goto(graph, { waitUntil: "networkidle" });
await page.locator('.a-fn[data-kind="conflict"]', { hasText: "C-13" }).click();
await page.getByRole("heading", { name: "World matrix" }).waitFor();
expectEqual("graph: a conflict opens its page", pathOf(page), "/acme/demo/conflicts/C-13");

// At scale a list shows a page at a time, and says how to see more.
await page.goto(at("/changes", "scenario=swarm&t=100&play=0"), { waitUntil: "networkidle" });
await page.getByRole("list", { name: "Changes, newest first" }).waitFor();
expectEqual(
  "swarm changes: a page of rows",
  String(await page.locator(".a-list > li").count()),
  "50",
);
await page.getByRole("link", { name: /^Show \d+ more$/ }).click();
await page.waitForFunction(() => document.querySelectorAll(".a-list > li").length === 100);
expectEqual(
  "swarm changes: more, at an address that says how many",
  new URL(page.url()).searchParams.get("shown") ?? "",
  "100",
);

// ── Agents: who Keel's log names as having written here, and each one's runs ──
// Scenario 1 at the question. Agent B declared #1 under a token that named no run, and Agent A declared #2 under
// the run it called collab-revocation. A fixture has no cards, so each is named as the log enrolled it.
const AGENTS = "Agents, the one that wrote last first";
/** Each row of the agents' list: its name, what it says beside Keel's id and the time, and what it holds. */
const agentRows = (shown: Page): Promise<string> =>
  shown
    .getByRole("list", { name: AGENTS })
    .getByRole("listitem")
    .evaluateAll((rows) =>
      rows
        .map((row) =>
          [
            row.querySelector(".a-list-title")?.textContent ?? "",
            [...row.querySelectorAll(".a-list-title + div > *")]
              .filter((part) => !part.matches("span.a-mono") && part.querySelector("time") === null)
              .map((part) => part.textContent ?? "")
              .join(", "),
            [...row.querySelectorAll(".a-chip")].map((chip) => chip.textContent ?? "").join(" "),
          ].join(" | "),
        )
        .join(" || "),
    );
await page.goto(at("/agents", "scenario=s1&t=470&ruling=live&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("heading", { level: 1, name: "Agents" }).waitFor();
expectEqual(
  "agents: one row for each agent the log names, with its runs here and the changes it holds",
  await agentRows(page),
  "Agent A | 1 run here | #2 1 change || Agent B | no run named | #1 1 change",
);
expectEqual(
  "agents: the tab is where the reader is, and the page says how an agent joins and makes no credential",
  `${await tabs.filter({ hasText: "Agents" }).getAttribute("aria-current")} | ${await page.getByText("No credential is made here.").count()} | ${await page
    .getByRole("button")
    .filter({ hasText: /credential|enrol|mint/i })
    .count()} buttons`,
  "page | 1 | 0 buttons",
);
// An agent's own page in the project: its runs, each a part of the page with a place of its own.
await page.getByRole("list", { name: AGENTS }).getByRole("link", { name: "Agent A" }).click();
await page.getByRole("heading", { level: 1 }).waitFor();
const runsOn = async (shown: Page): Promise<string> =>
  (
    await shown.locator("section.a-panel").evaluateAll((sections) =>
      sections.map((section) =>
        [
          section.id,
          section.querySelector("h2")?.textContent ?? "",
          [...section.querySelectorAll("header p > span")]
            .filter((part) => part.querySelector("time") === null)
            .map((part) => part.textContent ?? "")
            .join(", "),
          [...section.querySelectorAll("li")]
            .map((held) => (held.textContent ?? "").replaceAll(/\s+/g, " ").trim())
            .join("; "),
        ].join(" | "),
      ),
    )
  ).join(" || ");
expectEqual(
  "agent: its run is named in its own words and said to be its own, with Keel's id for it and the change it holds",
  `${squash(await page.getByRole("heading", { level: 1 }).innerText())} | ${await runsOn(page)}`,
  "Agent A | run-run_0000000000000000000000ACDE | “collab-revocation” | as the agent named it, run_0000000000000000000000ACDE, 2 entries of the log | #2Owners can revoke collaborators, effective immediatelyparked",
);
await page.goBack();
await page.getByRole("list", { name: AGENTS }).getByRole("link", { name: "Agent B" }).click();
await page.getByRole("heading", { level: 1, name: "Agent B" }).waitFor();
expectEqual(
  "agent: work under a token that named no run is listed as that, and under no run",
  `${await runsOn(page)} | ${await page.getByText("Work under a token that named no run: 2 entries of the log.").count()}`,
  " | No run named |  | #1Speed up permission checksparked | 1",
);
// A change says which run holds it, on its row and on its page, and each is a link to that run's place.
await page.goto(at("/changes?state=parked", "scenario=s1&t=470&ruling=live&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("list", { name: "Changes, newest first" }).waitFor();
const runLinks = (shown: Page): Promise<string> =>
  shown
    .getByRole("link", { name: /^in (its run|a run)/ })
    .evaluateAll((links) =>
      links
        .map((link) =>
          link instanceof HTMLAnchorElement
            ? `${link.textContent ?? ""} -> ${new URL(link.href).pathname.replace(/agt_[0-9A-Z]+/, "{agent}")}${new URL(link.href).hash}`
            : "not a link",
        )
        .join(" || "),
    );
expectEqual(
  "changes: the row of a change held under a run says which, and links to it; one held under none says nothing",
  await runLinks(page),
  "in its run “collab-revocation” -> /acme/demo/agents/{agent}#run-run_0000000000000000000000ACDE",
);
await page.goto(at("/changes/2", "scenario=s1&t=470&ruling=live&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("heading", { level: 1 }).waitFor();
expectEqual(
  "change: its page says which run holds it, and its agent's name is a link to the agent's page here",
  `${await runLinks(page)} | ${await page
    .getByRole("link", { name: /Agent A/ })
    .first()
    .evaluate((link) =>
      link instanceof HTMLAnchorElement
        ? new URL(link.href).pathname.replace(/agt_[0-9A-Z]+/, "{agent}")
        : "not a link",
    )}`,
  "in its run “collab-revocation” -> /acme/demo/agents/{agent}#run-run_0000000000000000000000ACDE | /acme/demo/agents/{agent}",
);
await page.getByRole("link", { name: /^in its run/ }).click();
await page.getByRole("heading", { level: 1, name: "Agent A" }).waitFor();
expectEqual(
  "change: the link to its run lands on the agent's page with the run's place in the address",
  `${new URL(page.url()).pathname.replace(/agt_[0-9A-Z]+/, "{agent}")}${new URL(page.url()).hash} | ${await page.locator("#run-run_0000000000000000000000ACDE").count()}`,
  "/acme/demo/agents/{agent}#run-run_0000000000000000000000ACDE | 1",
);
// A name the log gives no agent is said to be that, and nothing is made up for it.
await page.goto(at("/agents/nobody", "scenario=s1&t=470&ruling=live&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("heading", { level: 1 }).first().waitFor();
expectEqual(
  "agent: a name the log gives no agent is told as that",
  `${await page.getByText("Keel's log names no agent nobody in this project").count()} | ${await page.locator("section.a-panel").count()} runs`,
  "1 | 0 runs",
);
// Mission Control's agent node says the run its change is held under, where the agent named one.
await page.goto(at("/mission-control", "scenario=s1&t=470&ruling=live&play=0"), {
  waitUntil: "networkidle",
});
await graphDrawn(page);
expectEqual(
  "mission control: an agent beside its change says the run it named, and one that named none says none",
  `${await page.getByText("run “collab-revocation”").count()} | ${await page.getByText(/run “/).count()}`,
  "1 | 1",
);

// Insights: trunk's numbers with what each means, the review funnel, and the benchmark where a run was sealed.
// A change a ruling went against is counted where it had got to, under that cause and no other.
await page.goto(at("/insights/funnel", RULED), { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "Review funnel" }).waitFor();
expectEqual(
  "funnel: a change bounced on a ruling is counted under that cause, at the stage it had got to",
  `${await stat("Changes bounced")} | ${await stage("changes", 1)}`,
  "1 | 2 | 1 50.0% 1 left here, 1 still here 1 bounced on a ruling · 1 still here | 0 | —",
);
await page.goto(at("/insights", "scenario=swarm&t=95&play=0"), { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "Trunk" }).waitFor();
expectEqual(
  "insights: its pages, beside each other",
  (await page.getByRole("navigation", { name: "Insights" }).getByRole("link").allInnerTexts())
    .map(squash)
    .join(" | "),
  "Trunk | Review funnel | Benchmark",
);
expectEqual(
  "insights: trunk's numbers, each named",
  (await page.locator("table.a-stats th").allInnerTexts()).map(squash).join(" | "),
  "Trunk red | Advances | Landed per minute | p50 time-to-land | People asked / changes landed | Head",
);
await page
  .getByRole("navigation", { name: "Insights" })
  .getByRole("link", { name: "Review funnel" })
  .click();

// The review funnel on the swarm: what each stage settled, read off the page.
await page.getByRole("heading", { name: "Review funnel" }).waitFor();
expectEqual("funnel: at its own address", pathOf(page), "/acme/demo/insights/funnel");
expectEqual(
  "funnel: the changes, the conflicts and the comparisons, each under its own heading",
  (await page.getByRole("heading", { level: 2 }).allInnerTexts()).map(squash).join(" | "),
  "Changes | Conflicts | Comparisons",
);
// The changes first: how many Keel's events took as far as each stage, and what became of the rest.
expectEqual(
  "funnel: a change's four stages, by name",
  (await funnelRows(page, "changes").locator("th span").allInnerTexts()).map(squash).join(" | "),
  "Declared | Precheck | Verified | Landed",
);
expectEqual("funnel: changes landed, of those declared", await stat("Changes landed"), "692");
expectEqual("funnel: changes Keel bounced", await stat("Changes bounced"), "7");
expectEqual(
  "funnel: declared, and how many went on to a precheck",
  await stage("changes", 0),
  "1,420 | 0 0% 363 still here, 1,057 went on 363 still here | 1,057 | —",
);
expectEqual(
  "funnel: precheck, with what left there under the cause Keel named",
  await stage("changes", 1),
  "1,057 | 3 0.3% 3 left here, 358 still here, 696 went on 3 bounced on a verdict · 358 still here, 1 of them parked | 696 | —",
);
expectEqual(
  "funnel: verified, with Keel's estimate for its plans worded as an estimate",
  await stage("changes", 2),
  "696 | 0 0% 4 still here, 692 went on 4 still here | 692 | Keel's estimate $5.48 for 1,051 plans, before any ran",
);
expectEqual("funnel: landed", await stage("changes", 3), "692 |  |  | —");
// The comparison counters are the fixture's own: they keep a heading of their own, and their stages a number.
expectEqual(
  "stages in the funnel",
  `${await funnelRows(page, "conflicts").count()} + ${await funnelRows(page, "comparisons").count()}`,
  "2 + 4",
);
expectEqual(
  "stages are named as stages",
  squash(await funnelRows(page, "comparisons").nth(2).locator("th").innerText()).slice(0, 12),
  "Stage 2 Clef",
);
expectEqual(
  "funnel: a conflict's two stages go by name",
  squash(await funnelRows(page, "conflicts").nth(0).locator("th").innerText()).slice(0, 11),
  "Probe Proof",
);
expectEqual("comparisons per change", await stat("Comparisons per change"), "2.4");
expectEqual(
  "subject index",
  await stage("comparisons", 0),
  "1,004,556 | 1,002,025 99.7% 1,002,025 settled here, 2,531 passed on | 2,531 | $0.00016",
);
expectEqual(
  "lattice",
  await stage("comparisons", 1),
  "2,531 | 2,146 84.8% 2,146 settled here, 385 passed on | 385 | $0",
);
expectEqual(
  "code model, one probe still being drafted",
  await stage("comparisons", 3),
  "16 | 0 0% 1 still here, 15 passed on 1 still here | 15 | $0.014",
);
expectEqual(
  "probe, four still deciding",
  await stage("conflicts", 0),
  "15 | 10 66.7% 10 settled here, 4 still here, 1 passed on 3 dismissed as false alarms · 7 proven · 4 still here | 1 | $0.011",
);
expectEqual(
  "a person, being asked",
  await stage("conflicts", 1),
  "1 | 0 0% 1 waiting for a person 1 waiting for a person Open the escalations |  | a person's time",
);

// The benchmark: sealed while the run is on, and unsealed at its end with the seal checked in this browser.
await page.goto(at("/insights/benchmark", "scenario=swarm&t=95&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("heading", { name: "Benchmark" }).waitFor();
expectEqual(
  "sealed: what is shown",
  String(await page.getByRole("heading", { name: "Sealed: 13 planted, 8 decoys" }).count()),
  "1",
);
expectEqual(
  "sealed: manifest rows shown",
  String(await page.locator("table.a-score tbody tr").count()),
  "0",
);
await page.goto(at("/insights/benchmark", "scenario=swarm&t=185&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("heading", { name: "The manifest, unsealed" }).waitFor();
await page.getByText("Holds").or(page.getByText("Broken")).first().waitFor();
expectEqual("unsealed: the seal", await stat("Seal"), "Holds");
expectEqual(
  "unsealed: planted disagreements caught",
  await stat("Planted disagreements caught"),
  "12 of 13",
);
expectEqual("unsealed: missed", await stat("Missed"), "1");
expectEqual("unsealed: decoys proven by mistake", await stat("Decoys proven by mistake"), "0 of 8");
expectEqual(
  "unsealed: manifest rows",
  String(await page.locator("table.a-score tbody tr").count()),
  "21",
);
expectEqual(
  "unsealed: the miss leads, and is explained",
  squash(await page.locator("table.a-score tbody tr").first().innerText()),
  "M-13Planted api.rate-limit.bound synthetic-575 relies on freshness at most per-call. synthetic-590 makes it per-request. missed Nothing was raised. Clef derived freshness is per-call (p = 0.59), and no extractor applied. Both changes landed. The change",
);

// A phone gets the same pages as a desk: the frame, every tab, and a question whose options can be tapped. Nothing
// runs off the side of the screen, where a thumb would have to go looking for it.
const pocket = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const narrow = watch(await pocket.newPage(), "fixture, narrow");
/** How far the page runs past the right edge of the screen, in pixels. */
const overflowOf = (shown: Page): Promise<number> =>
  shown.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await narrow.goto(at("/escalations/E-1", "scenario=s1&t=472&ruling=live"), {
  waitUntil: "networkidle",
});
await narrow
  .getByRole("heading", { name: "May permission checks be cached within a session?" })
  .waitFor();
expectEqual("narrow: the same frame, with every tab", String(await tabsOf(narrow).count()), "7");
expectEqual(
  "narrow: a question's page stays within the screen",
  String(await overflowOf(narrow)),
  "0",
);
expectEqual(
  "narrow: options to tap",
  String(await narrow.locator(".a-option:enabled").count()),
  "3",
);
// The tabs are wider than a phone. They scroll where they are, by a thumb, and at the far end the last is whole.
expectEqual(
  "narrow: the tabs scroll where they are, to the last of them",
  await narrow.getByRole("navigation", { name: "Project" }).evaluate((row) => {
    const scrolls = ["auto", "scroll"].includes(window.getComputedStyle(row).overflowX);
    row.scrollLeft = row.scrollWidth;
    const last = row.lastElementChild?.getBoundingClientRect();
    return `${scrolls ? "they scroll" : "they do not scroll"}, the last ${last !== undefined && last.left >= 0 && last.right <= window.innerWidth ? "whole" : "cut off"}`;
  }),
  "they scroll, the last whole",
);
// The top row wraps: what the page is reading stays on the screen, under where the reader is.
expectEqual(
  "narrow: the frame's top row is all on the screen",
  await narrow
    .locator("header")
    .first()
    .getByText("Test fixture")
    .evaluate((mark) => {
      const box = mark.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth ? "on the screen" : "cut off";
    }),
  "on the screen",
);
for (const place of ["", "/changes", "/conflicts/C-1", "/mission-control"]) {
  await narrow.goto(at(place, "scenario=s1&t=700&play=0"), { waitUntil: "networkidle" });
  expectEqual(
    `narrow: ${place === "" ? "the code" : place} stays within the screen`,
    String(await overflowOf(narrow)),
    "0",
  );
}
await pocket.close();

// ─────────────────────────────────────────────────────────────────────────────
// The built console, as it is deployed: one page, reading Keel on its own origin
// ─────────────────────────────────────────────────────────────────────────────
// As deployed, the console's Worker serves the page and nothing else, and Keel answers /v1 on the same origin.
// So here the build is served, and what the page asks of /v1 is answered by stand-ins (test code only): the real
// Better Auth for /v1/auth, and a stand-in Keel for the rest, which knows a reader by their session, as Keel does.
await build({ logLevel: "silent" });
const served = await preview({
  preview: { port: BUILT_PORT, strictPort: true },
  logLevel: "silent",
});

const identity = createIdentity(built);
/** The namespace the stand-in's project is in: Ada's own, a person's, once she has signed up below. */
const NAMESPACE = { handle: "ada", kind: "user" } as const;

/** Who a request is from, as Keel's gate reads it: asked of its identity by the session the browser sent. */
const readerOf = async (request: Request): Promise<Reader> => {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  const asThem = createAccount({
    origin: built,
    fetch: (input, init) => {
      const asked = new Request(input, init);
      const headers = new Headers(asked.headers);
      headers.set("cookie", cookie);
      headers.set("origin", built);
      return identity.handle(new Request(asked, { headers }));
    },
  });
  const who = await asThem.who().catch(() => null);
  if (who === null) return null;
  // A person's own namespace has nobody in it but them: Keel reads them as its owner, and anyone else as no member.
  // Keel knows a reader by their account: whose a namespace is, and whose a project it made is, turn on it.
  return who.handle === NAMESPACE.handle ? { role: "owner", id: who.id } : { id: who.id };
};

// Two Keels, alike but for who may read the project: on one its org has made it public, on the other it has not.
// On each, 1,200 entries of other projects lie ahead of this one's in the instance's log, as they do for every
// project of a Keel but its first: a stretch of them is an empty page whose cursor has moved on.
const AHEAD = 1200;
/** Whose a handle is: the identity knows who signed up and which orgs were made. */
const whoseHandle = (handle: string) => identity.whose(handle);
const open = createFakeKeel({
  namespace: NAMESPACE,
  visibility: "public",
  readerOf,
  whose: whoseHandle,
  roleIn: (userId, org) => identity.roleIn(userId, org),
  ahead: AHEAD,
});
const shut = createFakeKeel({
  namespace: NAMESPACE,
  visibility: "private",
  readerOf,
  whose: whoseHandle,
  roleIn: (userId, org) => identity.roleIn(userId, org),
  ahead: AHEAD,
});

/** What the page sent to /v1, as the browser sent it. */
interface Sent {
  path: string;
  authorization: string | undefined;
}

interface Deployed {
  keel: Pick<FakeKeel, "fetch">;
  /** Keel's identity. The one every person here signs up on, unless another is named. */
  identity?: Pick<Identity, "handle">;
  sent?: Sent[];
  /** Holds Keel's answer to a request back for as long as it takes to settle. */
  hold?: (path: string) => Promise<void>;
}

async function asDeployed(context: BrowserContext, deployed: Deployed): Promise<void> {
  const { keel, sent = [], hold } = deployed;
  const auth = deployed.identity ?? identity;
  // As deployed, an address that is not one of the build's files gets the page: the Worker's assets are set to answer
  // so. The preview server does that only where the address has no dot in it, so the same is done for it here.
  await context.route(
    (url) => url.origin === built && url.pathname !== "/" && !/^\/(v1|assets)\//.test(url.pathname),
    async (route) => {
      if (!route.request().isNavigationRequest()) return route.fallback();
      const index = await route.fetch({ url: `${built}/index.html` });
      return route.fulfill({ response: index });
    },
  );
  await context.route(new RegExp(`^${built}/v1/`), async (route) => {
    const request = route.request();
    const headers = await request.allHeaders();
    delete headers["content-length"];
    delete headers["host"];
    const { pathname } = new URL(request.url());
    sent.push({
      path: pathname,
      authorization: headers["authorization"],
    });
    const posted = request.postData();
    const asked = new Request(request.url(), {
      method: request.method(),
      headers,
      ...(posted === null ? {} : { body: posted }),
    });
    await hold?.(pathname);
    const response = await (pathname.startsWith("/v1/auth/")
      ? auth.handle(asked)
      : keel.fetch(asked));
    const answered = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) answered["set-cookie"] = cookies.join("\n");
    // A page that has gone away no longer wants its answer.
    await route
      .fulfill({ status: response.status, headers: answered, body: await response.text() })
      .catch(() => undefined);
  });
}

const OPEN_ON_TABS =
  "Code | Changes 2 open | Conflicts 1 open | Escalations 1 waiting for a person | Mission Control | Agents | Insights";
/**
 * The tabs as someone who is no member of the project's org is shown them: Keel reads a project's questions to
 * its members alone, so none is counted for anyone else.
 */
const PUBLIC_ON_TABS =
  "Code | Changes 2 open | Conflicts 1 open | Escalations | Mission Control | Agents | Insights";
const QUESTION_ASKED = /May permission checks be cached within a session\?/;
/** The home's first part for someone signed in: the questions Keel has put to them. */
const waitingOn = (shown: Page) => shown.getByRole("region", { name: "Waiting for you" });
const NONE_WAITING = "No question is waiting for you.";
/** What a home says of the reader's questions: the line that none waits, and how many are listed. */
const waitingSaid = async (shown: Page): Promise<string> =>
  `${await waitingOn(shown).getByText(NONE_WAITING).count()} | ${await waitingOn(shown).getByRole("listitem").count()} listed`;
/** What a reader Keel shows no questions to is told of them, where the list or one of them would be. */
const FOR_MEMBERS = "Keel shows a project's questions to its members";
const filesOn = async (shown: Page): Promise<string> =>
  (await shown.locator(".a-tree li").allInnerTexts()).map(squash).join(" | ");
/** Waits until the log has been read and counted on the tabs, or for ten seconds: the check after it says which. */
const counted = (shown: Page): Promise<void> =>
  shown
    .getByRole("navigation", { name: "Project" })
    .getByText("waiting for a person")
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
/** What a page says where Keel shows this reader no such project, with the project's own name left out. */
/** Waits until the log has been read and counted on the tabs of a reader who is shown no questions. */
const countedPublic = (shown: Page): Promise<void> =>
  shown
    .getByRole("navigation", { name: "Project" })
    .getByText("1 open")
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
const toldAt = async (shown: Page, namespace: string, name: string): Promise<string> => {
  await shown.goto(`${built}/${namespace}/${name}`, { waitUntil: "domcontentloaded" });
  await shown.getByRole("heading").first().waitFor();
  await shown.waitForTimeout(400);
  // A page that could not read Keel at all has no frame. What it says is still read, so that a check can say so.
  const said =
    (await shown.getByRole("main").count()) > 0 ? shown.getByRole("main") : shown.locator("body");
  return `${squash(await said.innerText()).replaceAll(`${namespace}/${name}`, "<namespace>/<name>")} | ${await tabsOf(shown).count()} tabs`;
};
const NO_PROJECT = "There is no project <namespace>/<name> here";

// ── A visitor, on a project its org has made public ──
// Public is live: anyone reads its code, its log and what is folded from it. Nothing can be answered.
const street = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const visitorSent: Sent[] = [];
// Keel's answer about the log is held back until the code has been looked for on the page.
let answerTheLog = (): void => {};
const logHeld = new Promise<void>((resolve) => {
  answerTheLog = resolve;
});
await asDeployed(street, {
  keel: open,
  sent: visitorSent,
  hold: (path) => (path === "/v1/events" ? logHeld : Promise.resolve()),
});
const visitor = watch(await street.newPage(), "built, a visitor");
// The scripts the page asks for: the code viewer and the graphs are files of their own, asked for by the pages
// that draw them. The names are the build's, with a hash after each.
const scripts: string[] = [];
visitor.on("request", (request) => {
  const file = /\/assets\/([A-Za-z]+)-[^/]+\.js$/.exec(new URL(request.url()).pathname)?.[1];
  if (file !== undefined) scripts.push(file);
});
const heavy = (): string =>
  ["CodeDiff", "MissionGraph", "PlanGraph"].filter((name) => scripts.includes(name)).join(" ") ||
  "none";
await visitor.goto(`${built}/`, { waitUntil: "domcontentloaded" });
// The home lists the projects Keel names to anyone, each under its org.
await visitor.getByRole("list", { name: "Projects" }).getByRole("link").first().waitFor();
await visitor.waitForTimeout(300);
expectEqual(
  "visitor: the home is not kept waiting for the code viewer or a graph, which it does not draw",
  heavy(),
  "none",
);
expectEqual(
  "visitor: the home lists the public projects, each under its org",
  squash(await visitor.getByRole("list", { name: "Projects" }).innerText()),
  "ada / demo public",
);
// Keel puts a question to a person, by their session. A visitor has none: the home has no such list, and
// Keel is not asked for one.
expectEqual(
  "visitor: the home has no list of questions, and Keel is asked for none",
  `${await waitingOn(visitor).count()} | ${open.calls.filter((call) => call.path === "/v1/escalations").length} asked`,
  "0 | 0 asked",
);
await visitor.getByRole("list", { name: "Projects" }).getByRole("link", { name: "demo" }).click();
// The code is asked for as soon as Keel has said which project the address names, and is drawn when it comes:
// the log is read behind it. Here Keel has not answered about the log at all yet.
await visitor.waitForURL(`${built}/ada/demo`);
while (!visitorSent.some((request) => request.path === "/v1/events"))
  // oxlint-disable-next-line no-await-in-loop -- waiting on the page's own request
  await new Promise((resolve) => setTimeout(resolve, 50));
await visitor
  .locator(".a-tree li")
  .first()
  .waitFor({ timeout: 8_000 })
  .catch(() => undefined);
expectEqual(
  "visitor: the code is on the page while Keel has yet to answer about the log",
  `${await filesOn(visitor)}; the log ${open.calls.some((call) => call.path === "/v1/events") ? "answered" : "not answered"}`,
  "src | package.json | README.md; the log not answered",
);
// A directory draws a list and no code: its page is up before the viewer is asked for, and the viewer comes a
// moment after, so the first file opened has it. No graph is asked for at all.
const atFirst = heavy();
for (let waited = 0; waited < 5_000 && !scripts.includes("CodeDiff"); waited += 100)
  // oxlint-disable-next-line no-await-in-loop -- waiting on the page's own request
  await new Promise((resolve) => setTimeout(resolve, 100));
expectEqual(
  "visitor: a project's page is up before the code viewer is asked for, which then comes for the first file, and no graph does",
  `${atFirst} then ${heavy()}`,
  "none then CodeDiff",
);
answerTheLog();
await countedPublic(visitor);
expectEqual(
  "visitor: what is open, counted on the tabs, and no question, which Keel reads to members",
  (await tabsOf(visitor).allInnerTexts()).map(squash).join(" | "),
  PUBLIC_ON_TABS,
);
expectEqual(
  "visitor: live, and says so",
  String(await visitor.getByText("Live", { exact: true }).count()),
  "1",
);
expectEqual(
  "visitor: nothing calls itself a fixture",
  String(await visitor.getByText("Test fixture").count()),
  "0",
);
// Keel serves no clone address yet, and the console makes none up.
expectEqual(
  "visitor: no clone address is made up",
  String(await visitor.getByText("git clone").count()),
  "0",
);
// A file's address costs Keel one read of the file: the page does not first ask for it as a directory and wait
// to be refused.
const beforeTheFile = open.calls.length;
await visitor.goto(`${built}/ada/demo/blob/trunk/src/authz/check.ts`, {
  waitUntil: "domcontentloaded",
});
await visitor.locator(".a-code").first().waitFor({ timeout: 10_000 });
expectEqual(
  "visitor: a file's address asks Keel for the file, and never for a directory of its name",
  open.calls
    .slice(beforeTheFile)
    .filter((call) => new URLSearchParams(call.query).get("path") === "src/authz/check.ts")
    .map((call) => call.path.split("/").at(-1))
    .join(" "),
  "blob",
);

// Playback is for a fixture's log. The built console has none, and no way to move about in Keel's.
scripts.length = 0;
await visitor.goto(`${built}/ada/demo/mission-control`, { waitUntil: "domcontentloaded" });
await visitor.locator("dl.a-trunk-line").waitFor();
expectEqual(
  "visitor: changes landed, and no count of people asked, which a visitor is not read",
  await statOn(visitor, "People asked / changes landed"),
  "—/0",
);
await shot(visitor, "visitor-mission-control");
// A new document, so what it asks for is counted from nothing: the graph, and not the code viewer.
await visitor
  .locator(".react-flow")
  .first()
  .waitFor({ timeout: 8_000 })
  .catch(() => undefined);
expectEqual(
  "visitor: Mission Control asks for its graph, which is a file of its own, and for no code viewer",
  `${heavy()} | ${await visitor.locator(".react-flow").count()} drawn`,
  "MissionGraph | 1 drawn",
);
// The control is loaded apart from the page, a moment after it. So it is waited for, and must not come.
expectEqual(
  "built: no playback",
  await visitor
    .getByLabel("Position in the log")
    .waitFor({ timeout: 3_000 })
    .then(
      () => "shown",
      () => "none",
    ),
  "none",
);

// Asking the built console for a fixture gets Keel, not the fixture. And no link in it carries the asking further.
await visitor.goto(`${built}/ada/demo/insights/benchmark?scenario=swarm&t=100`, {
  waitUntil: "domcontentloaded",
});
await visitor.getByRole("heading", { name: "No sealed run here" }).waitFor();
expectEqual(
  "visitor: ?scenario= is not a way in to a fixture",
  (await tabsOf(visitor).allInnerTexts()).map(squash).join(" | "),
  PUBLIC_ON_TABS,
);
// The way in remembers the address it was on, whole; no link goes anywhere with a fixture's own parameters.
expectEqual(
  "visitor: no link carries a fixture's parameters",
  String(
    await visitor.locator("a").evaluateAll(
      (links) =>
        links.filter((link) => {
          const to = new URL(link instanceof HTMLAnchorElement ? link.href : "", document.baseURI);
          return to.searchParams.has("scenario") || to.searchParams.has("t");
        }).length,
    ),
  ),
  "0",
);

// Keel sends no comparison counters yet: nothing is drawn for them, and the page says so. The changes and the
// conflicts are counted from events, and a visitor is read every event they are counted from.
await visitor.goto(`${built}/ada/demo/insights/funnel`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { name: "Review funnel" }).waitFor();
await funnelRows(visitor, "changes").first().waitFor();
expectEqual(
  "built: no comparison is drawn where Keel reports none, and the page says so",
  `${await funnelRows(visitor, "comparisons").count()} rows, ${await visitor.getByRole("heading", { name: "Comparisons" }).count()} heading, ${await visitor.getByText("Keel does not report how many comparisons each change needed yet").count()} line`,
  "0 rows, 0 heading, 1 line",
);
expectEqual(
  "built: a visitor is shown a change's four stages, counted from Keel's events",
  (await funnelRows(visitor, "changes").locator("td:nth-child(2)").allInnerTexts())
    .map(squash)
    .join(" > "),
  "2 > 2 > 0 > 0",
);
expectEqual(
  "built: a change Keel parked is still at its stage, and is said to be parked",
  await stageOn(visitor, "changes", 1),
  "2 | 0 0% 2 still here 2 still here, 2 of them parked | 0 | —",
);
expectEqual(
  "built: probe, counted from events",
  await stageOn(visitor, "conflicts", 0),
  "1 | 0 0% 1 passed on | 1 | —",
);
// Keel records no cost yet. Where there is none the funnel shows none: a review that cost nothing is not what it says.
expectEqual(
  "built: no cost is shown where Keel has recorded none",
  await statOn(visitor, "Cost of review"),
  "—",
);
expectEqual(
  "built: and the funnel says that Keel records none",
  String(await visitor.getByText("Keel records no cost yet.").count()),
  "1",
);
// Keel's one cost on a live log is its own estimate for a plan. It is worded as that, beside the stage it is of
// and under the cost Keel has not recorded, and is never the cost of review.
expectEqual(
  "built: Keel's estimate for its plans is worded as an estimate, and is not the cost of review",
  `${(await stageOn(visitor, "changes", 2)).split(" | ").at(-1)} / ${squash(await visitor.locator("dl dt", { hasText: "Cost of review" }).locator("xpath=following-sibling::dd[2]").innerText())}`,
  "Keel's estimate $0.0080 for 2 plans, before any ran / Keel records no cost yet. Its own estimate for the 2 plans it compiled is $0.0080.",
);
expectEqual(
  "visitor: the stage where a person is asked is not counted, and says whose it is to read",
  `${await stageOn(visitor, "conflicts", 1)} | ${await statOn(visitor, "People asked").catch(() => "no tile")}`,
  "— | — shown to members |  | a person's time | —",
);

// The conflict's line is drawn from the lattices the page read from Keel, and a verdict's evidence from Keel's view of it.
await visitor.goto(`${built}/ada/demo/conflicts/C-1`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { name: "World matrix" }).waitFor();
await visitor.locator("[data-lattice-value]").first().waitFor({ timeout: 10_000 });
expectEqual(
  "built: the lattice's line, read from Keel",
  (await visitor.locator("[data-lattice-value]").allInnerTexts()).join(" < "),
  "per-call < per-request < per-session < static",
);
// The log is read to its end before the page waits for anything new: a stretch of it that holds none of the
// project's entries is read past at once, and is never taken for the end.
expectEqual(
  "built: the log is read past other projects' entries without waiting",
  String(
    open.calls.filter((call) => {
      const asked = new URLSearchParams(call.query);
      return (
        call.path === "/v1/events" &&
        Number(asked.get("cursor") ?? "0") < AHEAD &&
        asked.has("wait")
      );
    }).length,
  ),
  "0",
);
// The probe's source is read from Keel when its conflict is looked at, and drawn file by file.
await visitor.goto(`${built}/ada/demo/conflicts/C-1/probe`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("region", { name: "Probe P-1" }).waitFor();
await visitor
  .getByText("probes/authz.permission-evaluation/freshness.probe.ts")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "built: a probe's source, read from Keel by its own operation",
  String(
    open.calls.filter(
      (call) =>
        /^\/v1\/probes\/[^/]+\/source$/.test(call.path) && call.query.startsWith("project="),
    ).length,
  ),
  "1",
);
await visitor.goto(`${built}/ada/demo/changes/1/verification`, { waitUntil: "domcontentloaded" });
await visitor
  .getByText("Probe P-1 fails in A+B, three runs out of three")
  .first()
  .waitFor({ timeout: 10_000 });
expectEqual(
  "built: a verdict's evidence and the lattices, read from Keel",
  `${open.calls.some((call) => call.path.startsWith("/v1/verdicts/"))} ${open.calls.some((call) => call.path === "/v1/lattices")}`,
  "true true",
);

// Keel's contract has no way to read a change's diff either. Its page says so, and counts no files.
await visitor.goto(`${built}/ada/demo/changes/1/files`, { waitUntil: "domcontentloaded" });
await visitor.getByText("Keel does not serve this change's diff").waitFor({ timeout: 10_000 });
expectEqual(
  "built: a diff Keel does not serve is not counted as no files",
  squash(
    await visitor
      .getByRole("navigation", { name: "Change" })
      .getByRole("link", { name: /Files changed/ })
      .innerText(),
  ),
  "Files changed",
);

// An address with a dot in it opens from nowhere, as it does where the console is deployed.
await visitor.goto(`${built}/ada/demo/subjects/authz.permission-evaluation`, {
  waitUntil: "domcontentloaded",
});
await visitor.getByRole("complementary", { name: "Subject authz.permission-evaluation" }).waitFor();
expectEqual(
  "built: a subject, opened cold",
  pathOf(visitor),
  "/ada/demo/subjects/authz.permission-evaluation",
);
await visitor.goto(`${built}/ada/demo/nowhere`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { name: "There is nothing at this address" }).waitFor();

// Keel reads a project's questions to its members and to nobody else. A visitor is told so where the list and
// where a question would be, never that there is none; and the frame's way in comes back to the page.
const mainSaid = async (shown: Page): Promise<string> =>
  squash(await shown.getByRole("main").innerText()).split(" A question")[0] ?? "";
await visitor.goto(`${built}/ada/demo/escalations`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("main").getByRole("heading").last().waitFor();
await countedPublic(visitor);
expectEqual(
  "visitor: the questions are said to be the members' to read, not that there are none",
  `${await mainSaid(visitor)} | ${await visitor.getByText("Nothing is waiting for a person").count()} | ${await visitor.getByRole("main").getByRole("link").count()} links`,
  `Escalations ${FOR_MEMBERS} | 0 | 0 links`,
);
await shot(visitor, "visitor-escalations");
await visitor.goto(`${built}/ada/demo/changes`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("main").getByRole("link").first().waitFor();
// The log a visitor is read enrols nobody. Keel reads anyone an agent's card, so each row's agent is named from
// it once it is read: the name is waited for, or ten seconds, and the check says which.
const namedFromCard = (shown: Page, name: string): Promise<void> =>
  shown
    .getByRole("main")
    .getByText(name, { exact: true })
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
const agentsNamed = async (shown: Page, within = "main"): Promise<string> =>
  [
    ...new Set(
      (
        await shown
          .locator(within)
          .getByText(/^(an agent|Agent( [AB])?)$/)
          .allInnerTexts()
      ).map(squash),
    ),
  ]
    .toSorted()
    .join(", ");
const classesWritten = (shown: Page): Promise<number> =>
  shown.getByText(/\b(REAL|HOSTED|SYNTHETIC)\b/).count();
await visitor.goto(`${built}/ada/demo/changes?state=parked`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("main").getByRole("link").first().waitFor();
await namedFromCard(visitor, "Agent A");
await namedFromCard(visitor, "Agent B");
expectEqual(
  "visitor: the list of changes names each change's agent from Keel's card of it, and writes no class",
  `${await agentsNamed(visitor)} | ${await classesWritten(visitor)} classes`,
  "Agent A, Agent B | 0 classes",
);
await shot(visitor, "visitor-changes");
await visitor.goto(`${built}/ada/demo/changes/1`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("main").getByRole("heading").first().waitFor();
await visitor.waitForTimeout(500);
await shot(visitor, "visitor-change");
// Keel reads an agent's enrolment to its project's members and its card to anyone. So a visitor is shown a
// change's agent by its card's name and of no class: what a card says is the agent's own declaration, and no
// class is made up from it.
await visitor
  .getByRole("complementary")
  .getByText("Agent B", { exact: true })
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "visitor: a change's agent is named from Keel's card of it, and is given no class Keel did not say",
  `${squash(
    await visitor
      .getByRole("complementary")
      .getByText(/^Agent( [AB])?$/)
      .last()
      .innerText()
      .catch(() => "no agent shown"),
  )} | ${await classesWritten(visitor)} classes`,
  "Agent B | 0 classes",
);
await visitor.goto(`${built}/ada/demo/escalations/E-1`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("main").getByRole("heading").last().waitFor();
await countedPublic(visitor);
expectEqual(
  "visitor: and so is one question, with nothing of it shown and nothing to tap",
  `${await mainSaid(visitor)} | ${await visitor.locator(".a-option").count()} options | ${await visitor.getByText(QUESTION_ASKED).count()}`,
  `Escalation E-1 ${FOR_MEMBERS} | 0 options | 0`,
);
// The conflict that waits on that question says it waits on a ruling: that much is the conflict's own, and public.
await visitor.goto(`${built}/ada/demo/conflicts/C-1`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { name: "World matrix" }).waitFor();
expectEqual(
  "visitor: a conflict that waits on a ruling says so, and that the question is the members'",
  String(
    await visitor
      .getByText(
        "This conflict waits on a person's ruling. Keel shows the question to the project's members.",
      )
      .count(),
  ),
  "1",
);
await namedFromCard(visitor, "Agent A");
await namedFromCard(visitor, "Agent B");
expectEqual(
  "visitor: each side of a conflict names its agent from that agent's card, and writes no class",
  `${await agentsNamed(visitor)} | ${await classesWritten(visitor)} classes`,
  "Agent A, Agent B | 0 classes",
);
await shot(visitor, "visitor-conflict");
// Mission Control draws an agent beside its change once the reader has a name for it: for a visitor, its card's.
await visitor.goto(`${built}/ada/demo/mission-control`, { waitUntil: "domcontentloaded" });
await graphDrawn(visitor);
await namedFromCard(visitor, "Agent A");
await namedFromCard(visitor, "Agent B");
expectEqual(
  "visitor: Mission Control draws each agent beside its change under its card's name, with its run and no class",
  `${await agentsNamed(visitor, ".a-fn")} | ${await visitor.getByText("run “collab-revocation”", { exact: true }).count()} run | ${await classesWritten(visitor)} classes`,
  "Agent A, Agent B | 1 run | 0 classes",
);
await shot(visitor, "visitor-mission-control");
await visitor.goto(`${built}/ada/demo/escalations/E-1`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("main").getByRole("heading").last().waitFor();
const wayIn =
  (await visitor.getByRole("link", { name: "Sign in" }).first().getAttribute("href")) ?? "";
expectEqual(
  "visitor: the frame's way in comes back to the page it was on",
  `${new URL(wayIn, built).pathname} ${new URL(wayIn, built).searchParams.get("next")}`,
  "/login /ada/demo/escalations/E-1",
);
// A public project's frame offers its fork to a visitor too. Its form is for someone signed in, so a visitor
// goes by the sign-in page and comes back to it.
const wayToFork =
  (await visitor
    .getByRole("link", { name: "Fork", exact: true })
    .first()
    .getAttribute("href", { timeout: 5_000 })
    .catch(() => null)) ?? "no way to fork";
await visitor.goto(`${built}/ada/demo/fork`, { waitUntil: "domcontentloaded" });
await visitor.waitForURL(/\/login/, { timeout: 10_000 }).catch(() => undefined);
expectEqual(
  "visitor: a public project's frame offers its fork, and the form sends a visitor to sign in and back to it",
  `${wayToFork} | ${new URL(visitor.url()).pathname}${new URL(visitor.url()).search}`,
  "/ada/demo/fork | /login?next=%2Fada%2Fdemo%2Ffork",
);

// A handle's own page. Whose a handle is, Keel says to anyone who asks, and the page is worded from that: a
// person's is their handle and the projects of theirs this reader may see, with no word of an org; an org's
// says it is one; and a handle nobody has is said to be nobody's.
const handlePage = async (shown: Page): Promise<string> => {
  const said = async (part: string): Promise<string> =>
    squash(
      await shown
        .locator(part)
        .innerText({ timeout: 3_000 })
        .catch(() => "nothing"),
    );
  return `${await said("main header")} | ${await said('main section[aria-label="Projects"]')}`;
};
await visitor.goto(`${built}/ada/demo/escalations`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("main").getByRole("heading").last().waitFor();
const whose = squash(await visitor.getByRole("main").innerText());
expectEqual(
  "visitor: a person's project keeps its questions for that person, and no members are named to sign in as",
  `${whose.includes("are read by ada and by nobody else")} ${whose.includes("member of ada")}`,
  "true false",
);
await visitor.goto(`${built}/ada`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("main").getByRole("heading").first().waitFor();
expectEqual(
  "visitor: a person's page is their handle and their public projects, and is not called an org",
  await handlePage(visitor),
  "ada | Projects demo public",
);
await shot(visitor, "visitor-handle");
await visitor.goto(`${built}/nobody`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("main").getByRole("heading").first().waitFor();
expectEqual(
  "visitor: a handle nobody has is said to be nobody's",
  squash(await visitor.getByRole("main").getByRole("heading").first().innerText()),
  "There is no nobody here",
);

// A project Keel does not have, and a project of that name under another org, are told alike, and lead to the
// projects Keel has.
const told = {
  none: await toldAt(visitor, "ada", "none"),
  elsewhere: await toldAt(visitor, "other", "demo"),
};
expectEqual(
  "visitor: a project that is not there is said to be none",
  told.none.split(" | ")[0]?.startsWith(NO_PROJECT) === true ? NO_PROJECT : told.none,
  NO_PROJECT,
);
expectEqual("visitor: and one under another org is told as that is", told.elsewhere, told.none);
expectEqual(
  "built: a project Keel does not have leads to the ones it has",
  await visitor
    .getByRole("main")
    .getByRole("link", { name: "See the projects Keel has" })
    .evaluate((link) => (link instanceof HTMLAnchorElement ? new URL(link.href).pathname : "")),
  "/",
);

expectEqual(
  "built: Keel is asked only for what its contract has",
  [
    ...new Set(
      open.calls.map((call) =>
        call.path
          .replace(/\/v1\/agents\/agt_[0-9A-Z]+$/, "/v1/agents/{id}")
          .replace(/\/v1\/verdicts\/.+/, "/v1/verdicts/{id}")
          .replace(/\/v1\/probes\/[^/]+\/source$/, "/v1/probes/{id}/source")
          .replace(
            /\/v1\/namespaces\/[^/]+\/projects\/[^/]+$/,
            "/v1/namespaces/{handle}/projects/{name}",
          )
          .replace(/\/v1\/namespaces\/[^/]+$/, "/v1/namespaces/{handle}")
          .replace(/\/v1\/projects\/[^/]+\//, "/v1/projects/{id}/"),
      ),
    ),
  ]
    .toSorted()
    .join(" "),
  "/v1/agents/{id} /v1/events /v1/lattices /v1/namespaces/{handle} /v1/namespaces/{handle}/projects/{name} /v1/probes/{id}/source /v1/projects /v1/projects/{id}/repo/blob /v1/projects/{id}/repo/commits /v1/projects/{id}/repo/tree /v1/verdicts/{id}",
);
// The page put nothing of its own on anything it asked: no token, no key. A visitor's browser holds no session.
expectEqual(
  "visitor: the page sent Keel no credential, and the browser had none to send",
  `${visitorSent.filter((request) => request.authorization !== undefined).length} ${open.calls.filter((call) => call.authorization !== "").length} ${(await street.cookies()).length}`,
  "0 0 0",
);

// ── A visitor, on a project whose agents Keel names to anyone by their cards ──
// The log names an agent by its id, and a visitor is read no enrolment. What they are shown of each agent is
// Keel's card of it: Agent A signed itself up, so it has a handle, and Agent B was enrolled, so it has the kind
// it declared and the namespace it works in.
const staffed = createFakeKeel({
  namespace: NAMESPACE,
  visibility: "public",
  readerOf,
  whose: whoseHandle,
  ahead: AHEAD,
  signedUp: { "Agent A": "tidy-otter" },
});
const staffSent: Sent[] = [];
await asDeployed(street, { keel: staffed, sent: staffSent });
await visitor.goto(`${built}/ada/demo/agents`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { level: 1, name: "Agents" }).waitFor();
// Each name arrives with its agent's card: both are waited for, or ten seconds, and the check says which.
await visitor
  .getByRole("list", { name: AGENTS })
  .getByText("declared as interactive")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "visitor: a project's agents are named from Keel's cards: a handle where one signed itself up, a declared kind where one was enrolled",
  await agentRows(visitor),
  "Agent A | tidy-otter, 1 run here | #2 1 change || Agent B | declared as interactive, no run named | #1 1 change",
);
expectEqual(
  "visitor: an agent's handle is a link to its own page, and its name to its page in the project, at its handle",
  (
    await visitor
      .getByRole("list", { name: AGENTS })
      .getByRole("listitem")
      .first()
      .getByRole("link")
      .evaluateAll((links) =>
        links.map((link) =>
          link instanceof HTMLAnchorElement ? new URL(link.href).pathname : "not a link",
        ),
      )
  )
    .slice(0, 2)
    .join(" "),
  "/ada/demo/agents/tidy-otter /tidy-otter",
);
// An agent's page opened cold at its handle: the log has only its id, so Keel is asked whose the handle is.
const beforeTheHandle = staffSent.length;
await visitor.goto(`${built}/ada/demo/agents/tidy-otter`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { level: 1 }).first().waitFor();
await visitor
  .getByRole("heading", { level: 1, name: "Agent A" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "visitor: an agent's page opened at its handle finds the agent, with its run and the change it holds",
  `${squash(await visitor.getByRole("heading", { level: 1 }).first().innerText())} | ${await runsOn(visitor)}`,
  "Agent A | run-run_0000000000000000000000ACDE | “collab-revocation” | as the agent named it, run_0000000000000000000000ACDE, 2 entries of the log | #2Owners can revoke collaborators, effective immediatelyparked",
);
expectEqual(
  "visitor: for an agent at a handle Keel is asked whose the handle is and for that agent's card, and nothing else of agents",
  [
    ...new Set(
      staffSent
        .slice(beforeTheHandle)
        .map((request) => request.path.replace(/\/v1\/agents\/agt_[0-9A-Z]+$/, "/v1/agents/{id}"))
        .filter((path) => path.startsWith("/v1/agents") || path === "/v1/namespaces/tidy-otter"),
    ),
  ]
    .toSorted()
    .join(" "),
  "/v1/agents/{id} /v1/namespaces/tidy-otter",
);
// The agent's own page, at its handle: Keel's card, and nothing of who stands behind it.
await visitor.goto(`${built}/tidy-otter`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { level: 1 }).first().waitFor();
await visitor
  .getByRole("region", { name: "Agent" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "visitor: an agent's own page shows Keel's card of it, and no line about standing behind it",
  `${squash(await visitor.locator("main header").first().innerText())} | ${(await visitor.getByRole("region", { name: "Agent" }).count()) === 0 ? "no card" : squash(await visitor.getByRole("region", { name: "Agent" }).innerText())} | ${await visitor.getByText(/stand behind/i).count()}`,
  "tidy-otter Agent | Agent Name Agent A | 0",
);

// ── A visitor, on a project its org has kept private ──
// A private project is to a visitor as one that is not there: the same words, and nothing of it on the page.
const lane = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await asDeployed(lane, { keel: shut });
const outsider = watch(await lane.newPage(), "built, a visitor to a private project");
await outsider.goto(`${built}/`, { waitUntil: "domcontentloaded" });
await outsider.getByRole("heading", { name: "Keel has no project to show you yet" }).waitFor();
const hidden = await toldAt(outsider, "ada", "demo");
expectEqual(
  "visitor: a private project is told as none is",
  hidden,
  await toldAt(outsider, "ada", "none"),
);
expectEqual(
  "visitor: and that is what a visitor to a public Keel is told of none",
  hidden,
  told.none,
);
for (const place of ["/mission-control", "/changes", "/escalations/E-1", "/blob/trunk/README.md"]) {
  await outsider.goto(`${built}/ada/demo${place}`, { waitUntil: "domcontentloaded" });
  await outsider.getByRole("heading").first().waitFor();
  await outsider.waitForTimeout(300);
  expectEqual(
    `visitor: ${place} of a private project shows nothing of it`,
    `${squash(await outsider.getByRole("heading").first().innerText())} | ${await tabsOf(outsider).count()} tabs | ${await outsider.locator(".a-tree, .a-prose, .a-code, .a-option").count()}`,
    "There is no project ada/demo here | 0 tabs | 0",
  );
}
// That the handle is someone's is no secret, though: the person is there, with nothing of theirs to show.
await outsider.goto(`${built}/ada`, { waitUntil: "domcontentloaded" });
await outsider.getByRole("main").getByRole("heading").first().waitFor();
expectEqual(
  "visitor: a person with no public project is still there, and their page says only that",
  await handlePage(outsider),
  "ada | Projects ada has no public project. Sign in to see what you may.",
);
await lane.close();

// ─────────────────────────────────────────────────────────────────────────────
// The pages above every project: signing up and in, the user's settings, approving a terminal
// ─────────────────────────────────────────────────────────────────────────────
// Keel's identity is Better Auth, mounted at /v1/auth on the page's own origin, and the real library stands in for
// it here. Ada's browser and Grace's read the Keel on which the project is private.

const lobby = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const sentToKeel: Sent[] = [];
await asDeployed(lobby, { keel: shut, sent: sentToKeel });
const person = watch(await lobby.newPage(), "account");
// A passkey needs an authenticator. Chrome plays one, which makes and keeps real keys and signs with them.
const devtools = await lobby.newCDPSession(person);
await devtools.send("WebAuthn.enable");
await devtools.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
const whereOf = (shown: Page): string => {
  const url = new URL(shown.url());
  return `${url.pathname}${url.search}`;
};

// A page for a signed-in user sends a visitor to sign in, and remembers where they were going.
await person.goto(`${built}/settings`, { waitUntil: "domcontentloaded" });
await person.getByRole("heading", { name: "Sign in to Keel" }).waitFor();
expectEqual("account: a visitor is sent to sign in", whereOf(person), "/login?next=%2Fsettings");
await person.getByRole("link", { name: "Create an account" }).click();
await person.getByRole("heading", { name: "Create your account" }).waitFor();
expectEqual(
  "account: and on to sign up, going to the same place",
  whereOf(person),
  "/signup?next=%2Fsettings",
);

await shot(person, "signup");
expectEqual(
  "account: signing up says nothing of an org (signup)",
  String(
    await person
      .getByRole("main")
      .getByText(/\borg\b/i)
      .count(),
  ),
  "0",
);
// Sign up with a code sent by email. The code is read where Keel would have sent it.
await person.getByLabel("Email").fill("ada@example.com");
await person.getByRole("button", { name: "Send a code" }).click();
await person.getByLabel("The code sent to ada@example.com").waitFor();
expectEqual("account: one code was sent", String(identity.outbox.length), "1");
await person.getByLabel("The code sent to ada@example.com").fill("000000");
await person.getByRole("button", { name: "Create the account" }).click();
await person.getByRole("alert").waitFor();
expectEqual(
  "account: a code that was not the one sent is refused, and said",
  String((await person.getByRole("alert").innerText()).length > 0),
  "true",
);
await person.getByLabel("The code sent to ada@example.com").fill(identity.outbox.at(-1)?.otp ?? "");
await person.getByRole("button", { name: "Create the account" }).click();
// A new user chooses a handle before anything else.
await person.getByRole("heading", { name: "Choose your handle" }).waitFor();
await person.getByLabel("Handle").fill("Ada Lovelace");
expectEqual(
  "account: a handle that is not one is not taken",
  String(await person.getByRole("button", { name: "Take this handle" }).isDisabled()),
  "true",
);
await person.getByLabel("Handle").fill("ada");
await shot(person, "handle");
expectEqual(
  "account: signing up says nothing of an org (handle)",
  String(
    await person
      .getByRole("main")
      .getByText(/\borg\b/i)
      .count(),
  ),
  "0",
);
await person.getByRole("button", { name: "Take this handle" }).click();
await person.getByRole("heading", { name: "Your account", exact: true }).waitFor();
expectEqual("account: signed up, and where they were going", whereOf(person), "/settings");
expectEqual(
  "account: the frame says who is signed in",
  squash(await person.locator("header").first().innerText()),
  "Keel ada",
);

// The session is a cookie the page cannot read, and the page keeps nothing else.
const sessionCookies = (await lobby.cookies()).filter((cookie) =>
  cookie.name.endsWith("session_token"),
);
expectEqual(
  "account: the session is one cookie, HttpOnly",
  sessionCookies.map((cookie) => `${cookie.httpOnly} ${cookie.sameSite}`).join(","),
  "true Lax",
);
expectEqual(
  "account: the page can read no cookie and has stored nothing",
  JSON.stringify(
    await person.evaluate(() => [
      document.cookie,
      Object.keys(window.localStorage),
      Object.keys(window.sessionStorage),
    ]),
  ),
  '["",[],[]]',
);

// Keel lets a session change how its account signs in only where it was signed in by a passkey in the last
// ten minutes, and takes an account's first passkey from any sign-in of its own that new.
const FRESH_SIGN_IN =
  "Sign in again with your passkey, then retry: changing how you sign in needs a passkey sign-in from the last ten minutes";
const FIRST_PASSKEY =
  "Sign in again, then retry: adding your first passkey needs a sign-in of your own from the last ten minutes";
const SIGN_IN_AGAIN = "Sign in again with a passkey";
const passkeysOn = (shown: Page) => shown.getByRole("region", { name: "Passkeys" });
/** What the passkeys part of a settings page says: Keel's refusal, whether a sign-in is offered, how many are kept. */
const passkeysSaid = async (shown: Page): Promise<string> =>
  `${(await passkeysOn(shown).getByRole("alert").count()) === 0 ? "no refusal" : squash(await passkeysOn(shown).getByRole("alert").innerText())} | ${await passkeysOn(shown).getByRole("button", { name: SIGN_IN_AGAIN }).count()} offered | ${await shown.getByRole("list", { name: "Your passkeys" }).getByRole("listitem").count()} kept`;
await person.getByText("You have no passkey yet.").waitFor();
await person
  .getByText("You stand behind no agent.")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sponsored: someone who stands behind no agent is told so, and is shown no control",
  `${await person.getByText("You stand behind no agent.").count()} | ${await person.getByRole("region", { name: "Agents you stand behind" }).getByRole("button").count()} controls`,
  "1 | 0 controls",
);
const sessionsHeld = async (): Promise<number> =>
  (await lobby.cookies()).filter((cookie) => cookie.name.endsWith("session_token")).length;
/** Ada signs in by a code sent to her address, on the sign-in page she is at, and is then at her settings. */
const signInByCode = async (): Promise<void> => {
  const codesSent = identity.outbox.length;
  await person.getByLabel("Email").fill("ada@example.com");
  await person.getByRole("button", { name: "Send a code" }).click();
  await person.getByLabel("The code sent to ada@example.com").waitFor();
  for (let tries = 0; tries < 50 && identity.outbox.length === codesSent; tries += 1)
    // oxlint-disable-next-line no-await-in-loop -- waiting on the code to be sent
    await new Promise((resolve) => setTimeout(resolve, 100));
  await person
    .getByLabel("The code sent to ada@example.com")
    .fill(identity.outbox.at(-1)?.otp ?? "");
  await person.getByRole("button", { name: "Sign in", exact: true }).click();
  await person.getByRole("heading", { name: "Your account", exact: true }).waitFor();
};

// Sign out, then back in by a code sent to the same address.
await person.getByRole("button", { name: "Sign out", exact: true }).click();
await person.waitForURL(`${built}/`);
expectEqual("account: signed out, the session cookie is gone", String(await sessionsHeld()), "0");
await person.goto(`${built}/login?next=%2Fsettings`, { waitUntil: "domcontentloaded" });
await shot(person, "login");
await signInByCode();
expectEqual(
  "account: signed in again by a code, as the same user",
  squash(await person.locator("header").first().innerText()),
  "Keel ada",
);

// Ada signed in by a code and has no passkey. Once that sign-in is more than ten minutes old Keel refuses her
// one, in its own words, and the page offers the one way to a fresh sign-in she has: signing in again. A touch
// of a passkey is not offered, since she has none to touch.
await identity.age();
const addAPasskey = async (): Promise<void> => {
  await person.getByLabel("Name for a new passkey").fill("This laptop");
  await person.getByRole("button", { name: "Add a passkey" }).click();
  // Keel has answered when the page says a refusal or lists the passkey: what it then says is read, whichever.
  await Promise.race([
    passkeysOn(person).getByRole("alert").waitFor({ timeout: 10_000 }),
    person
      .getByRole("list", { name: "Your passkeys" })
      .getByRole("listitem")
      .first()
      .waitFor({ timeout: 10_000 }),
  ]).catch(() => undefined);
};
await addAPasskey();
await shot(person, "settings");
const signInAgain = passkeysOn(person).getByRole("button", { name: "Sign in again", exact: true });
expectEqual(
  "account: someone with no passkey whose sign-in is not new is told Keel's own refusal on adding one, and is offered a sign-in again and no passkey touch",
  `${await passkeysSaid(person)} | ${await signInAgain.count()} sign in again`,
  `${FIRST_PASSKEY} | 0 offered | 0 kept | 1 sign in again`,
);
// The button ends her session and takes her to sign in, to come back to her settings.
if ((await signInAgain.count()) > 0) await signInAgain.click();
await person
  .waitForURL(`${built}/login?next=%2Fsettings`, { timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "account: signing in again ends the session and goes by the sign-in page back to the settings",
  `${new URL(person.url()).pathname}${new URL(person.url()).search} | ${await sessionsHeld()} session`,
  "/login?next=%2Fsettings | 0 session",
);
// With a sign-in of her own a moment old, Keel takes her first passkey.
if (new URL(person.url()).pathname === "/login") await signInByCode();
await addAPasskey();
expectEqual(
  "account: a sign-in by a code in the last ten minutes adds the account's first passkey",
  await passkeysSaid(person),
  "no refusal | 0 offered | 1 kept",
);
/** A row of a list on the settings page, with its days and this browser's own name for itself taken out. */
const rowSaid = (text: string): string =>
  squash(text)
    .replace(/\d{4}-\d{2}-\d{2}/g, "{day}")
    .replace(/^.*? · this session/, "this session");
const passkeyRows = (shown: Page) =>
  shown.getByRole("list", { name: "Your passkeys" }).getByRole("listitem");
// A passkey made a moment ago has signed nobody in yet. Keel has no last use of it, and the page says none.
expectEqual(
  "passkeys: one that has not signed its person in says the day it was added, and nothing of a last use",
  rowSaid(await passkeyRows(person).first().innerText()),
  "This laptop added {day} Rename Remove",
);

// ── Her sessions ──
// Keel lists each browser signed in as her. This one is marked, and is offered no End: it is ended by signing out.
const sessionRows = (shown: Page) =>
  shown.getByRole("list", { name: "Your sessions" }).getByRole("listitem");
const sessionsSaid = async (shown: Page): Promise<string> =>
  `${(await sessionRows(shown).allInnerTexts()).map(rowSaid).join(" || ")} | ${(
    await sessionRows(shown)
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent ?? ""),
      )
  ).join(", ")}`;
await sessionRows(person)
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sessions: her one session is this one, by how it was signed in and its days, with no way offered to end it",
  await sessionsSaid(person),
  "this session Signed in with an email code on {day} · last used {day} | ",
);
// The same person signs in from another browser, which says it is Firefox on Windows.
const elsewhere = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
});
await asDeployed(elsewhere, { keel: shut, sent: sentToKeel });
const otherBrowser = watch(
  await elsewhere.newPage(),
  "account, the same person in another browser",
);
await otherBrowser.goto(`${built}/login?next=%2Fsettings`, { waitUntil: "domcontentloaded" });
const codesBefore = identity.outbox.length;
await otherBrowser.getByLabel("Email").fill("ada@example.com");
await otherBrowser.getByRole("button", { name: "Send a code" }).click();
await otherBrowser.getByLabel("The code sent to ada@example.com").waitFor();
for (let tries = 0; tries < 50 && identity.outbox.length === codesBefore; tries += 1)
  // oxlint-disable-next-line no-await-in-loop -- waiting on the code to be sent
  await new Promise((resolve) => setTimeout(resolve, 100));
await otherBrowser
  .getByLabel("The code sent to ada@example.com")
  .fill(identity.outbox.at(-1)?.otp ?? "");
await otherBrowser.getByRole("button", { name: "Sign in", exact: true }).click();
await otherBrowser.getByRole("heading", { name: "Your account", exact: true }).waitFor();
// Her settings, opened again in the first browser, list both: the other by what it called itself, with its End.
await person.reload({ waitUntil: "domcontentloaded" });
await sessionRows(person)
  .nth(1)
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
await shot(person, "settings-sessions");
expectEqual(
  "sessions: another browser signed in as her is listed by what it called itself, the one used last first, and it alone may be ended",
  await sessionsSaid(person),
  "Firefox on Windows Signed in with an email code on {day} · last used {day} End || this session Signed in with an email code on {day} · last used {day} | End the session on Firefox on Windows",
);
const endings = (): number =>
  sentToKeel.filter((request) => request.path === "/v1/auth/sessions/revoke").length;
const endedBefore = endings();
if ((await sessionRows(person).getByRole("button").count()) > 0)
  await sessionRows(person).getByRole("button").first().click();
for (let tries = 0; tries < 50 && (await sessionRows(person).count()) > 1; tries += 1)
  // oxlint-disable-next-line no-await-in-loop -- waiting on the list to be read again
  await new Promise((resolve) => setTimeout(resolve, 100));
await otherBrowser.goto(`${built}/settings`, { waitUntil: "domcontentloaded" });
await otherBrowser.waitForURL(/\/login/, { timeout: 10_000 }).catch(() => undefined);
expectEqual(
  "sessions: ended, it leaves the list and signs nobody in, by one call of Keel's, and this browser stays signed in",
  `${await sessionsSaid(person)} | ${endings() - endedBefore} asked | the other at ${new URL(otherBrowser.url()).pathname} | ${await sessionsHeld()} session here`,
  "this session Signed in with an email code on {day} · last used {day} |  | 1 asked | the other at /login | 1 session here",
);
await elsewhere.close();

// Once signed in, an address cannot send the reader on to another site.
await person.goto(`${built}/login?next=${encodeURIComponent("https://elsewhere.example/")}`, {
  waitUntil: "domcontentloaded",
});
await person.waitForURL(`${built}/`);
expectEqual("account: sign-in goes on to no other site", new URL(person.url()).origin, built);

// A terminal running `keeltown login` shows a code and sends its person to /device.
const terminal = async (path: string, body: unknown): Promise<Response> =>
  identity.handle(
    new Request(`${built}/v1/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const shownByTerminal: { device_code: string; user_code: string } = await (
  await terminal("/device/code", { client_id: "keeltown" })
).json();
await person.goto(`${built}/device?user_code=${shownByTerminal.user_code}`, {
  waitUntil: "domcontentloaded",
});
await person.getByRole("heading", { name: "Sign a terminal in as you?" }).waitFor();
expectEqual(
  "device: the code is the one the terminal shows",
  await person.locator("[data-user-code]").innerText(),
  shownByTerminal.user_code,
);
await shot(person, "device");
await person.getByRole("button", { name: "Approve" }).click();
await person.getByRole("heading", { name: "The terminal is signed in" }).waitFor();
await new Promise((resolve) => setTimeout(resolve, 5_100));
const granted: { access_token?: string } = await (
  await terminal("/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: shownByTerminal.device_code,
    client_id: "keeltown",
  })
).json();
expectEqual(
  "device: the terminal is given its session, and the page none of it",
  `${typeof granted.access_token} ${String((await person.content()).includes(granted.access_token ?? "none"))}`,
  "string false",
);

// ─── Orgs: an org's home, making one, its members and invitations, its settings ───
// A person needs no org. Ada's own handle is her account: her projects live under it, and the page never calls
// it an org, gives it no members and no settings.
await person.goto(`${built}/ada`, { waitUntil: "domcontentloaded" });
await person.getByRole("heading", { level: 1 }).first().waitFor();
expectEqual(
  "account: a person's own handle is their projects, with nothing of an org on the page",
  `${squash(await person.locator("header").first().innerText())} | ${squash(await person.locator("main header").innerText())} | ${await person.getByRole("navigation", { name: "Org" }).count()} org tabs | ${await person
    .getByRole("main")
    .getByText(/\borg\b/i)
    .count()} mentions of an org`,
  "Keel / ada ada | Your projects ada | 0 org tabs | 0 mentions of an org",
);
for (const tab of ["members", "settings"]) {
  // oxlint-disable-next-line no-await-in-loop -- one page after the other
  await person.goto(`${built}/orgs/ada/${tab}`, { waitUntil: "domcontentloaded" });
  // oxlint-disable-next-line no-await-in-loop -- as above
  await person.getByRole("heading", { level: 1 }).waitFor();
  expectEqual(
    `account: a person's own account has no ${tab} page of an org's`,
    // oxlint-disable-next-line no-await-in-loop -- as above
    `${squash(await person.getByRole("heading", { level: 1 }).innerText())} | ${await person.getByRole("main").getByRole("button").count()} buttons | ${(await person.getByRole("main").getByRole("link").allInnerTexts()).map(squash).join(", ")}`,
    "This is your own account | 0 buttons | Your projects, Make an org",
  );
}

// Making one. A handle a person has is not an org's to take, her own included: Keel refuses it when the org is
// made, and the form says Keel's sentence.
await person.goto(`${built}/new/org`, { waitUntil: "domcontentloaded" });
await person.getByLabel("Name").fill("Lovelace");
await person.getByLabel("Handle").fill("ada");
await Promise.all([
  person.waitForResponse((answer) => answer.url().endsWith("/organization/create")),
  person.getByRole("button", { name: "Make the org" }).click(),
]);
// Keel has answered. What the form then says is read, whatever it is: a wait for the refusal alone would stop
// the run where there is none.
await person
  .getByRole("alert")
  .waitFor({ timeout: 5000 })
  .catch(() => undefined);
expectEqual(
  "account: an org made with a handle a person has is refused in Keel's own sentence",
  `${new URL(person.url()).pathname} ${(await person.getByRole("alert").count()) === 0 ? "no refusal" : squash(await person.getByRole("alert").innerText())}`,
  `/new/org "ada" is taken: a handle is one person's, one agent's or one org's`,
);
await person.getByLabel("Handle").fill("lovelace");
await shot(person, "new-org");
await person.getByRole("button", { name: "Make the org" }).click();
await person.getByRole("heading", { level: 1, name: /^Lovelace/ }).waitFor();
expectEqual(
  "orgs: made, at an address of its own, and its maker is its owner",
  `${whereOf(person)} ${squash(await person.getByRole("heading", { level: 1 }).innerText())}`,
  "/lovelace Lovelace owner",
);

// The dropdown is offered once Keel has said which orgs the reader is in, and not before: opened sooner, it would
// be a menu without them. Keel's answer is held back here to see that.
let listOrgs = (): void => {};
const listHeld = new Promise<void>((resolve) => {
  listOrgs = resolve;
});
await person.route("**/v1/auth/organization/list", async (route) => {
  await listHeld;
  await route.fallback();
});
await person.reload({ waitUntil: "domcontentloaded" });
await person.getByRole("heading", { level: 1, name: /^Lovelace/ }).waitFor();
expectEqual(
  "orgs: until Keel has listed the reader's orgs, no dropdown is offered beside the org's name",
  String(await person.getByRole("button", { name: "Switch account" }).count()),
  "0",
);
listOrgs();

// Beside the org's name, the reader's other orgs, a click away: the same dropdown the project's name has.
await person.getByRole("button", { name: "Switch account" }).click();
await person.getByRole("menuitem", { name: "New org" }).waitFor();
expectEqual(
  "account: the frame drops down to the person's own handle first, marked as theirs, then their orgs, then making one",
  (await person.getByRole("menuitem").allInnerTexts()).map(squash).join(" | "),
  "ada you | lovelace Lovelace | New org",
);
await shot(person, "org-switcher");
await person.getByRole("menuitem", { name: /^ada/ }).click();
await person.waitForURL(`${built}/ada`);
expectEqual("orgs: and goes to the one chosen", whereOf(person), "/ada");

// A second person signs up, in a browser of her own.
const second = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await asDeployed(second, { keel: shut, sent: sentToKeel });
const grace = watch(await second.newPage(), "account, a second user");
await grace.goto(`${built}/signup`, { waitUntil: "domcontentloaded" });
await grace.getByLabel("Email").fill("grace@example.com");
await grace.getByRole("button", { name: "Send a code" }).click();
await grace.getByLabel("The code sent to grace@example.com").waitFor();
await grace
  .getByLabel("The code sent to grace@example.com")
  .fill(identity.outbox.at(-1)?.otp ?? "");
await grace.getByRole("button", { name: "Create the account" }).click();
await grace.getByRole("heading", { name: "Choose your handle" }).waitFor();
await grace.getByLabel("Handle").fill("grace");
await grace.getByRole("button", { name: "Take this handle" }).click();
await grace.waitForURL(`${built}/`);

// Ada invites her by handle. Nobody types another person's address, and none is shown.
await person.goto(`${built}/orgs/lovelace/members`, { waitUntil: "domcontentloaded" });
await person.getByLabel("Invite by handle").fill("nobody-here");
await person.getByRole("button", { name: "Invite", exact: true }).click();
await person.getByText('No one has the handle "nobody-here"').waitFor();
await person.getByLabel("Invite by handle").fill("grace");
await person.getByLabel("Role for the invitation").selectOption("maintainer");
await person.getByRole("button", { name: "Invite", exact: true }).click();
const link = person.locator("[data-invitation-link]");
await link.waitFor();
const invitation = new URL(await link.innerText());
expectEqual(
  "orgs: an invitation has an address of its own, on this console",
  `${invitation.origin === built} ${/^\/invite\/[\w-]+$/.test(invitation.pathname)}`,
  "true true",
);
expectEqual(
  "orgs: it is told by the handle it was made to, and no address is on the page",
  `${squash(await person.getByRole("list", { name: "Invitations not yet answered" }).innerText()).startsWith("grace invited as maintainer")} ${String((await person.content()).includes("@example.com"))}`,
  "true false",
);
await shot(person, "members");

// The link is the invitation's address. A visitor who opens it signs in first, and comes back to it.
const passerBy = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await asDeployed(passerBy, { keel: shut });
const stranger = watch(await passerBy.newPage(), "account, a visitor with an invitation's link");
await stranger.goto(invitation.href, { waitUntil: "domcontentloaded" });
await stranger.getByRole("heading", { name: "Sign in to Keel" }).waitFor();
expectEqual(
  "orgs: a visitor with the link is sent to sign in, and back to the invitation",
  whereOf(stranger),
  `/login?next=${encodeURIComponent(invitation.pathname)}`,
);
await passerBy.close();
// Whoever made it is not who it was made to: Keel reads it to her alone.
await person.goto(invitation.href, { waitUntil: "domcontentloaded" });
await person.getByRole("heading", { name: "This invitation is not open to you" }).waitFor();
expectEqual(
  "orgs: someone else with the link is shown nothing of the invitation",
  String((await person.locator("main").innerText()).includes("Lovelace")),
  "false",
);

await grace.goto(invitation.href, { waitUntil: "domcontentloaded" });
await grace.getByRole("heading", { name: "Join Lovelace?" }).waitFor();
await shot(grace, "invite");
await grace.getByRole("button", { name: "Join" }).click();
await grace.getByRole("heading", { level: 1, name: /^Lovelace/ }).waitFor();
expectEqual(
  "orgs: joined, with the role the invitation gave",
  `${whereOf(grace)} ${squash(await grace.getByRole("heading", { level: 1 }).innerText())}`,
  "/lovelace Lovelace maintainer",
);
/** An invitation's page where it is no longer one to answer: its heading, and what is said under it. */
const closedOf = async (shown: Page): Promise<string> => {
  await shown.getByRole("heading", { level: 1 }).waitFor();
  return `${squash(await shown.getByRole("heading", { level: 1 }).innerText())}: ${squash(await shown.locator("main h1 + p").innerText())}`;
};
// The link still opens. Keel tells her what became of the invitation, and the page says it in Keel's words.
await grace.goto(invitation.href, { waitUntil: "domcontentloaded" });
expectEqual(
  "orgs: answered, the invitation says so to the person it was made to, in Keel's own words",
  await closedOf(grace),
  "This invitation has been answered: This invitation was already accepted",
);

// The owner changes her role, and then removes her.
await person.goto(`${built}/orgs/lovelace/members`, { waitUntil: "domcontentloaded" });
const members = person.getByRole("list", { name: "Members of this org" });
await person.getByLabel("Role of grace").waitFor();
expectEqual(
  "orgs: the owner sees both members, by handle, and the second one's role",
  `${await members.getByRole("listitem").count()} ${await person.getByLabel("Role of grace").inputValue()} ${String((await person.content()).includes("@example.com"))}`,
  "2 maintainer false",
);
await Promise.all([
  person.waitForResponse((answer) => answer.url().endsWith("/organization/update-member-role")),
  person.getByLabel("Role of grace").selectOption("member"),
]);
await grace.goto(`${built}/orgs/lovelace/members`, { waitUntil: "domcontentloaded" });
await grace.getByRole("list", { name: "Members of this org" }).waitFor();
expectEqual(
  "orgs: made a member, she is one, and is offered no way to invite or remove",
  `${squash(await grace.getByRole("heading", { level: 1 }).innerText())} ${await grace.getByRole("button", { name: /^(Invite|Remove)$/ }).count()}`,
  "Lovelace member 0",
);
await members.getByRole("button", { name: "Remove" }).click();
await person.waitForFunction(
  () => document.querySelectorAll('ul[aria-label="Members of this org"] > li').length === 1,
);
await grace.goto(`${built}/lovelace`, { waitUntil: "domcontentloaded" });
await grace.getByRole("main").getByRole("heading").first().waitFor();
expectEqual(
  "orgs: removed, the org is to her what it is to anyone: an org of that handle, with no project she may see",
  `${await handlePage(grace)} | ${await grace.getByRole("navigation", { name: "Org" }).count()}`,
  "lovelace Org | Projects This org has no project you may see. | 0",
);

// Ada invites her again, as an owner, and nobody answers in time. Keel says it has lapsed, and so does the page.
const inviteAsOwner = async (): Promise<URL> => {
  await person.getByLabel("Invite by handle").fill("grace");
  await person.getByLabel("Role for the invitation").selectOption("owner");
  await person.getByRole("button", { name: "Invite", exact: true }).click();
  await link.waitFor();
  return new URL(await link.innerText());
};
const late = await inviteAsOwner();
await identity.lapse(late.pathname.slice("/invite/".length));
await grace.goto(late.href, { waitUntil: "domcontentloaded" });
expectEqual(
  "orgs: lapsed, the invitation says so to the person it was made to, in Keel's own words",
  await closedOf(grace),
  "This invitation has lapsed: This invitation has lapsed; ask the org for a new one",
);
await person.getByRole("button", { name: "Withdraw" }).click();
await link.waitFor({ state: "detached" });
const asOwner = await inviteAsOwner();
await grace.goto(asOwner.href, { waitUntil: "domcontentloaded" });
await grace.getByRole("button", { name: "Join" }).click();
await grace.getByRole("heading", { level: 1, name: /^Lovelace/ }).waitFor();

// An org always has an owner. With two, each is offered a way out; the other owner takes hers first, and Ada's
// page is behind. Keel refuses the only owner, and the page says so in Keel's words, with the way forward it gave.
await person.goto(`${built}/orgs/lovelace/members`, { waitUntil: "domcontentloaded" });
const leave = person.getByRole("button", { name: "Leave" });
await leave.waitFor();
await grace.goto(`${built}/orgs/lovelace/members`, { waitUntil: "domcontentloaded" });
await grace.getByRole("button", { name: "Leave" }).click();
await grace.waitForURL(`${built}/settings`);
await leave.click();
await Promise.race([person.getByRole("alert").waitFor(), person.waitForURL(`${built}/settings`)]);
const refusedToLeave = person.getByRole("alert");
expectEqual(
  "orgs: the only owner is refused in Keel's own words, and is still on the org's page",
  `${whereOf(person)} ${(await refusedToLeave.count()) === 0 ? "nothing said" : squash(await refusedToLeave.locator("p").innerText())}`,
  "/orgs/lovelace/members An org always has an owner: make another member an owner before you leave or step down",
);
const wayForward = person.getByRole("list", { name: "Ways forward Keel gave" });
expectEqual(
  "orgs: under the refusal is the way forward Keel gave",
  (await wayForward.count()) === 0 ? "none" : squash(await wayForward.innerText()),
  "Make another member an owner first",
);
await shot(person, "only-owner");

// Deleting an org is deliberate: its handle is typed first.
await person.goto(`${built}/orgs/lovelace/settings`, { waitUntil: "domcontentloaded" });
const deleting = person.getByRole("button", { name: "Delete this org" });
await deleting.waitFor();
expectEqual(
  "orgs: deleting waits for the org's handle to be typed",
  String(await deleting.isDisabled()),
  "true",
);
await person.getByLabel(/^Type lovelace to delete it/).fill("lovelace");
await shot(person, "org-settings");
await deleting.click();
await person.waitForURL(`${built}/settings`);
await person.goto(`${built}/lovelace`, { waitUntil: "domcontentloaded" });
await person.getByRole("heading", { name: "There is no lovelace here" }).waitFor();
expectEqual("orgs: deleted, it is no longer there", whereOf(person), "/lovelace");

// ─── A project, to a member of its org and to someone who is not ───
// Ada's browser reads the Keel on which her org keeps the project private. She is a member, by the session she
// signed in with above, so Keel shows it to her: on her org's home, at its own address, and in the frame.
// Her home says first what Keel has put to her, across her projects: the question by Keel's label, under its
// project, and a link to its own page, where it is answered.
/** How many times this Keel has been asked for someone's questions. */
const listsAsked = (): number =>
  shut.calls.filter((call) => call.path === "/v1/escalations").length;
await person.goto(`${built}/`, { waitUntil: "domcontentloaded" });
const hers = waitingOn(person).getByRole("listitem");
await hers
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "member: her home lists first the question Keel has put to her, by Keel's label and under its project, and it leads to the question's own page",
  (await hers.count()) === 1
    ? `${QUESTION_ASKED.test(await hers.getByRole("link").first().innerText()) ? "the question" : "another"} | ${squash(await hers.locator("b").innerText())} | ${squash(await hers.getByRole("link").nth(1).innerText())} | ${(await hers.getByRole("link").first().getAttribute("href")) ?? ""}`
    : `${await hers.count()} listed`,
  "the question | E-1 | ada/demo | /ada/demo/escalations/E-1",
);
expectEqual(
  "member: the questions come before her projects on the home",
  String(
    await person.evaluate(() => {
      const waiting = document.querySelector('section[aria-label="Waiting for you"]');
      const projects = document.querySelector('ul[aria-label="Your projects"]');
      return waiting !== null && projects !== null
        ? (waiting.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        : null;
    }),
  ),
  "true",
);
await shot(person, "home-waiting");
// On a phone the row wraps and nothing runs past the screen.
await person.setViewportSize({ width: 390, height: 844 });
// The page's column scrolls by itself, so what is measured is the list: nothing of it lies right of the screen.
expectEqual(
  "member: at a phone's width the question's row wraps, and nothing of the list runs past the screen",
  String(
    await person.evaluate(() => {
      const waiting = document.querySelector('section[aria-label="Waiting for you"]');
      if (waiting === null) return "no list";
      const drawn = [waiting, ...waiting.querySelectorAll("*")];
      return (
        Math.max(...drawn.map((part) => part.getBoundingClientRect().right)) <= window.innerWidth
      );
    }),
  ),
  "true",
);
await shot(person, "home-waiting-phone");
await person.setViewportSize({ width: 1280, height: 900 });

await person.goto(`${built}/ada`, { waitUntil: "domcontentloaded" });
await person.getByRole("list", { name: "Projects" }).getByRole("link").first().waitFor();
expectEqual(
  "member: her org's home lists its projects, the private ones too",
  squash(await person.getByRole("list", { name: "Projects" }).innerText()),
  "demo private",
);
await person.getByRole("list", { name: "Projects" }).getByRole("link", { name: "demo" }).click();
await person.locator(".a-prose h2").first().waitFor();
await counted(person);
expectEqual(
  "member: a private project of her org opens, with its code and what is open",
  `${pathOf(person)} | ${await filesOn(person)} | ${(await tabsOf(person).allInnerTexts()).map(squash).join(" | ")}`,
  // Ada owns the project's org, so the frame offers her its settings. A visitor's frame, above, has six tabs.
  `/ada/demo | src | package.json | README.md | ${OPEN_ON_TABS} | Settings`,
);
expectEqual(
  "member: the frame names the org, the project and who is reading",
  squash(await person.locator("header").first().innerText()).split(" Code ")[0] ?? "",
  "Keel / ada / demo private Fork Live ada",
);
// Beside the project's name, the org's projects; beside the org's, the reader's orgs: a code host's frame.
await person.getByRole("button", { name: "Switch project" }).click();
await person.getByRole("menuitem").first().waitFor();
expectEqual(
  "member: the frame drops down on the project, to the org's projects and to all of them",
  `${(await person.getByRole("menuitem").allInnerTexts()).map(squash).join(" | ")} → ${(
    await person
      .getByRole("menuitem")
      .evaluateAll((items) => items.map((item) => item.getAttribute("href")))
  ).join(" | ")}`,
  "demo private | All projects of ada → /ada/demo | /ada",
);
await shot(person, "switcher");
await person.keyboard.press("Escape");
await person.getByRole("button", { name: "Switch account" }).click();
await person.getByRole("menuitem", { name: "New org" }).waitFor();
expectEqual(
  "member: and on the org, to her orgs and to making one",
  (await person.getByRole("menuitem").allInnerTexts()).map(squash).join(" | "),
  "ada you | New org",
);
await person.keyboard.press("Escape");

// The question. Keel's answer about the project named her a member, so its options can be tapped.
await person.goto(`${built}/ada/demo/escalations/E-1`, { waitUntil: "domcontentloaded" });
await person.getByRole("heading", { level: 1, name: QUESTION_ASKED }).waitFor();
// A second tab is left on her home while she answers in this one. It reads the list as it arrives and once
// more at the end of Keel's log as it stood, and then holds one read of her feed open: nothing is asked by a clock.
const listsBefore = listsAsked();
const homeOpen = watch(await lobby.newPage(), "member, her home left open");
await homeOpen.goto(`${built}/`, { waitUntil: "domcontentloaded" });
await waitingOn(homeOpen)
  .getByRole("listitem")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
for (let tries = 0; tries < 100 && listsAsked() - listsBefore < 2; tries += 1)
  // oxlint-disable-next-line no-await-in-loop -- waiting on the page's own reads
  await new Promise((resolve) => setTimeout(resolve, 100));
await new Promise((resolve) => setTimeout(resolve, 2_500));
expectEqual(
  "member: her open home asks for the list on arriving and at the end of Keel's log, and not again while the log says nothing",
  `${listsAsked() - listsBefore} reads | ${await waitingSaid(homeOpen)}`,
  "2 reads | 0 | 1 listed",
);
expectEqual(
  "built: the parked changes, by Keel's numbers",
  String(await person.getByText("parked on this: #1 and #2").count()),
  "1",
);
expectEqual(
  "built: the default is said",
  String(await person.getByText("Both changes wait. Nothing lands on this subject.").count()),
  "1",
);
expectEqual(
  "member: options can be tapped",
  String(await person.locator(".a-option:enabled").count()),
  "3",
);
// The QR code beside it is for answering from a phone. What it says is this page's address, and nothing else:
// no key and no capability. Whoever opens it signs in, and Keel decides whether they may answer.
const answering = person.getByRole("region", { name: "Answer" });
/** The marks a QR code of `text` is made of, as the page draws one: so what a code on the page says can be told. */
const marksOf = (text: string): string => {
  let marks = "";
  encode(text, { ecc: "M", border: 2 }).data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) marks += `M${x} ${y}h1v1h-1z`;
    });
  });
  return marks;
};
expectEqual(
  "member: one QR code is offered with the question, and what it says is this page's own address",
  String(
    (await qrOn(person).count()) === 1 &&
      (await qrOn(person).locator("path").getAttribute("d")) ===
        marksOf(`${built}/ada/demo/escalations/E-1`),
  ),
  "true",
);
expectEqual(
  "member: the address is written beside it",
  (await answering.getByRole("link").last().getAttribute("href")) ?? "",
  `${built}/ada/demo/escalations/E-1`,
);
await shot(person, "question");

// Grace is signed in too, and is in no org of the project's. A private project is to her as it is to a visitor.
expectEqual(
  "stranger: a private project of another's org is told as none is",
  await toldAt(grace, "ada", "demo"),
  told.none,
);
// On the Keel where the project is public she is signed in and still no member: the question is not hers to read.
const visiting = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await visiting.addCookies(await second.cookies());
await asDeployed(visiting, { keel: open });
const guest = watch(await visiting.newPage(), "built, a stranger");
await guest.goto(`${built}/ada/demo/escalations/E-1`, { waitUntil: "domcontentloaded" });
await guest.getByRole("main").getByRole("heading").last().waitFor();
await countedPublic(guest);
expectEqual(
  "stranger: a public project's question is its members' to read, and someone signed in who is none is told so",
  `${squash(await guest.getByRole("main").innerText()).split(" A question")[0] ?? ""} | ${await guest.locator(".a-option").count()} options, ${await guest.getByRole("link", { name: "Sign in" }).count()} ways in offered`,
  `Escalation E-1 ${FOR_MEMBERS} | 0 options, 0 ways in offered`,
);
// And her own home lists her none of it: Keel lists a question to the person it was put to and to the
// namespace's maintainers.
await guest.goto(`${built}/`, { waitUntil: "domcontentloaded" });
await waitingOn(guest)
  .getByText(NONE_WAITING)
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "stranger: someone signed in who is no member of a project is listed no question of it",
  await waitingSaid(guest),
  "1 | 0 listed",
);
// She may fork it. A public project is forked by anyone signed in, into a namespace of theirs: Keel is asked
// for a fork by its own id for the source, and what it makes is private, though its source is not.
const forksOfOpen = (): Call[] =>
  open.calls.filter((call) => call.method === "POST" && call.path === "/v1/projects");
await guest.goto(`${built}/ada/demo/fork`, { waitUntil: "domcontentloaded" });
await guest
  .getByRole("heading", { level: 1, name: "Fork ada/demo" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
const publicId: string = await guest.evaluate(async () => {
  const answer: { id?: string } = await (await fetch("/v1/namespaces/ada/projects/demo")).json();
  return answer.id ?? "no id";
});
const ownerOfFork = await guest
  .getByLabel("Owner")
  .inputValue({ timeout: 5_000 })
  .catch(() => "no owner");
const forksBefore = forksOfOpen().length;
await guest
  .getByRole("button", { name: "Fork the project" })
  .click({ timeout: 5_000 })
  .catch(() => undefined);
await guest.waitForURL(`${built}/grace/demo`, { timeout: 10_000 }).catch(() => undefined);
await guest
  .getByRole("navigation", { name: "Project" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "fork: someone signed in who is no member forks a public project into their own account, by Keel's id for it, and lands on the fork, which is private",
  `${ownerOfFork} | ${pathOf(guest)} | ${(forksOfOpen().at(-1)?.body ?? "nothing sent").replace(publicId, "{the source's id}")} | ${forksOfOpen().length - forksBefore} asked | ${await guest.getByText("private", { exact: true }).count()} private`,
  'grace | /grace/demo | {"namespace":"grace","name":"demo","source":{"kind":"fork","project":"{the source\'s id}"}} | 1 asked | 1 private',
);
expectEqual(
  "fork: its own page says which project it was forked from, linked to that project",
  (
    await guest
      .locator('[data-part="forked-from"]')
      .evaluateAll((all) =>
        all.map(
          (one) =>
            `${one.textContent ?? ""} | ${new URL(one.querySelector("a")?.href ?? "about:blank").pathname}`,
        ),
      )
  )
    .map(squash)
    .join(" || "),
  "forked from ada/demo | /ada/demo",
);
await visiting.close();
await second.close();

// Ada answers. Not the option a script would have chosen: what lands must be what was tapped.
await person.locator(".a-option", { hasText: "Never cache permission checks" }).click();
await person
  .getByRole("heading", { name: "Ruled: Never cache permission checks" })
  .waitFor({ timeout: 15_000 });
// The tab left on her home hears of it from Keel's log, and reads the list again: the question is gone from it
// with no reload.
await waitingOn(homeOpen)
  .getByText(NONE_WAITING)
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "member: answered in one tab, the question leaves her home in the other with no reload, because Keel's log said so",
  await waitingSaid(homeOpen),
  "1 | 0 listed",
);
await homeOpen.close();
expectEqual(
  "Keel: one ruling, the member's",
  shut
    .events()
    .flatMap((event) => (event.type === "RulingGiven" ? [event.payload.option] : []))
    .join(","),
  "no-cache",
);
const rulings = shut.calls.filter((call) => call.path.endsWith("/ruling"));
expectEqual(
  "Keel: ruled by its own operation, as whoever is signed in: nothing of the page's on it but a key to make a retry the same answer",
  String(
    rulings.length === 1 &&
      /^\/v1\/escalations\/[^/]+\/ruling$/.test(rulings[0]?.path ?? "") &&
      rulings[0]?.authorization === "" &&
      (rulings[0]?.idempotencyKey ?? "") !== "",
  ),
  "true",
);
expectEqual(
  "Keel: and nobody ruled on the Keel a visitor and a stranger read",
  String(open.events().filter((event) => event.type === "RulingGiven").length),
  "0",
);

// A live console's clock is the wall clock. Keel writes nothing more from here, and the page still moves on:
// a second after the log's last entry one change has landed in the last minute, and a minute later none has.
const logEnded = Date.parse(shut.events().at(-1)?.at ?? "");
const later = watch(await lobby.newPage(), "member, as time passes");
await later.clock.install({ time: new Date(logEnded + 1_000) });
await later.goto(`${built}/ada/demo/mission-control`, { waitUntil: "domcontentloaded" });
await later.locator("dl.a-trunk-line").waitFor({ timeout: 10_000 });
const landedLately = async (): Promise<string> => statOn(later, "Landed per minute");
/** Reads the rate until it is `wanted`, or for three seconds: a rate that never moves is a failed check, by name. */
const settlesAt = async (wanted: string): Promise<string> => {
  for (let tries = 0; tries < 30 && (await landedLately()) !== wanted; tries += 1)
    // oxlint-disable-next-line no-await-in-loop -- waiting on the page's own clock
    await later.clock.runFor(100);
  return landedLately();
};
expectEqual(
  "live: just after the log's last entry, the landing in the minute before it is counted",
  await settlesAt("1"),
  "1",
);
await later.clock.fastForward(61_000);
expectEqual(
  "live: a minute on with nothing new from Keel, nothing has landed in the last minute",
  await settlesAt("0"),
  "0",
);
await later.close();

// ── The project's settings ──
// Keel holds them. It reads them to Ada as a member of the project's org, and lets her replace them as its owner.
await person.goto(`${built}/ada/demo/settings`, { waitUntil: "domcontentloaded" });
const whoReads = person.getByRole("region", { name: "Who may read this project" });
await whoReads.waitFor();
const readersSaid = async (): Promise<string> =>
  squash(await whoReads.locator("p").first().innerText());
const frameSaid = async (): Promise<string> =>
  squash(await person.locator("header").first().innerText()).split(" Code ")[0] ?? "";
expectEqual(
  "settings: the page says who may read the project, as Keel holds it, under its own tab",
  `${pathOf(person)} | ${await readersSaid()} | ${squash(await person.getByRole("navigation", { name: "Project" }).locator('[aria-current="page"]').innerText())}`,
  "/ada/demo/settings | private Only ada reads it. | Settings",
);
expectEqual(
  "settings: and the rest of what Keel holds for it",
  squash(
    await person.getByRole("region", { name: "What Keel holds for this project" }).innerText(),
  ),
  "What Keel holds for this project Verification Required: the lane verifies each batch before it lands. Largest batch 8 changes Protected paths infra/** Only Keel changes these. A change that touches one is refused at precheck.",
);
const publishing = person.getByRole("button", { name: "Make public" });
expectEqual(
  "settings: making a project public waits for its name to be typed",
  String(await publishing.isDisabled()),
  "true",
);
await person.getByLabel(/^Type demo to make it public/).fill("dem");
expectEqual("settings: and for the whole of it", String(await publishing.isDisabled()), "true");
await person.getByLabel(/^Type demo to make it public/).fill("demo");
await shot(person, "project-settings");
await publishing.click();
const hiding = person.getByRole("button", { name: "Make private" });
await hiding.waitFor();
// The frame is redrawn a moment after the page. It is given that moment, and whatever it then says is compared.
await person
  .locator("header")
  .first()
  .getByText("public", { exact: true })
  .waitFor({ timeout: 2_000 })
  .catch(() => undefined);
expectEqual(
  "settings: made public, the page and the frame say what Keel answered",
  `${await readersSaid()} | ${await frameSaid()}`,
  "public Anyone reads its code and its log, signed in or not. | Keel / ada / demo public Fork Live ada",
);
const replaced = shut.calls.filter((call) => call.method === "PUT");
expectEqual(
  "Keel: the settings were replaced whole, with who may read the project changed and nothing else, and nothing of the page's on the request",
  `${replaced.length} ${replaced[0]?.path === `/v1/projects/${shut.project.id}/settings`} ${replaced[0]?.authorization === ""} ${replaced[0]?.body}`,
  `1 true true ${JSON.stringify({ protectedPaths: ["infra/**"], maxBatchSize: 8, verification: "required", visibility: "public" })}`,
);
// Someone with no session, on the same Keel: the project is now theirs to read, and its settings are not.
const passing = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await asDeployed(passing, { keel: shut });
const passer = watch(await passing.newPage(), "built, a visitor once the project is public");
await passer.goto(`${built}/ada/demo`, { waitUntil: "domcontentloaded" });
await passer
  .locator(".a-tree li")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
await countedPublic(passer);
expectEqual(
  "settings: a visitor now reads the project, and is offered no settings",
  `${await filesOn(passer)} | ${await tabsOf(passer).count()} tabs`,
  "src | package.json | README.md | 7 tabs",
);
await passer.goto(`${built}/ada/demo/settings`, { waitUntil: "domcontentloaded" });
await passer.getByRole("heading", { level: 1, name: "Settings" }).waitFor();
await passer
  .getByRole("alert")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "settings: a visitor who opens their address is told Keel's refusal, and is offered nothing to change",
  `${squash(
    await passer
      .getByRole("alert")
      .innerText()
      .catch(() => "no refusal"),
  )} | ${await passer.getByRole("main").getByRole("button").count()} buttons`,
  "auth.required | 0 buttons",
);
// Private again is one click.
await hiding.click();
await publishing.waitFor();
expectEqual(
  "settings: one click makes it private again",
  `${await readersSaid()} | ${await frameSaid()} | ${shut.calls.filter((call) => call.method === "PUT").length}`,
  "private Only ada reads it. | Keel / ada / demo private Fork Live ada | 2",
);
expectEqual(
  "settings: and a visitor is told of it what they are told of a project that is not there",
  await toldAt(passer, "ada", "demo"),
  told.none,
);
await passing.close();

// ── Making a project ──
// Ada makes a project under her own handle, on a Keel she has made nothing on yet. It answers as Keel's handler
// does: the project once its trunk exists, or its refusal, and then no project. Whose a namespace is, whether a
// name is free and whether a repository can be imported are Keel's to say, and the page says them in its words.
const starting = createFakeKeel({ namespace: NAMESPACE, readerOf, whose: whoseHandle });
await asDeployed(lobby, { keel: starting, sent: sentToKeel });
const creates = (): Call[] =>
  starting.calls.filter((call) => call.method === "POST" && call.path === "/v1/projects");
const makeIt = person.getByRole("button", { name: "Make the project" });
/** Opens the form, and waits for it to have its owners. */
const newProject = async (query = ""): Promise<void> => {
  await person.goto(`${built}/new${query}`, { waitUntil: "domcontentloaded" });
  await person.getByRole("heading", { level: 1, name: "Make a project" }).waitFor();
};
/** What Keel refused, as the page says it, once it has: its sentence and the ways forward under it. */
const refusedOn = async (shown: Page): Promise<string> => {
  await shown
    .getByRole("alert")
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  return (await shown.getByRole("alert").count()) === 0
    ? "no refusal"
    : squash(await shown.getByRole("alert").innerText());
};
await newProject();
expectEqual(
  "new project: the owner is the reader's own account first, and nothing can be asked before there is a name",
  `${(await person.getByLabel("Owner").locator("option").allInnerTexts())[0] ?? "no owner"} | ${await person.getByLabel("Owner").inputValue()} | ${await makeIt.isDisabled()} | ${creates().length} asked`,
  "ada (you) | ada | true | 0 asked",
);
await person.getByLabel("Name").fill(" Notes ");
expectEqual(
  "new project: the form says the address the project will have, and starts from nothing unless told otherwise",
  `${await person.getByText(/\/ada\/notes$/).count()} | ${await person.getByLabel("Nothing").isChecked()} | ${await person.getByLabel("Repository address").count()} address asked`,
  "1 | true | 0 address asked",
);
await makeIt.click();
await person.waitForURL(`${built}/ada/notes`, { timeout: 10_000 }).catch(() => undefined);
await person
  .getByRole("navigation", { name: "Project" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "new project: Keel is asked by its own operation, under a key made for the attempt, and the reader lands on the project it made",
  `${pathOf(person)} | ${creates()[0]?.body ?? "nothing sent"} | ${/^console:new:[0-9a-f-]{36}$/.test(creates()[0]?.idempotencyKey ?? "")} | ${creates()[0]?.authorization === ""}`,
  '/ada/notes | {"namespace":"ada","name":"Notes","source":{"kind":"empty"}} | true | true',
);
// A name the namespace has: Keel's refusal, in its words, and the reader stays on the form.
await newProject("?owner=ada");
await person.getByLabel("Name").fill("NOTES");
await makeIt.click();
expectEqual(
  "new project: a name that is taken is refused in what Keel said, with its way forward, and nothing is made",
  `${await refusedOn(person)} | ${pathOf(person)}`,
  'ada already has a project named "notes" (names ignore letter case). Choose another name | /new',
);
// An address no public repository answers at. Asked again as it was, the attempt keeps its key.
await person.getByLabel("Name").fill("forge");
await person.getByLabel("A public Git repository").check();
await person.getByLabel("Repository address").fill("https://git.example/acme/private");
const beforeImport = creates().length;
await makeIt.click();
const toldOfImport = await refusedOn(person);
await makeIt.click();
for (let tries = 0; tries < 50 && creates().length < beforeImport + 2; tries += 1)
  // oxlint-disable-next-line no-await-in-loop -- waiting on the page
  await new Promise((resolve) => setTimeout(resolve, 100));
expectEqual(
  "new project: a repository Keel cannot import is refused in what Keel said, and asking again as it was keeps the attempt's key",
  `${toldOfImport} | ${
    new Set(
      creates()
        .slice(beforeImport)
        .map((call) => call.idempotencyKey),
    ).size
  } key for ${creates().length - beforeImport} asks`,
  "No public repository answers at that URL. A private one reads the same. Nothing was imported, and no project was made (not-found). Check the URL names a public repository, then create the project again | 1 key for 2 asks",
);
// The address corrected, with a branch named: another request, under another key, and Keel makes the project.
await person.getByLabel("Repository address").fill(PUBLIC_REPOSITORY);
await person.getByLabel("Branch").fill("main");
await makeIt.click();
await person.waitForURL(`${built}/ada/forge`, { timeout: 10_000 }).catch(() => undefined);
expectEqual(
  "new project: a public repository is imported from the address and the branch given, under a key of its own",
  `${pathOf(person)} | ${creates().at(-1)?.body ?? "nothing sent"} | ${new Set(creates().map((call) => call.idempotencyKey)).size} keys for ${creates().length} asks`,
  `/ada/forge | {"namespace":"ada","name":"forge","source":{"kind":"import","url":"${PUBLIC_REPOSITORY}","ref":"main"}} | 4 keys for 5 asks`,
);
// Her own page lists what she made, and has the way to the form with her as its owner.
await person.goto(`${built}/ada`, { waitUntil: "domcontentloaded" });
await person.getByRole("link", { name: "New project" }).waitFor();
expectEqual(
  "new project: a person's own page has the way to the form, with them as the owner",
  await person
    .getByRole("link", { name: "New project" })
    .evaluate((to) =>
      to instanceof HTMLAnchorElement
        ? `${new URL(to.href).pathname}${new URL(to.href).search}`
        : "not a link",
    ),
  "/new?owner=ada",
);
// ── A fork, at the project's own address ──
// A project's frame has the way to fork it. The form there is the one that makes a project, with the source
// named: it starts under the source's name, and offers no other way to start.
const forkIt = person.getByRole("button", { name: "Fork the project" });
await person.goto(`${built}/ada/demo`, { waitUntil: "domcontentloaded" });
await person
  .getByRole("navigation", { name: "Project" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "fork: a project's frame has the way to fork it, at the project's own address",
  (await person
    .getByRole("link", { name: "Fork", exact: true })
    .first()
    .getAttribute("href", { timeout: 5_000 })
    .catch(() => null)) ?? "no way to fork",
  "/ada/demo/fork",
);
await person.goto(`${built}/ada/demo/fork`, { waitUntil: "domcontentloaded" });
await person
  .getByRole("heading", { level: 1, name: "Fork ada/demo" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
await shot(person, "fork");
expectEqual(
  "fork: the form names the project forked, starts under its name, says the fork starts private, and offers no other start",
  `${squash(await person.getByRole("heading", { level: 1 }).first().innerText())} | ${await person
    .getByLabel("Name")
    .inputValue({ timeout: 5_000 })
    .catch(
      () => "no name",
    )} | ${await person.getByText(/It starts private/).count()} | ${await person.locator('input[name="start"]').count()} starts`,
  "Fork ada/demo | demo | 1 | 0 starts",
);
// Under the name its source has in that namespace, Keel refuses it as it refuses any name taken, and the
// reader stays on the form.
const beforeFork = creates().length;
await forkIt.click({ timeout: 5_000 }).catch(() => undefined);
expectEqual(
  "fork: Keel's refusal of a fork is said in its words, with its way forward, and nothing is made",
  `${await refusedOn(person)} | ${pathOf(person)}`,
  'ada already has a project named "demo" (names ignore letter case). Choose another name | /ada/demo/fork',
);
// Under a name of its own it is made, in the source's own namespace, which is where a private project forks.
await person
  .getByLabel("Name")
  .fill("demo-fork", { timeout: 5_000 })
  .catch(() => undefined);
await forkIt.click({ timeout: 5_000 }).catch(() => undefined);
await person.waitForURL(`${built}/ada/demo-fork`, { timeout: 10_000 }).catch(() => undefined);
await person
  .getByRole("navigation", { name: "Project" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "fork: Keel is asked for a fork of the project by its own id, under a key made for the attempt, and the reader lands on the fork",
  `${pathOf(person)} | ${(creates().at(-1)?.body ?? "nothing sent").replace(/prj_[0-9A-Z]{26}/, "{id}")} | ${creates().length - beforeFork} asked | ${/^console:new:[0-9a-f-]{36}$/.test(creates().at(-1)?.idempotencyKey ?? "")} | ${creates().at(-1)?.authorization === ""}`,
  '/ada/demo-fork | {"namespace":"ada","name":"demo-fork","source":{"kind":"fork","project":"{id}"}} | 2 asked | true | true',
);
const forkedFrom = squash(
  (await person.locator('[data-part="forked-from"]').allInnerTexts()).join(" || "),
);
await person.goto(`${built}/ada/demo`, { waitUntil: "domcontentloaded" });
await person
  .getByRole("navigation", { name: "Project" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "fork: a fork of a private project names its source to the member who made it, and a project that is no fork names none",
  `${forkedFrom} | ${await person.locator('[data-part="forked-from"]').count()} on its source`,
  "forked from ada/demo | 0 on its source",
);
// A project Keel does not read this person has no fork to offer: it is told as no project, as it is anywhere.
await person.goto(`${built}/ada/none/fork`, { waitUntil: "domcontentloaded" });
await person
  .getByRole("heading", { level: 1 })
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "fork: a project that is not there has no fork, and is said to be none",
  `${squash(await person.getByRole("heading", { level: 1 }).first().innerText())} | ${await forkIt.count()} forms`,
  "There is no project ada/none here | 0 forms",
);
// A visitor is sent to sign in, and back to the form.
const outside = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await asDeployed(outside, { keel: starting });
const unsigned = watch(await outside.newPage(), "built, a visitor at the form");
await unsigned.goto(`${built}/new`, { waitUntil: "domcontentloaded" });
await unsigned.waitForURL(/\/login/, { timeout: 10_000 }).catch(() => undefined);
expectEqual(
  "new project: a visitor is sent to sign in, and back to the form",
  `${new URL(unsigned.url()).pathname}${new URL(unsigned.url()).search}`,
  "/login?next=%2Fnew",
);
await outside.close();

// Whatever the page asked of Keel, of its identity or of anything else, it put no credential of its own on it.
expectEqual(
  "account: the page sent Keel no Authorization",
  String(sentToKeel.filter((request) => request.authorization !== undefined).length),
  "0",
);
expectEqual(
  "account: on its identity, its projects, their code and logs, the ruling, and the settings",
  String(
    sentToKeel.some((request) => request.path.startsWith("/v1/auth/")) &&
      sentToKeel.some((request) => request.path === "/v1/projects") &&
      sentToKeel.some((request) => request.path === "/v1/events") &&
      sentToKeel.some((request) => request.path.endsWith("/ruling")) &&
      sentToKeel.some((request) => request.path.endsWith("/settings")),
  ),
  "true",
);
await lobby.close();

// A Keel that cannot send email yet offers a passkey and nothing else: keel.town as it first served identity. A
// new person signs up there with a handle and a passkey made on their own device, and is asked for no address.
const passkeysAlone = createIdentity(built, { emailCodes: false });
const door = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const sentAtTheDoor: Sent[] = [];
await asDeployed(door, { keel: open, identity: passkeysAlone, sent: sentAtTheDoor });
const newcomer = watch(await door.newPage(), "account, on a Keel with passkeys alone");
const authenticator = await door.newCDPSession(newcomer);
await authenticator.send("WebAuthn.enable");
/** A device that makes and keeps passkeys, and answers for its person at once. */
const DEVICE = {
  protocol: "ctap2",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
} as const;
const { authenticatorId: firstDevice } = await authenticator.send(
  "WebAuthn.addVirtualAuthenticator",
  { options: DEVICE },
);
await newcomer.goto(`${built}/signup`, { waitUntil: "domcontentloaded" });
await newcomer.getByLabel("Handle").waitFor();
// The page has asked Keel which ways in it offers, and Keel has not said: so a passkey, and no other.
while (!sentAtTheDoor.some((request) => request.path === "/v1/auth/methods"))
  // oxlint-disable-next-line no-await-in-loop -- waiting on the page's own request
  await new Promise((resolve) => setTimeout(resolve, 50));
await newcomer.waitForTimeout(300);
expectEqual(
  "passkey sign-up: no way in is shown that this Keel does not offer",
  `${await newcomer.getByLabel("Email").count()} ${await newcomer.getByRole("button", { name: "Continue with GitHub" }).count()}`,
  "0 0",
);
await newcomer.getByLabel("Handle").fill("Alan Turing");
expectEqual(
  "passkey sign-up: a handle that is not one is not taken",
  String(
    await newcomer.getByRole("button", { name: "Create your account with a passkey" }).isDisabled(),
  ),
  "true",
);
await newcomer.getByLabel("Handle").fill("turing");
await shot(newcomer, "signup-passkey");
expectEqual(
  "account: signing up says nothing of an org (signup-passkey)",
  String(
    await newcomer
      .getByRole("main")
      .getByText(/\borg\b/i)
      .count(),
  ),
  "0",
);
await newcomer.getByRole("button", { name: "Create your account with a passkey" }).click();
await newcomer.waitForURL(`${built}/`);
await newcomer.goto(`${built}/settings`, { waitUntil: "domcontentloaded" });
await newcomer.getByRole("heading", { name: "Your account", exact: true }).waitFor();
await newcomer.getByRole("list", { name: "Your passkeys" }).getByRole("listitem").first().waitFor();
const usedBeforeSignIn = rowSaid(await passkeyRows(newcomer).first().innerText()).replace(
  /^.*?(?=added)/,
  "",
);
expectEqual(
  "passkey sign-up: signed up and in, by a handle and a passkey, and no address is shown",
  `${squash(await newcomer.locator("header").first().innerText())} | ${squash(await newcomer.locator("main header").innerText())} | ${await newcomer.getByRole("list", { name: "Your passkeys" }).getByRole("listitem").count()} | ${String((await newcomer.content()).includes("keel.invalid"))}`,
  "Keel turing | Your account turing | 1 | false",
);
await newcomer.goto(`${built}/turing`, { waitUntil: "domcontentloaded" });
await newcomer.getByRole("heading", { level: 1 }).first().waitFor();
// The heading is up before Keel has listed the account's projects: the line under it is waited for, and read either way.
await newcomer
  .getByText("You have no project yet.")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "passkey sign-up: their own account is there under the handle, with no project yet, and is not called an org",
  squash(await newcomer.getByRole("main").innerText()),
  "Your projects turing You have no project yet. New project",
);
await newcomer.goto(`${built}/settings`, { waitUntil: "domcontentloaded" });
await newcomer.getByRole("button", { name: "Sign out", exact: true }).click();
await newcomer.waitForURL(`${built}/`);
await newcomer.goto(`${built}/login?next=%2Fsettings`, { waitUntil: "domcontentloaded" });
await newcomer.getByRole("button", { name: "Sign in with a passkey" }).click();
await newcomer.getByRole("heading", { name: "Your account", exact: true }).waitFor();
expectEqual(
  "passkey sign-up: signed back in with the same passkey",
  squash(await newcomer.locator("header").first().innerText()),
  "Keel turing",
);
// The passkey has now signed its person in, and Keel says when: the row says the day.
await passkeyRows(newcomer)
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
await passkeyRows(newcomer)
  .first()
  .getByText(/last used/)
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "passkeys: one that has signed its person in says the day it last did, and before it had, nothing",
  `${rowSaid(await passkeyRows(newcomer).first().innerText()).replace(/^.*?(?=added)/, "")} | before: ${usedBeforeSignIn}`,
  "added {day} · last used {day} Rename Remove | before: added {day} Rename Remove",
);
// Its name is changed where it is listed: the name as typed, without the spaces round it, by one call of Keel's.
const renamings = (): number =>
  sentAtTheDoor.filter((request) => request.path === "/v1/auth/passkey/update-passkey").length;
await passkeyRows(newcomer).first().getByRole("button", { name: "Rename" }).click();
await newcomer.getByLabel(/^New name for/).fill("  Desk key  ");
await newcomer.getByRole("button", { name: "Save" }).click();
await passkeyRows(newcomer)
  .filter({ hasText: "Desk key" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
await shot(newcomer, "settings-passkey-renamed");
expectEqual(
  "passkeys: a passkey is given the name typed, and keeps its days",
  `${rowSaid(await passkeyRows(newcomer).first().innerText())} | ${renamings()} asked | ${await newcomer.getByLabel(/^New name for/).count()} still being named`,
  "Desk key added {day} · last used {day} Rename Remove | 1 asked | 0 still being named",
);
// A second device takes the first one's place at the browser: a device keeps one passkey for an account.
// Signed in by a passkey a moment ago, the session is fresh, and Keel takes the second device's passkey from it.
await authenticator.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: firstDevice });
await authenticator.send("WebAuthn.addVirtualAuthenticator", { options: DEVICE });
const keptBy = (shown: Page) =>
  shown.getByRole("list", { name: "Your passkeys" }).getByRole("listitem");
await keptBy(newcomer).first().waitFor();
await newcomer.getByLabel("Name for a new passkey").fill("A second device");
await newcomer.getByRole("button", { name: "Add a passkey" }).click();
await keptBy(newcomer)
  .filter({ hasText: "A second device" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "fresh sign-in: a session signed in by a passkey in the last ten minutes adds another",
  await passkeysSaid(newcomer),
  "no refusal | 0 offered | 2 kept",
);
// Ten minutes on, the same session may not change how the account signs in: here, removing the passkey of the
// device that is gone. Keel says so, and the page offers the one thing that answers it: signing in again with a
// passkey.
await passkeysAlone.age();
await keptBy(newcomer)
  .filter({ hasNotText: "A second device" })
  .getByRole("button", { name: "Remove" })
  .click();
await passkeysOn(newcomer)
  .getByRole("alert")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
await shot(newcomer, "settings-sign-in-again");
expectEqual(
  "fresh sign-in: ten minutes on, removing a passkey is refused in Keel's words, the passkey is kept, and a passkey sign-in is offered",
  await passkeysSaid(newcomer),
  `${FRESH_SIGN_IN} | 1 offered | 2 kept`,
);
// One tap. The browser's passkey signs them in afresh, and what Keel refused is asked again as it was.
// Tapped only where it is offered: where it is not, the check under this says so by name.
if ((await newcomer.getByRole("button", { name: SIGN_IN_AGAIN }).count()) > 0)
  await newcomer.getByRole("button", { name: SIGN_IN_AGAIN }).click();
for (let tries = 0; tries < 100 && (await keptBy(newcomer).count()) !== 1; tries += 1)
  // oxlint-disable-next-line no-await-in-loop -- waiting on the page
  await new Promise((resolve) => setTimeout(resolve, 100));
expectEqual(
  "fresh sign-in: signed in again with the passkey, what Keel refused is done with nothing more asked, as the same user",
  `${await passkeysSaid(newcomer)} | ${await keptBy(newcomer).filter({ hasText: "A second device" }).count()} of the second device | ${squash(await newcomer.locator("header").first().innerText())}`,
  "no refusal | 0 offered | 1 kept | 1 of the second device | Keel turing",
);
expectEqual(
  "passkey sign-up: the page sent Keel no Authorization",
  String(sentAtTheDoor.filter((request) => request.authorization !== undefined).length),
  "0",
);

// An agent asks a person to stand behind it, and hands them a link with a code in its fragment. Whoever holds
// the code can stand behind the agent, so the page keeps it in memory alone: out of the address at once, in no
// storage, and sent only in the body of the one call that approves. Opening the link approves nothing; one tap
// is a passkey touch and then that call. Keel here knows two agents, and reads who asks from its identity.
const BETA = {
  id: "agt_0000000000000000000000BETA",
  name: "beta",
  kind: "hosted",
  namespace: "acme",
} as const;
// Gamma has a handle, which is its own namespace, and so has epsilon, behind which nobody stands.
const GAMMA = {
  id: "agt_000000000000000000000GAMMA",
  name: "gamma",
  kind: "interactive",
  handle: "gamma-otter",
} as const;
const EPSILON = {
  id: "agt_0000000000000000000EPSN0N",
  name: "epsilon",
  handle: "epsilon-heron",
} as const;
const sponsoring = createFakeKeel({
  namespace: NAMESPACE,
  agents: [BETA, GAMMA, EPSILON],
  readerOf: async (request) => passkeysAlone.reads(request),
  whose: (handle) =>
    [GAMMA, EPSILON]
      .filter((agent) => agent.handle === handle)
      .map((agent) => ({ id: agent.id, kind: "agent" as const }))[0],
});
// The route put on last is the one that answers: from here this context's Keel is the one with the agents.
const sentForAnAgent: Sent[] = [];
await asDeployed(door, { keel: sponsoring, identity: passkeysAlone, sent: sentForAnAgent });
/** Everything the page asked of anyone from here on, as the browser sent it. */
const askedOfAnyone: { line: string; where: string; body: string }[] = [];
newcomer.on("request", (request) =>
  askedOfAnyone.push({
    line: `${request.method()} ${new URL(request.url()).pathname}`,
    where: `${request.url()} ${JSON.stringify(request.headers())}`,
    body: request.postData() ?? "",
  }),
);
const linkTo = (agent: { id: string }, code: string): string =>
  `${built}/sponsor#agent=${agent.id}&code=${code}`;
const standBehind = (shown: Page, agent: { name: string }) =>
  shown.getByRole("button", { name: `Stand behind ${agent.name}` });
/** Waits for the sponsor's page to have said something, whatever it is. */
const sponsorPage = async (shown: Page, agent: { name: string }): Promise<void> => {
  await shown.getByRole("heading", { level: 1 }).waitFor();
  await standBehind(shown, agent)
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
};
const forBeta = sponsoring.askSponsor(BETA.id);
await newcomer.goto(linkTo(BETA, forBeta.code), { waitUntil: "domcontentloaded" });
await sponsorPage(newcomer, BETA);
await shot(newcomer, "sponsor");
expectEqual(
  "sponsor: the page names the agent as Keel shows it to anyone, and who would stand behind it",
  `${squash(await newcomer.getByRole("heading", { level: 1 }).innerText())} | ${squash(await newcomer.locator("main dl").innerText())} | ${await standBehind(newcomer, BETA).count()} button | ${await newcomer.getByText("You approve with a passkey, as turing.").count()}`,
  "Stand behind beta? | Agent beta Declared as hosted Works in acme | 1 button | 1",
);
expectEqual(
  "sponsor: the code is out of the address at once, and in no storage and no cookie the page can read",
  await newcomer.evaluate(
    (code) =>
      `${location.pathname}${location.search}${location.hash} | ${String(
        JSON.stringify([
          Object.entries(localStorage),
          Object.entries(sessionStorage),
          document.cookie,
          history.state,
        ]).includes(code),
      )}`,
    forBeta.code,
  ),
  "/sponsor | false",
);
expectEqual(
  "sponsor: opening the link asks Keel who the agent is and nothing more, and approves nothing",
  `${askedOfAnyone
    .filter((asked) => asked.line.includes("/v1/agents"))
    .map((asked) => asked.line)
    .join(
      ", ",
    )} | ${sponsoring.sponsorOf(BETA.id) ?? "nobody"} | ${askedOfAnyone.filter((asked) => `${asked.where} ${asked.body}`.includes(forBeta.code)).length} with the code`,
  `GET /v1/agents/${BETA.id} | nobody | 0 with the code`,
);
await newcomer.setViewportSize({ width: 390, height: 844 });
expectEqual(
  "sponsor: at a phone's width the button is whole on the screen",
  await standBehind(newcomer, BETA).evaluate(
    (button) =>
      `${String(button.getBoundingClientRect().left >= 0)} ${String(button.getBoundingClientRect().right <= window.innerWidth)}`,
  ),
  "true true",
);
await shot(newcomer, "sponsor-phone");
await newcomer.setViewportSize({ width: 1280, height: 900 });
// One tap: the device's passkey signs them in afresh, and the approval goes as them.
await standBehind(newcomer, BETA).click();
await newcomer
  .getByRole("heading", { level: 1, name: "You stand behind beta" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
const turing = await passkeysAlone.whose("turing");
expectEqual(
  "sponsor: one tap, a passkey touch and then the approval, stands the person behind the agent",
  `${squash(await newcomer.getByRole("heading", { level: 1 }).innerText())} | ${sponsoring.sponsorOf(BETA.id) === turing?.id ? "turing" : String(sponsoring.sponsorOf(BETA.id))} | ${await standBehind(newcomer, BETA).count()} button`,
  "You stand behind beta | turing | 0 button",
);
const withTheCode = askedOfAnyone.filter((asked) =>
  `${asked.where} ${asked.body}`.includes(forBeta.code),
);
expectEqual(
  "sponsor: the code rode in the body of the one call that approves, and in no address and no header",
  `${withTheCode.map((asked) => asked.line).join(", ")} | ${withTheCode.filter((asked) => asked.where.includes(forBeta.code)).length} in an address or a header`,
  `PUT /v1/agents/${BETA.id}/sponsor | 0 in an address or a header`,
);
// A code that is no longer good: the agent asked again, and a new request replaces the last. Keel says so and
// what to do next, the button goes, and the page adds no line of its own.
const stale = sponsoring.askSponsor(GAMMA.id);
const forGamma = sponsoring.askSponsor(GAMMA.id);
await newcomer.goto(linkTo(GAMMA, stale.code), { waitUntil: "domcontentloaded" });
await sponsorPage(newcomer, GAMMA);
if ((await standBehind(newcomer, GAMMA).count()) > 0) await standBehind(newcomer, GAMMA).click();
await newcomer
  .getByRole("alert")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sponsor: a code that is no longer good is refused in what Keel said, with Keel's way forward and none of the page's own, and no second try",
  `${(await newcomer.getByRole("alert").count()) === 0 ? "no refusal" : squash(await newcomer.getByRole("alert").innerText())} | ${await standBehind(newcomer, GAMMA).count()} button | ${await newcomer.getByText("Ask the agent for a new link.").count()} | ${sponsoring.sponsorOf(GAMMA.id) ?? "nobody"}`,
  "No agent is asking for a sponsor with that code: it is mistyped, already used or has run out. Ask the agent for a new link, and approve with that one. Ask the agent for a new link, and approve with it | 0 button | 0 | nobody",
);
// A link that is not whole asks Keel nothing. It is opened over the page that is up, as a second link would be:
// only the fragment changes and nothing is loaded, and it is taken out of the address all the same.
const before = askedOfAnyone.length;
await newcomer.goto(`${built}/sponsor#code=${forGamma.code}`, { waitUntil: "domcontentloaded" });
await newcomer.getByRole("heading", { level: 1 }).waitFor();
await newcomer.waitForTimeout(300);
expectEqual(
  "sponsor: a link that is not whole says so, is taken out of the address all the same, and asks Keel for no agent",
  `${squash(await newcomer.getByRole("heading", { level: 1 }).innerText())} | ${await newcomer.evaluate(() => `${location.pathname}${location.hash}`)} | ${askedOfAnyone.slice(before).filter((asked) => asked.line.includes("/v1/agents")).length} asked`,
  "This link is not whole | /sponsor | 0 asked",
);
// A visitor is not sent to sign in: the link's code would not survive the trip. The same button is theirs, and
// its touch signs them in before the approval goes, as them.
await newcomer.goto(`${built}/settings`, { waitUntil: "domcontentloaded" });
await newcomer.getByRole("button", { name: "Sign out", exact: true }).click();
await newcomer.waitForURL(`${built}/`);
await newcomer.goto(linkTo(GAMMA, forGamma.code), { waitUntil: "domcontentloaded" });
await sponsorPage(newcomer, GAMMA);
expectEqual(
  "sponsor: a visitor stays on the page, is told the touch signs them in, and is offered the same button",
  `${new URL(newcomer.url()).pathname} | ${squash(await newcomer.locator("header").first().innerText())} | ${await standBehind(newcomer, GAMMA).count()} button | ${await newcomer.getByText("the same touch signs you in").count()}`,
  "/sponsor | Keel | 1 button | 1",
);
if ((await standBehind(newcomer, GAMMA).count()) > 0) await standBehind(newcomer, GAMMA).click();
await newcomer
  .getByRole("heading", { level: 1, name: "You stand behind gamma" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sponsor: a visitor's one tap signs them in and stands them behind the agent, and the frame says who they are",
  `${squash(await newcomer.getByRole("heading", { level: 1 }).innerText())} | ${sponsoring.sponsorOf(GAMMA.id) === turing?.id ? "turing" : String(sponsoring.sponsorOf(GAMMA.id))} | ${squash(await newcomer.locator("header").first().innerText())}`,
  "You stand behind gamma | turing | Keel turing",
);

// The sponsor's own second approval. Keel gave the agent one code and the approval spent it, and Keel gives an
// agent somebody stands behind no other: opened again, the link is a code that is no good and is told as that.
// Nobody is told the agent has a sponsor, or to end a link.
await newcomer.goto(linkTo(GAMMA, forGamma.code), { waitUntil: "domcontentloaded" });
await sponsorPage(newcomer, GAMMA);
if ((await standBehind(newcomer, GAMMA).count()) > 0) await standBehind(newcomer, GAMMA).click();
await newcomer
  .getByRole("alert")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sponsor: the sponsor's own second approval is told as a code that is no good, with nothing of a link to end",
  `${(await newcomer.getByRole("alert").count()) === 0 ? "no refusal" : squash(await newcomer.getByRole("alert").innerText())} | ${await newcomer.getByText(/already has a sponsor|End the link/).count()} | ${sponsoring.sponsorOf(GAMMA.id) === turing?.id ? "turing" : String(sponsoring.sponsorOf(GAMMA.id))}`,
  "No agent is asking for a sponsor with that code: it is mistyped, already used or has run out. Ask the agent for a new link, and approve with that one. Ask the agent for a new link, and approve with it | 0 | turing",
);
// An agent's own page, at its handle. Its sponsor is shown one line that sends them to their settings, known
// from their own list of the agents they stand behind. Of an agent they do not stand behind it says nothing.
const aboutAgent = async (shown: Page, handle: string): Promise<string> => {
  await shown.goto(`${built}/${handle}`, { waitUntil: "domcontentloaded" });
  await shown.getByRole("heading", { level: 1 }).first().waitFor();
  await shown
    .getByRole("region", { name: "Agent" })
    .getByText("Name")
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  await shown.waitForTimeout(400);
  const about = shown.getByRole("region", { name: "Agent" });
  if ((await about.count()) === 0) return "no card";
  const settings = about.getByRole("link", { name: /in your settings/ });
  return `${squash(await about.innerText())} | ${(await settings.count()) === 0 ? "no link" : await settings.evaluate((to) => (to instanceof HTMLAnchorElement ? new URL(to.href).pathname : "not a link"))}`;
};
expectEqual(
  "agent's own page: its sponsor is told they stand behind it and sent to their settings, where the controls are",
  await aboutAgent(newcomer, GAMMA.handle),
  "Agent Name gamma Declared as interactive You stand behind this agent. Pause it, unpause it or end the link in your settings | /settings",
);
expectEqual(
  "agent's own page: someone who does not stand behind the agent is shown its card and no such line, and no control",
  `${await aboutAgent(newcomer, EPSILON.handle)} | ${await newcomer.getByRole("button", { name: /Pause|Unpause|End/ }).count()} controls`,
  "Agent Name epsilon | no link | 0 controls",
);

// ── The agents a person stands behind, on their settings ──
// Turing stands behind beta and gamma, and signed in by a passkey a moment ago. The page after a yes links to
// the settings, which list what Keel lists: each agent as it declared itself, and as it stands.
const sponsoredOn = (shown: Page) => shown.getByRole("region", { name: "Agents you stand behind" });
const sponsoredRows = async (shown: Page): Promise<string> =>
  (
    await sponsoredOn(shown)
      .getByRole("listitem")
      .evaluateAll((rows) =>
        rows.map((row) =>
          row.firstElementChild instanceof HTMLElement
            ? row.firstElementChild.innerText.replaceAll(/\s+/g, " ").trim()
            : "",
        ),
      )
  ).join(" | ");
const control = (shown: Page, name: string) =>
  sponsoredOn(shown).getByRole("button", { name, exact: true });
/** Waits for a control to be offered, and goes on without it: what the page then says is read either way. */
const offered = (shown: Page, name: string): Promise<void> =>
  control(shown, name)
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
const toSettings = newcomer.getByRole("link", { name: "See the agents you stand behind" });
if ((await toSettings.count()) > 0) await toSettings.click();
else await newcomer.goto(`${built}/settings`, { waitUntil: "domcontentloaded" });
await offered(newcomer, "Pause gamma");
await shot(newcomer, "settings-sponsored");
expectEqual(
  "sponsored: the page after a yes links to the settings, which list the agents Keel says the person stands behind, each as it declared itself and as it stands",
  `${new URL(newcomer.url()).pathname} | ${await sponsoredRows(newcomer)}`,
  "/settings | beta declared as hosted · Active | gamma declared as interactive · Active",
);
// A pause on a fresh sign-in is one click. It carries the reason typed, and the row then says Keel's answer.
await sponsoredOn(newcomer)
  .getByLabel("Why pause beta (optional, kept in Keel's record)")
  .fill("It pushed to the wrong branch");
if ((await control(newcomer, "Pause beta").count()) > 0)
  await control(newcomer, "Pause beta").click();
await offered(newcomer, "Unpause beta");
expectEqual(
  "sponsored: a pause is one click on a fresh sign-in, carries the reason typed, and the row then says what Keel answered and offers what a paused agent allows",
  `${await sponsoredRows(newcomer)} | ${sponsoring.standingOf(BETA.id)} | ${sponsoring.pausedFor(BETA.id) ?? "no reason"} | ${(await sponsoredOn(newcomer).getByRole("listitem").first().getByRole("button").allInnerTexts()).join(" ")}`,
  "beta declared as hosted · Paused | gamma declared as interactive · Active | suspended | It pushed to the wrong branch | Unpause End",
);
// With no reason typed the pause says whose it is: Keel keeps a reason with every pause.
if ((await control(newcomer, "Pause gamma").count()) > 0)
  await control(newcomer, "Pause gamma").click();
await offered(newcomer, "Unpause gamma");
expectEqual(
  "sponsored: a pause with no reason typed says it is its sponsor's",
  `${sponsoring.standingOf(GAMMA.id)} | ${sponsoring.pausedFor(GAMMA.id) ?? "no reason"}`,
  "suspended | Paused by its sponsor",
);
// Ten minutes on, Keel takes no move from this sign-in: it says so and how to go on, and the page offers the
// passkey touch that answers it.
await passkeysAlone.age();
if ((await control(newcomer, "Unpause beta").count()) > 0)
  await control(newcomer, "Unpause beta").click();
await sponsoredOn(newcomer)
  .getByRole("alert")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
const touchAgain = sponsoredOn(newcomer).getByRole("button", { name: SIGN_IN_AGAIN });
expectEqual(
  "sponsored: a move from a sign-in that is not fresh is refused in Keel's sentence with its way forward, a passkey touch is offered, and nothing has changed",
  `${(await sponsoredOn(newcomer).getByRole("alert").count()) === 0 ? "no refusal" : squash(await sponsoredOn(newcomer).getByRole("alert").innerText())} | ${await touchAgain.count()} offered | ${sponsoring.standingOf(BETA.id)}`,
  "This needs a fresh sign-in: a passkey sign-in from the last ten minutes. Sign in again with your passkey, then retry | 1 offered | suspended",
);
// One touch signs in afresh and asks again what Keel refused.
if ((await touchAgain.count()) > 0) await touchAgain.click();
await offered(newcomer, "Pause beta");
expectEqual(
  "sponsored: one touch signs in afresh and asks again what Keel refused",
  `${await sponsoredRows(newcomer)} | ${sponsoring.standingOf(BETA.id)} | ${await sponsoredOn(newcomer).getByRole("alert").count()} refusal`,
  "beta declared as hosted · Active | gamma declared as interactive · Paused | active | 0 refusal",
);
// At a phone's width every control is whole on the screen.
await newcomer.setViewportSize({ width: 390, height: 800 });
expectEqual(
  "sponsored: at a phone's width every control is whole on the screen",
  (
    await sponsoredOn(newcomer)
      .locator("button, input")
      .evaluateAll((controls) =>
        controls.map(
          (one) =>
            one.getBoundingClientRect().left >= 0 &&
            one.getBoundingClientRect().right <= window.innerWidth,
        ),
      )
  ).join(" "),
  "true true true true true",
);
await shot(newcomer, "settings-sponsored-phone");
await newcomer.setViewportSize({ width: 1280, height: 900 });
// Ending is one click. The agent is then nobody's, its row is gone, and Keel has reinstated it.
if ((await control(newcomer, "End gamma").count()) > 0)
  await control(newcomer, "End gamma").click();
await control(newcomer, "End gamma")
  .waitFor({ state: "detached", timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sponsored: ending is one click, the row is gone, and Keel says nobody stands behind the agent and that it is active again",
  `${await sponsoredRows(newcomer)} | ${sponsoring.sponsorOf(GAMMA.id) ?? "nobody"} | ${sponsoring.standingOf(GAMMA.id)}`,
  "beta declared as hosted · Active | nobody | active",
);
expectEqual(
  "sponsor: the page sent Keel no Authorization",
  String(sentForAnAgent.filter((request) => request.authorization !== undefined).length),
  "0",
);
await door.close();

// Where Keel serves no identity yet, the pages say so, and take nobody for a visitor to be signed up.
const early = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await asDeployed(early, {
  keel: open,
  identity: { handle: () => Promise.resolve(new Response("Not found", { status: 404 })) },
});
const earlyPage = watch(await early.newPage(), "account, before Keel has identity");
await earlyPage.goto(`${built}/signup`, { waitUntil: "domcontentloaded" });
await earlyPage.getByRole("heading", { name: "Signing in is not open on this Keel yet" }).waitFor();
expectEqual(
  "account: with no identity on Keel, there is no form to fill",
  String(await earlyPage.locator("form, button").count()),
  "0",
);
await early.close();

// ── The terms and the privacy notice ──
// Anyone's to read, signed in or not. The text is the repository's own, built into the page: reading it asks
// Keel nothing, and loads nothing from anywhere else.
const readers = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await asDeployed(readers, { keel: open });
const reading = watch(await readers.newPage(), "legal, a visitor");
const fetched: string[] = [];
reading.on("request", (request) => fetched.push(request.url()));
const footOf = async (shown: Page): Promise<string> =>
  (
    await shown
      .locator("footer a")
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href")))
  ).join(" ");
for (const [which, title] of [
  ["terms", "Terms of Service"],
  ["privacy", "Privacy Notice"],
] as const) {
  const lines = readFileSync(
    join(import.meta.dirname, "../../../docs/legal", `${which}.md`),
    "utf8",
  ).split("\n");
  const sections = lines.filter((line) => line.startsWith("## ")).length;
  // A table's lines, but for the rule under its head.
  const rows = lines.filter((line) => line.startsWith("|") && !/^[|:\- ]+$/.test(line)).length;
  fetched.length = 0;
  await reading.goto(`${built}/${which}`, { waitUntil: "domcontentloaded" });
  await reading
    .locator("article h1")
    .waitFor({ timeout: 10_000 })
    .catch(() => {});
  // Long enough for anything the page meant to ask for to have been asked for.
  await reading.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  expectEqual(
    `legal: /${which} is the whole document: its title, the day it was last changed, every section and every row of the file`,
    `${squash((await reading.locator("article h1").allInnerTexts()).join(" "))} | ${squash((await reading.locator("article h1 + p").allInnerTexts()).join(" "))} | ${await reading.locator("article h2").count()} sections | ${await reading.locator("article tr").count()} rows`,
    `${title} | ${lines.find((line) => line.startsWith("Last updated: ")) ?? ""} | ${sections} sections | ${rows} rows`,
  );
  expectEqual(
    `legal: reading /${which} asks Keel nothing, and loads nothing from anywhere else`,
    fetched
      .filter(
        (url) => !url.startsWith(`${built}/`) || /^\/(?:v1|api)\//.test(new URL(url).pathname),
      )
      .join(" "),
    "",
  );
  expectEqual(
    `legal: /${which} has the foot every page has`,
    await footOf(reading),
    "/terms /privacy",
  );
}
await reading.goto(`${built}/signup`, { waitUntil: "domcontentloaded" });
await reading.getByRole("heading", { name: "Create your account" }).waitFor();
expectEqual(
  "legal: the sign-up page says what creating an account agrees to, and links both documents",
  `${squash((await reading.locator("[data-agreement]").allInnerTexts()).join(" "))} | ${(await reading.locator("[data-agreement] a").evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href")))).join(" ")}`,
  "By creating an account you agree to the Terms of Service and the Privacy Notice. | /terms /privacy",
);
expectEqual("legal: an account's page has the foot", await footOf(reading), "/terms /privacy");
await reading.goto(`${built}/login`, { waitUntil: "domcontentloaded" });
await reading.getByRole("heading", { name: "Sign in to Keel" }).waitFor();
expectEqual(
  "legal: signing in creates nothing, and its page says nothing of agreeing",
  String(await reading.locator("[data-agreement]").count()),
  "0",
);
// A project's page goes on listening to Keel, so the network there is never idle.
await reading.goto(`${built}/ada/demo`, { waitUntil: "domcontentloaded" });
await reading
  .locator("footer a")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => {});
expectEqual("legal: a project's page has the foot", await footOf(reading), "/terms /privacy");
await reading
  .locator("footer a", { hasText: "Privacy Notice" })
  .click({ timeout: 5000 })
  .catch(() => {});
await reading.waitForURL("**/privacy", { timeout: 5000 }).catch(() => {});
expectEqual(
  "legal: and from there the foot leads to the document",
  `${whereOf(reading)} ${squash((await reading.locator("article h1").allInnerTexts()).join(" "))}`,
  "/privacy Privacy Notice",
);
await readers.close();

// Deleting an account, on a Keel with passkeys alone: whoever signs up there is signed in by their passkey just
// now, which is the one sign-in Keel deletes an account on. Keel refuses while the account owns a project or is
// an org's only owner, and names each. This identity is told a person's projects by the map here.
const ownedHere = new Map<string, string[]>();
const closingIdentity = createIdentity(built, {
  emailCodes: false,
  projectsOf: (id) => ownedHere.get(id) ?? [],
});
const leaving = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await asDeployed(leaving, { keel: open, identity: closingIdentity });
const leaver = watch(await leaving.newPage(), "account, deleting it");
const leaverDevice = await leaving.newCDPSession(leaver);
await leaverDevice.send("WebAuthn.enable");
await leaverDevice.send("WebAuthn.addVirtualAuthenticator", { options: DEVICE });
await leaver.goto(`${built}/signup`, { waitUntil: "domcontentloaded" });
await leaver.getByLabel("Handle").fill("hopper");
await leaver.getByRole("button", { name: "Create your account with a passkey" }).click();
await leaver.waitForURL(`${built}/`);
await leaver.goto(`${built}/settings`, { waitUntil: "domcontentloaded" });
await leaver.getByRole("heading", { name: "Your account", exact: true }).waitFor();
const closing = leaver.getByRole("region", { name: "Delete your account" });
const deleteIt = closing.getByRole("button", { name: "Delete your account" });
const typedHandle = closing.getByLabel("Type hopper to delete your account");
const waitsFor = async (typed: string): Promise<string> => {
  await typedHandle.fill(typed, { timeout: 5000 }).catch(() => {});
  return String(await deleteIt.isDisabled({ timeout: 5000 }).catch(() => "no button"));
};
expectEqual(
  "closing: deleting an account waits for its handle to be typed, whole",
  `${await waitsFor("hoppe")} ${await waitsFor("hopper")}`,
  "true false",
);
const hopper = (await closingIdentity.whose("hopper"))?.id ?? "";
const closingSaid = async (): Promise<string> =>
  squash(
    await closing
      .getByRole("alert")
      .innerText({ timeout: 5000 })
      .catch(() => "no refusal"),
  );
const linkedIn = (list: string): Promise<string> =>
  closing
    .getByRole("list", { name: list })
    .getByRole("link")
    .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href")).join(" "));
/** Asks for the deletion, and waits for what both answers reach: Keel's refusal, or the front page. */
const askToDelete = async (): Promise<void> => {
  await deleteIt.click({ timeout: 5000 }).catch(() => {});
  await Promise.race([
    closing.getByRole("alert").waitFor({ timeout: 10_000 }),
    leaver.waitForURL(`${built}/`, { timeout: 10_000 }),
  ]).catch(() => {});
};
// A name with nowhere to break: a hyphen would let it wrap by itself.
const LONG_NAME = "aprojectwhosenameislongenoughtorunoffaphonesscreenifnothingbreaksitintolines";
ownedHere.set(hopper, ["engine", LONG_NAME]);
await askToDelete();
await shot(leaver, "closing-owned");
expectEqual(
  "closing: an account that owns projects is told so in Keel's words, with each project linked to its page",
  `${await closingSaid()} | ${await linkedIn("Projects your account owns")} | ${whereOf(leaver)}`,
  `Your account owns projects (engine, ${LONG_NAME}), and an account that owns one is not deleted here: email privacy@keel.town and we'll delete it | /hopper/engine /hopper/${LONG_NAME} | /settings`,
);
await leaver.setViewportSize({ width: 390, height: 800 });
expectEqual(
  "closing: at a phone's width the refusal and the projects it names stay on the screen",
  String(
    await closing
      .evaluate((section) =>
        [section, ...section.querySelectorAll("*")].every(
          (part) => part.getBoundingClientRect().right <= window.innerWidth,
        ),
      )
      .catch(() => "no section"),
  ),
  "true",
);
await leaver.setViewportSize({ width: 1280, height: 900 });
ownedHere.delete(hopper);
const compilers = await leaver.evaluate(async () => {
  const answer = await fetch("/v1/auth/organization/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Compilers", slug: "compilers" }),
  });
  const made: unknown = await answer.json();
  return typeof made === "object" && made !== null && "id" in made ? String(made.id) : "";
});
await askToDelete();
await closing
  .getByRole("list", { name: "Orgs you are the only owner of" })
  .waitFor({ timeout: 5000 })
  .catch(() => {});
await shot(leaver, "closing-only-owner");
expectEqual(
  "closing: an org's only owner is told so in Keel's words, with Keel's way forward for each org linked to its members and said once",
  `${await closingSaid()} | ${squash(
    await closing
      .getByRole("list", { name: "Orgs you are the only owner of" })
      .innerText({ timeout: 5000 })
      .catch(() => "no list"),
  )} | ${await linkedIn("Orgs you are the only owner of")} | ${await closing.getByRole("list", { name: "Ways forward Keel gave" }).count()}`,
  "An org always has an owner: make another member an owner of compilers before you delete your account | compilers Make another member an owner first | /orgs/compilers/members | 0",
);
await leaver.evaluate(async (organizationId) => {
  await fetch("/v1/auth/organization/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId }),
  });
}, compilers);
// More than ten minutes after the passkey sign-in, Keel asks for another. The touch signs in, and that is all.
await closingIdentity.age();
await askToDelete();
const signInToDelete = closing.getByRole("button", { name: SIGN_IN_AGAIN });
await signInToDelete.waitFor({ timeout: 5000 }).catch(() => {});
const staleSaid = await closingSaid();
await signInToDelete.click({ timeout: 5000 }).catch(() => {});
await Promise.race([
  closing.getByText("You are signed in again with your passkey.").waitFor({ timeout: 10_000 }),
  leaver.waitForURL(`${built}/`, { timeout: 10_000 }),
]).catch(() => {});
expectEqual(
  "closing: a sign-in that is not fresh is told so in Keel's words, and the passkey touch signs in and deletes nothing",
  `${staleSaid} | ${(await closingIdentity.whose("hopper")) === undefined ? "deleted" : "still there"} | ${whereOf(leaver)} | ${await closing.getByRole("alert").count()}`,
  "Sign in again with your passkey, then retry: deleting your account needs a passkey sign-in from the last ten minutes | still there | /settings | 0",
);
await askToDelete();
await leaver
  .getByRole("link", { name: "Sign in" })
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => {});
expectEqual(
  "closing: the button deletes the account, and leaves a visitor at the front",
  `${whereOf(leaver)} | ${(await closingIdentity.whose("hopper")) === undefined ? "deleted" : "still there"} | ${(await leaver.getByRole("link", { name: "Sign in" }).count()) > 0 ? "a visitor" : "signed in"}`,
  "/ | deleted | a visitor",
);
// The handle of a deleted account is kept for good: a newcomer who asks for it is refused as for any held handle.
await leaver.goto(`${built}/signup`, { waitUntil: "domcontentloaded" });
await leaver
  .getByLabel("Handle")
  .fill("hopper", { timeout: 5000 })
  .catch(() => {});
await leaver
  .getByRole("button", { name: "Create your account with a passkey" })
  .click({ timeout: 5000 })
  .catch(() => {});
await Promise.race([
  leaver.getByRole("alert").first().waitFor({ timeout: 10_000 }),
  leaver.waitForURL(`${built}/`, { timeout: 10_000 }),
]).catch(() => {});
expectEqual(
  "closing: the handle of a deleted account is not issued again, and the newcomer is told so in Keel's words",
  `${whereOf(leaver)} | ${squash(
    await leaver
      .getByRole("alert")
      .first()
      .innerText({ timeout: 2000 })
      .catch(() => "no refusal"),
  )} | ${(await closingIdentity.whose("hopper")) === undefined ? "nobody's" : "issued again"}`,
  `/signup | "hopper" is taken: a handle is one person's, one agent's or one org's | nobody's`,
);
await leaving.close();

// A change's page on a Keel that answers of a verdict as Keel itself does today: no view of a verdict is served,
// and its event has an outcome, its evidence and no sentence. The page says the verdict by Keel's outcome and
// lists the evidence the event recorded; and at an agent's id it asks Keel nothing of handles.
const asKeelServes = createFakeKeel({
  namespace: NAMESPACE,
  visibility: "public",
  readerOf,
  whose: whoseHandle,
  verdictViews: false,
});
const plainly = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const sentPlainly: Sent[] = [];
// Keel's log takes a second to read on a real Keel, and a page is up before it is: this one's can be held too.
let logIsSlow = false;
await asDeployed(plainly, {
  keel: asKeelServes,
  sent: sentPlainly,
  hold: async (path) => {
    if (logIsSlow && path === "/v1/events")
      await new Promise((resolve) => setTimeout(resolve, 1500));
  },
});
const reader = watch(await plainly.newPage(), "a change's page, as Keel serves a verdict");
// The change the address names, the agent that declared it and the verdict Keel last issued for it, from the
// stand-in's own log. Nobody has ruled on its question here, so that verdict parked it.
const declaredFirst = asKeelServes
  .events()
  .find((event) => event.type === "IntentDeclared" && event.label === "#1");
const firstChange = declaredFirst?.type === "IntentDeclared" ? declaredFirst.payload : undefined;
const itsVerdict = asKeelServes
  .events()
  .findLast(
    (event) => event.type === "VerdictIssued" && event.payload.subject === firstChange?.changeId,
  );
await reader.goto(`${built}/ada/demo/changes/1`, { waitUntil: "domcontentloaded" });
const verdictOn = reader.locator('main section[aria-label="Verdict"]');
await verdictOn
  .locator("p")
  .first()
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
await reader.waitForTimeout(500);
expectEqual(
  "as Keel serves: a verdict with no sentence of its own is said by Keel's outcome",
  squash(
    await verdictOn
      .locator("p")
      .first()
      .innerText({ timeout: 2000 })
      .catch(() => "nothing"),
  ),
  "Keel's verdict was to park it.",
);
await reader.goto(`${built}/ada/demo/changes/1/verification`, { waitUntil: "domcontentloaded" });
const recordedOn = reader.getByRole("list", { name: "Evidence Keel recorded with the verdict" });
await reader
  .getByText("Evidence behind the verdict")
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
await recordedOn.waitFor({ timeout: 4000 }).catch(() => undefined);
expectEqual(
  "as Keel serves: where no view of a verdict is served, the evidence its event recorded is listed as Keel wrote it",
  (await recordedOn.getByRole("listitem").allInnerTexts()).map(squash).join(" | ") ||
    "nothing listed",
  itsVerdict?.type === "VerdictIssued" ? itsVerdict.payload.evidence.join(" | ") : "no verdict",
);
// The agent's page is up before the log has named the agent: until then the page has an id and nothing else.
const declarer = firstChange?.agentId ?? "";
sentPlainly.length = 0;
logIsSlow = true;
await reader.goto(`${built}/ada/demo/agents/${declarer}`, { waitUntil: "domcontentloaded" });
await reader
  .getByRole("main")
  .getByRole("heading")
  .first()
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
await reader.waitForTimeout(1500);
expectEqual(
  "as Keel serves: at an agent's id the page asks Keel for its card, and nothing of whose a handle is",
  [
    ...new Set(
      sentPlainly
        .map((request) => request.path.replace(declarer, "{id}"))
        .filter((path) => path.startsWith("/v1/agents") || path.startsWith("/v1/namespaces/{id}")),
    ),
  ]
    .toSorted()
    .join(" ") || "nothing asked of agents",
  "/v1/agents/{id}",
);
logIsSlow = false;
await plainly.close();

// An agent invited into an org, on the org's members page. Two people who signed up by passkey on a Keel that
// knows two agents by their handles: Noether makes an org and owns it, and Franklin joins it as a plain member.
const inviting = createIdentity(built, { emailCodes: false });
const OTTER = {
  id: "agt_00000000000000000000T1DY0T",
  name: "Tidy Otter",
  handle: "tidy-otter",
} as const;
// A name with nowhere to break: what a phone's width has to wrap.
const UNBROKEN = {
  id: "agt_000000000000000000UNBR0KEN",
  name: "Anagentwhosenamehasnowheretobreakinitsrowonthescreenofaphone",
  handle: "unbroken-heron",
} as const;
const hosting = createFakeKeel({
  namespace: NAMESPACE,
  agents: [OTTER, UNBROKEN],
  readerOf: async (request) => inviting.reads(request),
  whose: async (handle) =>
    (await inviting.whose(handle)) ??
    [OTTER, UNBROKEN]
      .filter((agent) => agent.handle === handle)
      .map((agent) => ({ id: agent.id, kind: "agent" as const }))[0],
  roleIn: (userId, org) => inviting.roleIn(userId, org),
});
const arrive = async (handle: string): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await asDeployed(context, { keel: hosting, identity: inviting });
  const arrived = watch(await context.newPage(), `an org's agents, ${handle}`);
  const device = await context.newCDPSession(arrived);
  await device.send("WebAuthn.enable");
  await device.send("WebAuthn.addVirtualAuthenticator", { options: DEVICE });
  await arrived.goto(`${built}/signup`, { waitUntil: "domcontentloaded" });
  await arrived.getByLabel("Handle").fill(handle);
  await arrived.getByRole("button", { name: "Create your account with a passkey" }).click();
  await arrived.waitForURL(`${built}/`);
  return arrived;
};
const noether = await arrive("noether");
const franklin = await arrive("franklin");
await noether.goto(`${built}/new/org`, { waitUntil: "domcontentloaded" });
await noether.getByLabel("Name").fill("Symmetry");
await noether.getByLabel("Handle").fill("symmetry");
await noether.getByRole("button", { name: "Make the org" }).click();
await noether.getByRole("heading", { level: 1, name: /^Symmetry/ }).waitFor();
await noether.goto(`${built}/orgs/symmetry/members`, { waitUntil: "domcontentloaded" });
await noether.getByLabel("Invite by handle").fill("franklin");
await noether.getByLabel("Role for the invitation").selectOption("member");
await noether.getByRole("button", { name: "Invite", exact: true }).click();
const joining = noether.locator("[data-invitation-link]");
await joining.waitFor();
await franklin.goto(new URL(await joining.innerText()).href, { waitUntil: "domcontentloaded" });
await franklin.getByRole("button", { name: "Join" }).click();
await franklin.getByRole("heading", { level: 1, name: /^Symmetry/ }).waitFor();

const orgAgentsOn = (shown: Page): Locator => shown.locator('main section[aria-label="Agents"]');
const orgAgentList = (shown: Page): Locator =>
  orgAgentsOn(shown).getByRole("list", { name: "Agents of this org" });
const orgAgentRows = async (shown: Page): Promise<string[]> =>
  (await orgAgentList(shown).getByRole("listitem").allInnerTexts()).map(squash);
/** The page has come to say something of an agent, or to a refusal: whichever Keel's answer made it. */
const answeredOn = async (shown: Page, row: string): Promise<void> => {
  await Promise.race([
    orgAgentList(shown).getByText(row).first().waitFor({ timeout: 10_000 }),
    orgAgentsOn(shown).getByRole("alert").first().waitFor({ timeout: 10_000 }),
  ]).catch(() => undefined);
};
const refusalOn = async (shown: Page): Promise<string> =>
  (await orgAgentsOn(shown).getByRole("alert").count()) === 0
    ? "no refusal"
    : squash(await orgAgentsOn(shown).getByRole("alert").first().innerText());
const inviteAgent = async (shown: Page, handle: string, grant?: string): Promise<void> => {
  await orgAgentsOn(shown).getByLabel("The agent's handle").fill(handle);
  if (grant !== undefined)
    await orgAgentsOn(shown)
      .getByLabel("What the agent may do here")
      .selectOption({ label: grant });
  await orgAgentsOn(shown).getByRole("button", { name: "Invite agent" }).click();
};
const lastInvitation = (): string =>
  hosting.calls.findLast((call) => call.method === "POST" && call.path.endsWith("/agents"))?.body ??
  "nothing asked";

// Any member invites: Franklin is a plain one. What the row then says is what Keel answered.
await franklin.goto(`${built}/orgs/symmetry/members`, { waitUntil: "domcontentloaded" });
await orgAgentsOn(franklin).getByText("No agent has been invited into this org.").waitFor();
await inviteAgent(franklin, "tidy-otter", "Read only");
await answeredOn(franklin, "Tidy Otter");
expectEqual(
  "org agents: a plain member invites an agent by its handle to read alone, and the row says what Keel answered",
  `${(await orgAgentRows(franklin)).join(" | ")} | ${lastInvitation()}`,
  'Tidy Otter reads · invited, not yet accepted · invited by you Withdraw | {"agent":"tidy-otter","scopes":["agent:read"]}',
);
// A handle no agent has, typed with a space either side of it: Keel is asked for the handle, and says so.
await inviteAgent(franklin, " nobody-here ");
await orgAgentsOn(franklin)
  .getByRole("alert")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "org agents: a handle no agent has is refused in Keel's own sentence, and nobody is invited",
  `${await refusalOn(franklin)} | ${(await orgAgentRows(franklin)).length} listed`,
  "No agent has the handle nobody-here. | 1 listed",
);

// The owner reads who invited it, and invites a second one to read and work.
await noether.goto(`${built}/orgs/symmetry/members`, { waitUntil: "domcontentloaded" });
await answeredOn(noether, "Tidy Otter");
await inviteAgent(noether, "unbroken-heron");
await answeredOn(noether, UNBROKEN.name);
const invitedBy = (rows: readonly string[]): string =>
  rows.map((row) => /invited by \S+/.exec(row)?.[0] ?? "by nobody").join(" | ");
expectEqual(
  "org agents: each row names the member who invited the agent: by handle, and as you where it is the reader",
  `${invitedBy(await orgAgentRows(noether))} | ${lastInvitation()}`,
  'invited by franklin | invited by you | {"agent":"unbroken-heron","scopes":["agent:read","agent:work"]}',
);
const removals = (shown: Page): Promise<string[]> =>
  orgAgentList(shown)
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
await franklin.goto(`${built}/orgs/symmetry/members`, { waitUntil: "domcontentloaded" });
await answeredOn(franklin, UNBROKEN.name);
expectEqual(
  "org agents: a plain member is offered the removal of the agent they invited and of no other, an owner of each",
  `${(await removals(franklin)).join(", ")} | ${(await removals(noether)).length}`,
  "Withdraw Tidy Otter | 2",
);
// At a phone's width a name with nowhere to break wraps. A box that cannot grow keeps to the screen while its
// words run out of it, so what is measured is where each piece of text is drawn, beside each box.
await noether.setViewportSize({ width: 390, height: 844 });
expectEqual(
  "org agents: at a phone's width no word of the section, and no part of it, runs past the screen",
  String(
    await noether.evaluate(() => {
      const section = document.querySelector('main section[aria-label="Agents"]');
      if (section === null) return "no section";
      const edges = [section, ...section.querySelectorAll("*")].map(
        (part) => part.getBoundingClientRect().right,
      );
      const words = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
      for (let word = words.nextNode(); word !== null; word = words.nextNode()) {
        const drawn = document.createRange();
        drawn.selectNodeContents(word);
        edges.push(drawn.getBoundingClientRect().right);
      }
      return Math.max(...edges) <= window.innerWidth;
    }),
  ),
  "true",
);
await shot(noether, "org-agents-phone");
await noether.setViewportSize({ width: 1280, height: 900 });

// The agent accepts, which is its own call to Keel. The row says it has joined, and its removal is called that.
hosting.accepts("symmetry", OTTER.id);
const today = new Date().toISOString().slice(0, 10);
await noether.goto(`${built}/orgs/symmetry/members`, { waitUntil: "domcontentloaded" });
await answeredOn(noether, "Tidy Otter");
await shot(noether, "org-agents");
expectEqual(
  "org agents: an agent that accepted is said to have joined, its name goes to its own page, and its removal is called that",
  `${String((await orgAgentRows(noether))[0]?.includes(`joined ${today}`))} | ${String(await orgAgentList(noether).getByRole("link", { name: "Tidy Otter" }).getAttribute("href"))} | ${(await removals(noether)).join(", ")}`,
  `true | /tidy-otter | Remove Tidy Otter, Withdraw ${UNBROKEN.name}`,
);

// The org's home lists the agents that have joined, to its members and to anyone: who each is, and nothing of
// who invited it or of an invitation nobody has answered.
const joinedOn = async (shown: Page): Promise<string> => {
  await shown
    .getByRole("main")
    .getByRole("heading", { level: 1 })
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  await orgAgentsOn(shown)
    .getByRole("listitem")
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  return (await orgAgentsOn(shown).count()) === 0
    ? "no section"
    : `${(await orgAgentsOn(shown).getByRole("listitem").allInnerTexts()).map(squash).join(" | ")} | ${String(
        await orgAgentsOn(shown)
          .getByRole("link")
          .first()
          .getAttribute("href", { timeout: 2000 })
          .catch(() => "no link"),
      )}`;
};
const onlooking = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await asDeployed(onlooking, { keel: hosting, identity: inviting });
const onlooker = watch(await onlooking.newPage(), "an org's agents, a visitor");
await onlooker.goto(`${built}/symmetry`, { waitUntil: "domcontentloaded" });
expectEqual(
  "org agents: a visitor is listed the agents that have joined the org, each by who it is and linked to its page",
  await joinedOn(onlooker),
  `Tidy Otter joined ${today} | /tidy-otter`,
);
// An agent's own page names the orgs it has joined, as its card does to anyone: each by its handle, linked to
// the org, and nothing of an invitation nobody has answered or of who invited it.
const joinedPageOf = async (shown: Page, handle: string): Promise<string> => {
  await shown.goto(`${built}/${handle}`, { waitUntil: "domcontentloaded" });
  const about = shown.locator('main section[aria-label="Agent"]');
  await about
    .getByText("Name")
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  const said = squash(await about.innerText({ timeout: 2000 }).catch(() => "no card"));
  const links = await about
    .getByRole("link")
    .evaluateAll((found) => found.map((anchor) => anchor.getAttribute("href") ?? ""));
  return `${said} | ${links.join(" ") || "no link"}`;
};
expectEqual(
  "org agents: an agent's own page names the org it has joined, linked to the org, to a visitor",
  await joinedPageOf(onlooker, "tidy-otter"),
  "Agent Name Tidy Otter Joined symmetry | /symmetry",
);
expectEqual(
  "org agents: an agent whose invitation nobody has answered is said to have joined nothing",
  await joinedPageOf(onlooker, "unbroken-heron"),
  `Agent Name ${UNBROKEN.name} | no link`,
);
await onlooking.close();
await noether.goto(`${built}/symmetry`, { waitUntil: "domcontentloaded" });
expectEqual(
  "org agents: a member's home of the org lists the ones that have joined, and no invitation nobody has answered",
  await joinedOn(noether),
  `Tidy Otter joined ${today} | /tidy-otter`,
);

// Ten minutes on, Keel takes no removal from this sign-in: it says so and how to go on, and the page offers the
// passkey touch that answers it.
await inviting.age();
await noether.goto(`${built}/orgs/symmetry/members`, { waitUntil: "domcontentloaded" });
await answeredOn(noether, "Tidy Otter");
const takeOut = orgAgentList(noether).getByRole("button", {
  name: /^(Remove|Withdraw) Tidy Otter$/,
});
if ((await takeOut.count()) > 0) await takeOut.click();
await orgAgentsOn(noether)
  .getByRole("alert")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
const touchForAgents = orgAgentsOn(noether).getByRole("button", { name: SIGN_IN_AGAIN });
expectEqual(
  "org agents: a removal from a sign-in that is not fresh is refused in Keel's sentence with its way forward, a passkey touch is offered, and the agent is still there",
  `${await refusalOn(noether)} | ${await touchForAgents.count()} offered | ${(await orgAgentRows(noether)).length} listed`,
  "This needs a fresh sign-in: a passkey sign-in from the last ten minutes. Sign in again with your passkey, then retry | 1 offered | 2 listed",
);
// One touch signs in afresh and asks again what Keel refused.
if ((await touchForAgents.count()) > 0) await touchForAgents.click();
await orgAgentList(noether)
  .getByText("Tidy Otter")
  .first()
  .waitFor({ state: "detached", timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "org agents: one touch signs in afresh and asks again what Keel refused, and the agent is out of the org",
  `${invitedBy(await orgAgentRows(noether))} | ${(await orgAgentRows(noether)).length} listed | ${await refusalOn(noether)}`,
  "invited by you | 1 listed | no refusal",
);
await noether.context().close();
await franklin.context().close();

await browser.close();
await new Promise<void>((resolve) => {
  served.httpServer.close(() => resolve());
});
if (errors.length > 0) console.log(`console errors:\n  ${errors.join("\n  ")}`);
const failed = failures.length > 0 || errors.length > 0;
if (!failed) console.log("\nAll checks passed.");
// Long-polls the stand-in is still holding would keep this process alive for their full wait.
process.exit(failed ? 1 : 0);
