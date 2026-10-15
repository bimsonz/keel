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
  CONSENT_URL,
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
/** A row's ⋯ menu, opened by its name, and one of its items chosen. */
const fromMenu = async (shown: Page, menu: string, item: string): Promise<void> => {
  await shown.getByRole("button", { name: menu }).click();
  await shown.getByRole("menuitem", { name: item, exact: true }).click();
};
const statOn = async (page: Page, label: string): Promise<string> =>
  squash(
    await page
      .locator("dl dt", { hasText: label })
      .locator("xpath=following-sibling::dd[1]")
      .innerText(),
  );
const pathOf = (page: Page): string => new URL(page.url()).pathname;
/** A number in Insights' table of trunk's numbers, by its name. */
const trunkStatOn = async (page: Page, label: string): Promise<string> =>
  squash(
    await page
      .locator("table.a-stats tr", { has: page.locator("th", { hasText: label }) })
      .locator("td")
      .first()
      .innerText(),
  );
/** Waits for Mission Control's canvas to be drawn, or for five seconds: the check after it says which. */
const canvasDrawn = async (shown: Page): Promise<void> => {
  await shown
    .locator(".a-mc .react-flow")
    .first()
    .waitFor({ timeout: 5_000 })
    .catch(() => undefined);
};
/** Mission Control's frame, and the canvas drawn in it, counted. */
const canvasOn = async (shown: Page): Promise<string> =>
  `${await shown.locator(".a-mc").count()} | ${await shown.locator(".a-mc .react-flow").count()}`;
/** A capture of a page as it stands, kept only when a folder is named for them (`SHOTS=<folder>`). */
const shot = async (shown: Page, name: string): Promise<void> => {
  const folder = process.env["SHOTS"];
  if (folder !== undefined && folder !== "")
    await shown.screenshot({ path: `${folder}/${name}.png` });
};
/** The frame's tabs: the places a project has. */
const tabsOf = (page: Page) => page.getByRole("navigation", { name: "Project" }).getByRole("link");
/**
 * The header's links before the project's tabs, in order, as `name → path`: a link that holds Keel's mark is
 * marked so, and the header's text up to its first link that is not a name is given after them.
 */
const headerOf = async (page: Page) =>
  page
    .locator("header")
    .first()
    .evaluate((header) => {
      const links = [...header.querySelectorAll("a")]
        .filter((a) => a.closest("nav") === null)
        .map(
          (a) =>
            `${a.getAttribute("aria-label") ?? a.textContent?.trim() ?? ""}${a.querySelector("svg") === null ? "" : " (mark)"} → ${new URL(a.href).pathname}`,
        );
      const group = header.querySelector("div")?.firstElementChild;
      const text = (group instanceof HTMLElement ? group.innerText : "")
        .replaceAll(/\s+/g, " ")
        .trim();
      return `${links.join(" | ")} || ${text}`;
    });
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
  "/acme/demo /acme/demo/changes /acme/demo/conflicts /acme/demo/escalations /acme/demo/mission-control /acme/demo/insights",
);
expectEqual(
  "frame: what is open, counted on the tabs",
  (await tabs.allInnerTexts()).map(squash).join(" | "),
  "Code | Changes 2 open | Conflicts 1 open | Escalations 1 waiting for a person | Mission Control | Insights",
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

// Mission Control draws its canvas. Moving there does not load the page again: the fixture is still held where it was.
await tabs.filter({ hasText: "Mission Control" }).click();
await page.getByText("Holding: a person is being asked").waitFor();
await canvasDrawn(page);
expectEqual("mission control: its canvas, drawn", await canvasOn(page), "1 | 1");
// Left alone, it stays held: the default is hold.
await page.waitForTimeout(2_500);
expectEqual(
  "still held after waiting",
  String(await page.getByText("Holding: a person is being asked").count()),
  "1",
);

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
await tabs.filter({ hasText: "Insights" }).click();
await page.waitForFunction(
  () =>
    [...document.querySelectorAll("table.a-stats th")].find((th) => th.textContent === "Advances")
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
      [...document.querySelectorAll("table.a-stats th")]
        .find((th) => th.textContent === "People asked / changes landed")
        ?.nextElementSibling?.textContent?.replaceAll(/\s+/g, "") === "1/2",
    undefined,
    { timeout: 10_000 },
  )
  .catch(() => undefined);
expectEqual(
  "people asked / landed, after the ruling",
  await trunkStatOn(page, "People asked / changes landed"),
  "1/2",
);
expectEqual("trunk red", await trunkStatOn(page, "Trunk red"), "0");
expectEqual(
  "frame: nothing is left open",
  (await tabs.allInnerTexts()).map(squash).join(" | "),
  "Code | Changes | Conflicts | Escalations | Mission Control | Insights",
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
  "Overview | Verification 3 | Files changed 2",
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
// The verdict's event carries the lines of its evidence. The plan it was issued under, and the step each line
// names, are read from Keel's view of the verdict.
await page
  .getByRole("navigation", { name: "Change" })
  .getByRole("link", { name: /Verification/ })
  .click();
const planSteps = page.getByRole("list", { name: "The plan's steps, in Keel's order" });
await planSteps.waitFor({ timeout: 10_000 }).catch(() => undefined);
/** Each step of a plan on the page, by its id, with how many of the verdict's lines are under it. */
const stepsOf = async (steps: Locator): Promise<string> =>
  (
    await steps
      .locator(":scope > li")
      .evaluateAll((items) =>
        items.map(
          (item) =>
            `${(item.getAttribute("data-step") ?? "").replace(/grd_\w+/, "<guard>")} ${item.querySelectorAll("ul > li").length}`,
        ),
      )
      .catch(() => [])
  ).join(" | ") || "no steps";
expectEqual(
  "change: the plan the verdict was issued under, each step with the lines that name it, from the verdict's view",
  await stepsOf(planSteps),
  "js-ts.suite 0 | worker-app.typecheck 0 | guard:<guard> 2",
);
expectEqual(
  "change: a guard's step names its predicate, its policy and the decision it holds",
  squash(
    await planSteps
      .locator('li[data-step^="guard:"]')
      .getByText(/^Guards /)
      .innerText({ timeout: 2000 })
      .catch(() => "none"),
  ),
  "Guards freshness, policy block, holding decision D-1: Cache allowed if revocation invalidates it",
);

// A proof, and what it does to a change. Where the changes' plans block on the conflict's predicate, both
// bounce on the conflict itself: Keel issues no verdict for that, and the page shows none.
const WAYS_FORWARD =
  "Read the conflict and the proof against the change | Revise the change's intent around the conflict | Resolve the conflict with a move";
const standing = page.getByRole("region", { name: "Status" });
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
// A change lands as a commit of Keel's on trunk, which is another than the one its workspace pushed: the page
// names the one Keel's landing names, and it leads to that commit's own page.
const landedAs = page.locator('[data-part="landed-as"]');
const landedLink = String(
  await landedAs
    .getByRole("link")
    .getAttribute("href", { timeout: 3000 })
    .catch(() => "no link"),
);
const landedSha = new URL(landedLink, dev).pathname.split("/").at(-1) ?? "";
const landedSaid = squash(await landedAs.innerText({ timeout: 3000 }).catch(() => "no line"));
expectEqual(
  "change: a landed change names the commit it landed as on trunk, and that leads to the commit's own page",
  `${landedSaid.replace(/[0-9a-f]{7}$/, "<sha>")} | ${new URL(landedLink, dev).pathname.replace(/[0-9a-f]{7,40}$/, "<sha>")} | ${String(landedSha.length === 40 && landedSaid.endsWith(landedSha.slice(0, 7)))}`,
  "landed on trunk as commit <sha> | /acme/demo/commit/<sha> | true",
);
// Keel previews a candidate on the project's own account and tells the change where: by the change's own address.
const previewed = page.locator('[data-part="preview"]');
expectEqual(
  "change: where Keel previewed a change, its page says where, at the change's own address, as a link",
  `${squash(await previewed.innerText({ timeout: 3000 }).catch(() => "no preview"))} | ${await previewed
    .getByRole("link")
    .getAttribute("href", { timeout: 3000 })
    .catch(() => "no link")}`,
  "previewed at https://change-b-demo.keel-previews.workers.dev | https://change-b-demo.keel-previews.workers.dev",
);
// Keel addresses a lane `lane:<projectId>:<name>`: the page calls it by its name.
expectEqual(
  "change: the lane it was queued in is called by its name, not by Keel's address of it",
  squash(
    await page
      .locator('[data-part="lane"]')
      .innerText({ timeout: 3000 })
      .catch(() => "no lane"),
  ),
  "lane main",
);
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
  "/acme/demo/changes/2/alternatives | #2 this change “Add a rate limit to collaborator routes” hosted-112 HOSTED withdrawn none yet 0 09:30:24, revision 1 | #1 “Rate-limit the collaborators API” hosted-041 HOSTED landed Land, on 2 pieces of evidence 0 09:30:10, revision 1 | #3 “Throttle the collaborators endpoints” hosted-207 HOSTED working none yet 0 09:30:41, revision 1",
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

// A premise put in doubt. Keel tells #1 that #2 edited the code its premise rests on, and that #3's effect may
// contradict it, and opens no conflict for either: the page lists each as a status line, as a merge box does.
const DOUBTED = "scenario=s6&t=130&play=0";
const doubted = page
  .locator("section", { has: page.getByRole("heading", { name: "Premises in doubt" }) })
  .last();
const doubtLines = async (): Promise<string> =>
  (await doubted.count()) === 0
    ? "none in doubt"
    : (await doubted.locator('[data-part="doubt"]').allInnerTexts()).map(squash).join(" | ");
await page.goto(at("/changes/1", DOUBTED), { waitUntil: "networkidle" });
await standing.getByRole("heading", { level: 2 }).waitFor();
expectEqual(
  "change: each premise Keel put in doubt, with the change that did and how, in Keel's order",
  await doubtLines(),
  "billing.invoices/bound at most 50 ms #2 changed src/billing/total.ts (totalOf), which this premise rests on. | billing.invoices/bound at most 50 ms #3’s effect billing.invoices / bound at most 2000 ms may contradict this premise.",
);
await follow(doubted.getByRole("link", { name: "#2" }), 'section[aria-label="Verdict"]');
expectEqual(
  "change: the change that put a premise in doubt is a link to it",
  pathOf(page),
  "/acme/demo/changes/2",
);
// Each arrives when Keel says it, and the changes that put the premise in doubt are told nothing of it.
const doubtsAt = async (change: string, t: number): Promise<string> => {
  await page.goto(at(`/changes/${change}`, `scenario=s6&t=${t}&play=0`), {
    waitUntil: "networkidle",
  });
  await standing.getByRole("heading", { level: 2 }).waitFor();
  return (await doubted.count()) === 0
    ? "0"
    : String(await doubted.locator('[data-part="doubt"]').count());
};
expectEqual(
  "change: a premise is in doubt from the moment Keel says so, and only on its holder's page",
  `#1 at 30s: ${await doubtsAt("1", 30)} | at 50s: ${await doubtsAt("1", 50)} | at 130s: ${await doubtsAt("1", 130)} | #2: ${await doubtsAt("2", 130)} | #3: ${await doubtsAt("3", 130)}`,
  "#1 at 30s: 0 | at 50s: 1 | at 130s: 2 | #2: 0 | #3: 0",
);
// Mission Control's subject panel says the same under the holder's row.
await page.goto(at("/subjects/billing.invoices", DOUBTED), { waitUntil: "networkidle" });
const doubtedSubject = page.getByRole("complementary", { name: "Subject billing.invoices" });
await doubtedSubject.waitFor();
expectEqual(
  "subject: under a change's row, each of its premises there that Keel put in doubt",
  (
    await doubtedSubject
      .locator("section", { has: page.getByRole("heading", { name: "Changes" }) })
      .locator("li")
      .allInnerTexts()
  )
    .map(squash)
    .join(" | "),
  "#1 Show each invoice's total as it is edited working hosted-501 · HOSTED bound at most 50 ms: #2 changed src/billing/total.ts (totalOf), which this premise rests on. bound at most 50 ms: #3’s effect billing.invoices / bound at most 2000 ms may contradict this premise.",
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
// What the page asks of the host a README's images are on: nothing, whatever the README says.
const imagesAsked: string[] = [];
const noteImage = (request: { url(): string }): void => {
  if (new URL(request.url()).hostname === "img.example.invalid") imagesAsked.push(request.url());
};
page.on("request", noteImage);
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
// The README is drawn as a code host draws one: what it names in its own repository is this project's page of
// it, a heading can be led to, and nothing written in it is run or fetched.
const readme = page.getByRole("region", { name: "README.md" });
expectEqual(
  "code: a README's code block, as written",
  (await readme.locator("pre code").allInnerTexts()).map(squash).join(" | "),
  "pnpm install pnpm test",
);
expectEqual(
  "code: a link in a README to a file beside it is this project's page of that file",
  (await readme
    .getByRole("link", { name: "src/http.ts" })
    .getAttribute("href", { timeout: 2000 })
    .catch(() => null)) ?? "no link",
  "/acme/demo/blob/trunk/src/http.ts?scenario=s1&t=700&play=0",
);
expectEqual(
  "code: an image in a README is a link by its words, and nothing is asked of its host",
  [
    `${await readme.locator("img").count()} drawn`,
    (await readme
      .getByRole("link", { name: "build: passing" })
      .getAttribute("href", { timeout: 2000 })
      .catch(() => null)) ?? "no link",
    `${imagesAsked.length} asked for`,
  ].join(" | "),
  "0 drawn | https://img.example.invalid/build.svg | 0 asked for",
);
expectEqual(
  "code: HTML written in a README is shown as text, and none of it is run",
  [
    `${await readme.locator("script").count()} scripts`,
    `${await readme.getByText('<script>window.readmeRan = "a script"</script>').count()} shown as text`,
    `ran: ${await page.evaluate(() => ("readmeRan" in window ? String(window.readmeRan) : "nothing"))}`,
  ].join(" | "),
  "0 scripts | 1 shown as text | ran: nothing",
);
await readme
  .getByRole("link", { name: "run it" })
  .click({ timeout: 5000 })
  .catch(() => {});
expectEqual(
  "code: a link in a README to one of its headings reaches that heading",
  `${new URL(page.url()).hash} | ${await page.evaluate(() => document.querySelector(":target")?.textContent ?? "no heading")}`,
  "#user-content-run | Run",
);
page.off("request", noteImage);
// An address that names a README's heading, opened cold on a screen too short to show it: the browser looks for
// the heading before the README has come, and the page brings it into view once it has.
const tall = page.viewportSize() ?? { width: 1920, height: 1080 };
await page.setViewportSize({ width: 1280, height: 420 });
await page.goto("about:blank");
await page.goto(`${at("", "scenario=s1&t=700&play=0")}#user-content-run`, {
  waitUntil: "networkidle",
});
await page.locator(".a-prose h2").first().waitFor();
expectEqual(
  "code: an address that names a README's heading, opened cold, brings that heading into view",
  await page.evaluate(() => {
    const top = document.getElementById("user-content-run")?.getBoundingClientRect().top;
    if (top === undefined) return "no heading";
    return top >= 0 && top < window.innerHeight ? "in view" : "out of view";
  }),
  "in view",
);
await page.setViewportSize(tall);
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
  "Decision D-1 Cache allowed if revocation invalidates it | Guard G-1 guards this since conflict C-1 was proven | Premise #1 relies on invariant is unchanged | Premise #2 relies on freshness at most per-request",
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
expectEqual("missing: the frame is still there", String(await tabs.count()), "6");
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
await page.getByRole("alert").waitFor();
expectEqual(
  "dev, with no fixture asked for: the home says what answered was not Keel, and lists nothing",
  `${squash(await page.getByRole("region", { name: "Public projects" }).innerText())} | ${await page.getByRole("list", { name: "Projects" }).count()}`,
  "Public projects Keel did not list its projects: What answered at /v1 was not Keel. | 0",
);

// Mission Control on the swarm draws its canvas, and the Changes tab counts the changes open.
await page.goto(at("/mission-control", "scenario=swarm&t=100&play=0"), {
  waitUntil: "networkidle",
});
await canvasDrawn(page);
expectEqual("swarm: Mission Control draws its canvas", await canvasOn(page), "1 | 1");
expectEqual(
  "swarm: the Changes tab counts the changes open",
  squash(await tabs.filter({ hasText: "Changes" }).innerText()),
  "Changes 736 open",
);

// A subject opens at its own address, beside Mission Control's canvas; a conflict in it leads to the conflict's page.
await page.goto(at("/subjects/storage.gc.safety", "scenario=swarm&t=100&play=0"), {
  waitUntil: "networkidle",
});
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
// The canvas is a file of its own and is drawn a moment after the panel beside it: waited for, and read either way.
await canvasDrawn(page);
expectEqual("subject: beside Mission Control's canvas", await canvasOn(page), "1 | 1");
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

// ── Agents: members of a project, not a part of it ──
// Scenario 1 at the question. Agent B declared #1 under a token that named no run, and Agent A declared #2 under
// the run it called collab-revocation. A fixture has no cards, so no agent has a handle, and so no page.
const runsSaid = async (shown: Page): Promise<string> =>
  `${(await shown.getByText(/^in (its run|a run)/).allInnerTexts()).map(squash).join(" || ")} | ${await shown
    .getByRole("link", { name: /^in (its run|a run)/ })
    .count()} links`;
await page.goto(at("/changes?state=parked", "scenario=s1&t=470&ruling=live&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("list", { name: "Changes, newest first" }).waitFor();
expectEqual(
  "changes: the row of a change held under a run says which; one held under none says nothing",
  await runsSaid(page),
  "in its run “collab-revocation” | 0 links",
);
await page.goto(at("/changes/2", "scenario=s1&t=470&ruling=live&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("heading", { level: 1 }).waitFor();
expectEqual(
  "change: its page says which run holds it, and an agent Keel gives no handle is named and leads nowhere",
  `${await runsSaid(page)} | ${await page.getByRole("main").getByRole("link", { name: "Agent A" }).count()} links to the agent`,
  "in its run “collab-revocation” | 0 links | 0 links to the agent",
);
// Agents are members of a project, as people are: it has no tab of theirs, and no address for them under it.
await page.goto(at("/agents", "scenario=s1&t=470&ruling=live&play=0"), {
  waitUntil: "networkidle",
});
await page.getByRole("heading", { level: 1 }).first().waitFor();
expectEqual(
  "agents: a project has no Agents tab, and no address for its agents",
  `${await tabs.filter({ hasText: "Agents" }).count()} tabs | ${squash(await page.getByRole("heading", { level: 1 }).first().innerText())}`,
  "0 tabs | There is nothing at this address",
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
  "1,057 | 3 0.3% 3 left here, 358 still here, 696 went on 3 bounced on a proven conflict · 358 still here, 1 of them parked | 696 | —",
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
// A proof nobody was asked about settles nothing: its conflict stays open, as Keel counts one, until a ruling.
expectEqual(
  "probe, the conflicts it proved still open beside four still deciding",
  await stage("conflicts", 0),
  "15 | 3 20.0% 3 settled here, 11 still here, 1 passed on 3 dismissed as false alarms · 7 proven · 11 still here | 1 | $0.011",
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
expectEqual("narrow: the same frame, with every tab", String(await tabsOf(narrow).count()), "6");
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
  "Code | Changes 2 open | Conflicts 1 open | Escalations 1 waiting for a person | Decisions | Mission Control | Insights";
/**
 * The tabs as someone who is no member of the project's org is shown them: Keel reads a project's questions to
 * its members alone, so none is counted for anyone else.
 */
const PUBLIC_ON_TABS =
  "Code | Changes 2 open | Conflicts 1 open | Escalations | Decisions | Mission Control | Insights";
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

// ── A project's frame, before Keel has found the project ──
// What a project is called and its tabs are its address's: they are drawn while Keel is still finding it, as a code
// host draws a repository's structure before its contents. Keel's answer is held back until they have been read.
const unfound = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// A Keel of its own, so what this reader asks is not counted among what the visitor below is answered.
const unfoundKeel = createFakeKeel({
  namespace: NAMESPACE,
  visibility: "public",
  readerOf,
  whose: whoseHandle,
  roleIn: (userId, org) => identity.roleIn(userId, org),
  ahead: AHEAD,
});
let answerTheFind = (): void => {};
const findHeld = new Promise<void>((resolve) => {
  answerTheFind = resolve;
});
await asDeployed(unfound, {
  keel: unfoundKeel,
  hold: (path) => (path === "/v1/namespaces/ada/projects/demo" ? findHeld : Promise.resolve()),
});
const beforeFound = watch(await unfound.newPage(), "built, before the project is found");
await beforeFound.goto(`${built}/ada/demo`, { waitUntil: "domcontentloaded" });
// A page that draws no header yet is a failed check below, and not a wait that runs out.
const shownHeader = async (): Promise<string> =>
  (await beforeFound.locator("header").count()) === 0 ? "no header" : headerOf(beforeFound);
await tabsOf(beforeFound)
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "built: a project's name and tabs are drawn while Keel has yet to find it, with nothing counted on them",
  `${await shownHeader()} | ${(await tabsOf(beforeFound).allInnerTexts()).map(squash).join(" | ")}; found ${unfoundKeel.calls.some((call) => call.path === "/v1/namespaces/ada/projects/demo") ? "answered" : "not answered"}`,
  "Keel (mark) → / | ada → /ada | demo → /ada/demo | Sign in → /login || ada / demo | Code | Changes | Conflicts | Escalations | Decisions | Mission Control | Insights; found not answered",
);
answerTheFind();
await beforeFound
  .getByRole("navigation", { name: "Project" })
  .getByText(/\d/)
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "built: once Keel has found the project and its log is read, the same frame says what Keel says of it",
  `${await shownHeader()} | ${(await tabsOf(beforeFound).allInnerTexts()).map(squash).join(" | ")}`,
  "Keel (mark) → / | ada → /ada | demo → /ada/demo | Fork → /ada/demo/fork | Sign in → /login || ada / demo public | Code | Changes 2 open | Conflicts 1 open | Escalations | Decisions | Mission Control | Insights",
);
await unfound.close();

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
// The scripts the page asks for: the code viewer and Mission Control's canvas are files of their own, asked for by
// the pages that draw them. The names are the build's, with a hash after each.
const scripts: string[] = [];
visitor.on("request", (request) => {
  const file = /\/assets\/([A-Za-z]+)-[^/]+\.js$/.exec(new URL(request.url()).pathname)?.[1];
  if (file !== undefined) scripts.push(file);
});
const heavy = (): string =>
  ["CodeDiff", "MissionGraph"].filter((name) => scripts.includes(name)).join(" ") || "none";
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
  "visitor: the home says what Keel is first, with its source, its quickstart, its API and the way in",
  await visitor
    .getByRole("region", { name: "What Keel is" })
    .evaluate(
      (section) =>
        `${section.querySelector("h1")?.textContent ?? ""} | ${section.querySelector("p")?.textContent ?? ""} | ${section.querySelectorAll("li").length} points | ${[
          ...section.querySelectorAll("nav a"),
        ]
          .map((a) => `${a.textContent ?? ""} → ${a.getAttribute("href") ?? ""}`)
          .join(
            " | ",
          )} | first: ${document.querySelector("main section")?.getAttribute("aria-label") ?? ""}`,
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => "no such section"),
  "Keel | An agent-first Git platform. Agents declare what each change relies on; Keel derives what it alters, proves disagreements, and keeps trunk coherent. | 3 points | Source on GitHub → https://github.com/bimsonz/keel | Quickstart → /start | API → /v1/openapi.json | Sign up → /signup | first: What Keel is",
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
// The project's tabs are drawn as soon as Keel has found it: what each counts comes once the log is read.
expectEqual(
  "visitor: a project's tabs are up while Keel has yet to answer about the log, with nothing counted on them yet",
  `${(await tabsOf(visitor).allInnerTexts()).map(squash).join(" | ")}; the log ${open.calls.some((call) => call.path === "/v1/events") ? "answered" : "not answered"}`,
  "Code | Changes | Conflicts | Escalations | Decisions | Mission Control | Insights; the log not answered",
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
// A new document, so what it asks for is counted from nothing: the canvas, and not the code viewer.
await visitor
  .locator(".a-mc .react-flow")
  .first()
  .waitFor({ timeout: 8_000 })
  .catch(() => undefined);
await shot(visitor, "visitor-mission-control");
expectEqual(
  "visitor: Mission Control draws its canvas, which is a file of its own, and asks for no code viewer",
  `${heavy()} | ${await canvasOn(visitor)}`,
  "MissionCanvas | 1 | 1",
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
// Trunk's numbers are in Insights: a visitor is told what landed, and no count of people asked.
await visitor.goto(`${built}/ada/demo/insights`, { waitUntil: "domcontentloaded" });
await visitor.locator("table.a-stats").waitFor();
expectEqual(
  "visitor: changes landed, and no count of people asked, which a visitor is not read",
  await trunkStatOn(visitor, "People asked / changes landed"),
  "—/0",
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

// The conflict's line is drawn from the lattices the page read from Keel.
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
// Keel parks a change on the question it puts to a person, and issues no verdict for that: the change's page has
// no verdict's evidence to show, and Keel is asked for none.
await visitor.goto(`${built}/ada/demo/changes/1/checks`, { waitUntil: "domcontentloaded" });
await visitor
  .getByText("Evidence is listed here once Keel issues a verdict.")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "built: a change parked on a question has no verdict, and Keel is asked for none; the lattices are read from Keel",
  `${await visitor.getByText("Evidence is listed here once Keel issues a verdict.").count()} | ${open.calls.some((call) => call.path.startsWith("/v1/verdicts/"))} ${open.calls.some((call) => call.path === "/v1/lattices")}`,
  "1 | false true",
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
const wayBack = async (shown: Page): Promise<string> =>
  (
    await shown
      .getByRole("main")
      .getByRole("link")
      .evaluateAll((links) =>
        links.map((a) => {
          const href = a.getAttribute("href") ?? "";
          // An address the page got wrong is said as it was written.
          return `${a.textContent ?? ""} → ${URL.canParse(href, window.location.href) ? new URL(href, window.location.href).pathname : href}`;
        }),
      )
  ).join(" | ");
expectEqual(
  "built: inside a project, the not-found page's way back is the project's code",
  await wayBack(visitor),
  "Go to the project's code → /ada/demo",
);
// A first segment Keel reserves that names no page here: the not-found page, with no project to go back to.
await visitor.goto(`${built}/admin`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { name: "There is nothing at this address" }).waitFor();
expectEqual(
  "built: above every project, the not-found page's way back is the home page",
  await wayBack(visitor),
  "Go to the home page → /",
);
// A first segment no handle could be is no namespace's page: it is not found, as it is to the Worker.
await visitor.goto(`${built}/sitemap.xml`, { waitUntil: "domcontentloaded" });
await visitor
  .getByRole("heading", { level: 1 })
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "built: /sitemap.xml is no handle's page, and says there is nothing at its address",
  `${squash(
    await visitor
      .getByRole("heading", { level: 1 })
      .first()
      .innerText({ timeout: 3_000 })
      .catch(() => "none"),
  )} | ${await wayBack(visitor)}`,
  "There is nothing at this address | Go to the home page → /",
);

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
const agentsNamed = async (shown: Page): Promise<string> =>
  [
    ...new Set(
      (
        await shown
          .locator("main")
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
/**
 * The tab bar under a page's header, as it is drawn: where it is, its class, its size and colours, and its first
 * tab's. Two pages with the same bar read the same.
 */
const barOf = async (shown: Page): Promise<string> =>
  shown
    .locator("header nav.a-tabs")
    .first()
    .evaluate(
      (nav) => {
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, where nothing outside this callback is
        const look = (part: Element | null, keys: string[]): string =>
          part === null
            ? "none"
            : keys.map((key) => getComputedStyle(part).getPropertyValue(key)).join(" ");
        const header = nav.closest("header");
        const tab = nav.querySelector("a");
        return `in ${header === null ? "nothing" : "HEADER"} | foot ${header === null ? "none" : Math.round(header.getBoundingClientRect().bottom - nav.getBoundingClientRect().bottom)} | ${nav.className} | ${look(nav, ["display", "padding-left", "border-bottom-width", "background-color"])} | ${look(tab, ["font-size", "font-weight", "padding-top", "padding-bottom", "column-gap", "color"])} | ${tab?.querySelector("svg") === null ? "no icon" : "icon"}`;
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => "no bar in the header");
/** A namespace page's tabs, in order, as `name count → address`, the open one marked `*`. */
const namespaceTabsOf = async (shown: Page): Promise<string> =>
  (
    await shown
      .locator("header nav.a-tabs a")
      .evaluateAll((links) =>
        links.map(
          (a) =>
            `${a.getAttribute("aria-current") === null ? "" : "*"}${(a.textContent ?? "").trim()} → ${a.getAttribute("href") ?? ""}`,
        ),
      )
      .catch(() => [])
  ).join(" | ");
/** What a namespace with no project offers whoever may start one there: each way, as `name → address`. */
const startsOf = async (shown: Page): Promise<string> =>
  (
    await shown
      .locator('[data-part="no-projects"] a')
      .evaluateAll((links) =>
        links.map((a) => `${(a.textContent ?? "").trim()} → ${a.getAttribute("href") ?? ""}`),
      )
      .catch(() => [])
  ).join(" | ") || "none";
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
// A namespace's projects are a tab of its page, as a code host's repositories are of an owner's.
await visitor.goto(`${built}/ada?tab=projects`, { waitUntil: "domcontentloaded" });
await visitor
  .getByRole("main")
  .locator('section[aria-label="Projects"] li')
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "namespace: its Projects tab is open at ?tab=projects, and lists what Keel names the reader there",
  `${await namespaceTabsOf(visitor)} || ${squash(
    await visitor
      .locator('main section[aria-label="Projects"]')
      .innerText({ timeout: 3_000 })
      .catch(() => "nothing"),
  )}`,
  "Overview → /ada | *Projects1 → /ada?tab=projects || Projects demo public",
);
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
  "/v1/agents/{id} /v1/events /v1/lattices /v1/namespaces/{handle} /v1/namespaces/{handle}/projects/{name} /v1/probes/{id}/source /v1/projects /v1/projects/{id}/repo/blob /v1/projects/{id}/repo/commits /v1/projects/{id}/repo/tree",
);
// The page put nothing of its own on anything it asked: no token, no key. A visitor's browser holds no session.
expectEqual(
  "visitor: the page sent Keel no credential, and the browser had none to send",
  `${visitorSent.filter((request) => request.authorization !== undefined).length} ${open.calls.filter((call) => call.authorization !== "").length} ${(await street.cookies()).length}`,
  "0 0 0",
);

// ── A visitor, on a project whose agents Keel names to anyone by their cards ──
// The log names an agent by its id, and a visitor is read no enrolment. What they are shown of each agent is
// Keel's card of it: Agent A signed itself up, so it has a handle and a page of its own, and Agent B was
// enrolled, so it has neither.
const staffed = createFakeKeel({
  namespace: NAMESPACE,
  visibility: "public",
  readerOf,
  whose: whoseHandle,
  ahead: AHEAD,
  signedUp: { "Agent A": "tidy-otter" },
});
await asDeployed(street, { keel: staffed });
/** Where each link in a page's main part named `name` leads. */
const leadsOf = (shown: Page, name: string): Promise<string> =>
  shown
    .getByRole("main")
    .getByRole("link", { name, exact: true })
    .evaluateAll((links) =>
      links.map((link) =>
        link instanceof HTMLAnchorElement ? new URL(link.href).pathname : "not a link",
      ),
    )
    .then((paths) => [...new Set(paths)].join(" ") || "nowhere");
await visitor.goto(`${built}/ada/demo/changes/2`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { level: 1 }).first().waitFor();
// The holder's name and handle arrive with Keel's card of it.
await visitor
  .getByRole("main")
  .getByRole("link", { name: "Agent A", exact: true })
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "visitor: a change's holder that signed itself up leads to its own page, at its handle, as an author leads to their profile",
  await leadsOf(visitor, "Agent A"),
  "/tidy-otter",
);
await visitor.goto(`${built}/ada/demo/changes/1`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { level: 1 }).first().waitFor();
await visitor
  .getByRole("main")
  .getByText("Agent B", { exact: true })
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "visitor: a change's holder a member enrolled has no handle, so it is named and leads nowhere",
  `${(await visitor.getByRole("main").getByText("Agent B", { exact: true }).count()) > 0 ? "named" : "not named"} | ${await leadsOf(visitor, "Agent B")}`,
  "named | nowhere",
);
// The agent's own page, at its handle: Keel's card, and nothing of who sponsors it.
await visitor.goto(`${built}/tidy-otter`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { level: 1 }).first().waitFor();
await visitor
  .getByRole("region", { name: "Agent" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "visitor: an agent's own page shows Keel's card of it, and no line about sponsoring it",
  `${squash(await visitor.locator("main header").first().innerText())} | ${(await visitor.getByRole("region", { name: "Agent" }).count()) === 0 ? "no card" : squash(await visitor.getByRole("region", { name: "Agent" }).innerText())} | ${await visitor.getByText(/sponsor/i).count()}`,
  "tidy-otter Agent | Agent Name Agent A | 0",
);

// ── A visitor, on a project its org has kept private ──
// A private project is to a visitor as one that is not there: the same words, and nothing of it on the page.
const lane = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await asDeployed(lane, { keel: shut });
const outsider = watch(await lane.newPage(), "built, a visitor to a private project");
await outsider.goto(`${built}/`, { waitUntil: "domcontentloaded" });
await outsider
  .getByRole("region", { name: "Public projects" })
  .locator("p, li")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => {});
expectEqual(
  "visitor: with no project public, the home says so under what Keel is",
  `${await outsider.getByRole("region", { name: "What Keel is" }).count()} | ${squash(await outsider.getByRole("region", { name: "Public projects" }).innerText())}`,
  "1 | Public projects No project is public yet.",
);
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
  "ada | Projects ada has no public projects. Sign in to see what you may.",
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
  .getByText("You sponsor no agents.")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sponsored: someone who sponsors no agent is told so, and is shown no control",
  `${await person.getByText("You sponsor no agents.").count()} | ${await person.getByRole("region", { name: "Agents you sponsor" }).getByRole("button").count()} controls`,
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
// Approving is a touch of her passkey every time, and only then the approval.
await person.getByRole("button", { name: "Approve with your passkey" }).click();
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
// The tabs' counts are read after the page's heading: the header is read once its organizations are counted.
await person
  .locator("header")
  .first()
  .filter({ hasText: /Organizations\s*\d/ })
  .waitFor({ timeout: 5_000 })
  .catch(() => undefined);
expectEqual(
  "account: a person's own handle is their projects, with nothing of an org on the page",
  `${squash(await person.locator("header").first().innerText())} | ${squash(await person.locator("main header").innerText())} | ${await person.getByRole("navigation", { name: "Org" }).count()} org tabs | ${await person
    .getByRole("main")
    .getByText(/\borg\b/i)
    .count()} mentions of an org`,
  "ada ada Overview Projects 1 Organizations 0 Settings | ada Your account | 0 org tabs | 0 mentions of an org",
);
expectEqual(
  "account: a namespace's header is Keel's mark home and the namespace's name, a link to its own page",
  await headerOf(person),
  "Keel (mark) → / | ada → /ada | ada → /settings || ada",
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

// Ada invites her by handle, in the Invite member dialog. Nobody types another person's address, and none is shown.
await person.goto(`${built}/orgs/lovelace/members`, { waitUntil: "domcontentloaded" });
const memberDialog = person.getByRole("dialog", { name: "Invite member" });
await person.getByRole("button", { name: "Invite member" }).click();
await memberDialog.getByLabel("Handle or email").fill("nobody-here");
await memberDialog.getByRole("button", { name: "Invite", exact: true }).click();
await memberDialog.getByText('No one has the handle "nobody-here"').waitFor();
await memberDialog.getByLabel("Handle or email").fill("@grace");
await memberDialog.getByRole("combobox").selectOption("maintainer");
await shot(person, "invite-member");
await memberDialog.getByRole("button", { name: "Invite", exact: true }).click();
await memberDialog.waitFor({ state: "detached" });
const link = person.locator("[data-invitation-link]");
await link.waitFor();
const invitation = new URL(await link.innerText());
expectEqual(
  "orgs: an invitation has an address of its own, on this console",
  `${invitation.origin === built} ${/^\/invite\/[\w-]+$/.test(invitation.pathname)}`,
  "true true",
);
const pending = person.getByRole("list", { name: "Invitations not yet answered" });
expectEqual(
  "orgs: it is told by the handle it was made to, with its role, and no address is on the page",
  `${await pending.getByText("@grace", { exact: true }).count()} ${squash(await pending.getByRole("listitem").innerText()).endsWith("Maintainer Copy link")} ${String((await person.content()).includes("@example.com"))}`,
  "1 true false",
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
  "orgs: made a member, she is one, and is offered no way to invite a person or to remove one",
  `${squash(await grace.getByRole("heading", { level: 1 }).innerText())} ${await grace.getByRole("button", { name: "Invite member" }).count()} ${await grace.getByRole("button", { name: "Actions for ada" }).count()}`,
  "Lovelace member 0 0",
);
await fromMenu(person, "Actions for grace", "Remove");
await person.waitForFunction(
  () => document.querySelectorAll('ul[aria-label="Members of this org"] > li').length === 1,
);
await grace.goto(`${built}/lovelace`, { waitUntil: "domcontentloaded" });
await grace.getByRole("main").getByRole("heading").first().waitFor();
expectEqual(
  "orgs: removed, the org is to her what it is to anyone: an org of that handle, with no project she may see",
  `${await handlePage(grace)} | ${await namespaceTabsOf(grace)}`,
  "lovelace Org | Projects This organization has no public projects. | *Overview → /lovelace | Projects0 → /lovelace?tab=projects",
);

// Ada invites her again, as an owner, and nobody answers in time. Keel says it has lapsed, and so does the page.
const inviteAsOwner = async (): Promise<URL> => {
  await person.getByRole("button", { name: "Invite member" }).click();
  await memberDialog.getByLabel("Handle or email").fill("grace");
  await memberDialog.getByRole("combobox").selectOption("owner");
  await memberDialog.getByRole("button", { name: "Invite", exact: true }).click();
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
await fromMenu(person, "Actions for the invitation to grace", "Cancel invitation");
await link.waitFor({ state: "detached" });
const asOwner = await inviteAsOwner();
await grace.goto(asOwner.href, { waitUntil: "domcontentloaded" });
await grace.getByRole("button", { name: "Join" }).click();
await grace.getByRole("heading", { level: 1, name: /^Lovelace/ }).waitFor();

// An org always has an owner. With two, each is offered a way out; the other owner takes hers first, and Ada's
// page is behind. Keel refuses the only owner, and the page says so in Keel's words, with the way forward it gave.
await person.goto(`${built}/orgs/lovelace/members`, { waitUntil: "domcontentloaded" });
await person.getByRole("button", { name: "Actions for ada" }).waitFor();
await grace.goto(`${built}/orgs/lovelace/members`, { waitUntil: "domcontentloaded" });
await fromMenu(grace, "Actions for grace", "Leave");
await grace.waitForURL(`${built}/settings`);
await fromMenu(person, "Actions for ada", "Leave");
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
  "member: someone signed in is not told what Keel is: their home leads with what waits for them",
  `${await person.getByRole("region", { name: "What Keel is" }).count()} | ${await person.getByRole("region", { name: "Waiting for you" }).count()}`,
  "0 | 1",
);
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
  "member: the header leads with Keel's mark home, then the namespace and the project, each a link to its own page",
  await headerOf(person),
  "Keel (mark) → / | ada → /ada | demo → /ada/demo | Fork → /ada/demo/fork | ada → /settings || ada / demo private",
);
// A namespace's own page has the bar a project's page has, as a code host's owner and repository pages share one.
const projectBar = await barOf(person);
await shot(person, "bar-project");
// Her namespace's page, in another tab of the same browser, so this one stays on the project.
const beside = await person.context().newPage();
await beside.goto(`${built}/ada`, { waitUntil: "domcontentloaded" });
await beside
  .locator("header nav.a-tabs a")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "member: a namespace's page draws the project page's own tab bar, in the header, the same to the pixel",
  await barOf(beside),
  projectBar,
);
expectEqual(
  "member: and that bar is the header's, with icons",
  `${projectBar.split(" | ")[0] ?? ""} ${projectBar.split(" | ")[1] ?? ""} ${projectBar.split(" | ").at(-1) ?? ""}`,
  "in HEADER foot 1 icon",
);
await shot(beside, "bar-namespace");
await beside.close();
expectEqual(
  "member: the frame names the org, the project and who is reading",
  squash(await person.locator("header").first().innerText()).split(" Code ")[0] ?? "",
  "ada / demo private Fork Live ada",
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
await later.goto(`${built}/ada/demo/insights`, { waitUntil: "domcontentloaded" });
await later.locator("table.a-stats").waitFor({ timeout: 10_000 });
const landedLately = async (): Promise<string> => trunkStatOn(later, "Landed per minute");
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
  "public Anyone reads its code and its log, signed in or not. | ada / demo public Fork Live ada",
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
  "private Only ada reads it. | ada / demo private Fork Live ada | 2",
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
// ── A project's decisions ──
// Keel remembers what each ruling settled, and reads it to whoever reads the project. This Keel holds the
// project nine days after its question was ruled: a careless change has bounced on the guard that holds D-1.
const remembers = createFakeKeel({
  namespace: NAMESPACE,
  visibility: "public",
  story: "s2",
  readerOf,
  whose: whoseHandle,
  roleIn: (userId, org) => identity.roleIn(userId, org),
  ahead: AHEAD,
});
const recalling = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await asDeployed(recalling, { keel: remembers });
const recall = watch(await recalling.newPage(), "decisions, a visitor");
/** A decision's own page, once Keel's read of it is drawn; or whatever stands there after fifteen seconds. */
const decisionDrawn = async (shown: Page): Promise<void> => {
  await shown
    .getByRole("heading", { name: "What the ruling upheld" })
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
};
await recall.goto(`${built}/ada/demo/decisions`, { waitUntil: "domcontentloaded" });
const decisionRows = recall
  .getByRole("list", { name: "Decisions, newest first" })
  .getByRole("listitem");
await decisionRows
  .first()
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "decisions: the tab stands after Escalations, and is the page the reader is on",
  `${(await tabsOf(recall).allInnerTexts()).map((tab) => squash(tab).replace(/ \d.*$/, "")).join(" | ")} | ${String(await tabsOf(recall).filter({ hasText: "Decisions" }).getAttribute("aria-current"))}`,
  "Code | Changes | Conflicts | Escalations | Decisions | Mission Control | Insights | page",
);
expectEqual(
  "decisions: a visitor reads a public project's decisions, each as Keel's row has it",
  (await decisionRows.allInnerTexts())
    .map(squash)
    .join(" || ")
    .replace(/decided .*? authz/, "decided <when> authz"),
  "Cache allowed if revocation invalidates it D-1 decided <when> authz.permission-evaluation ruled C-1 active",
);
await decisionRows
  .first()
  .getByRole("link", { name: "Cache allowed if revocation invalidates it" })
  .click()
  .catch(() => undefined);
await decisionDrawn(recall);
expectEqual(
  "decision: its page is at Keel's label for it, and says what the ruling upheld in Keel's own proposition",
  `${pathOf(recall)} | ${squash(
    await recall
      .getByRole("list", { name: "What the ruling upheld" })
      .innerText()
      .catch(() => "no list"),
  )}`,
  "/ada/demo/decisions/D-1 | authz.permission-evaluation/freshness at most per-request “requirePermission re-reads roles on every request”",
);
const guardPart = recall.locator('[data-part="guard"]');
expectEqual(
  "decision: while it stands, its guard leads to the probe it was admitted from, and a change that fails it is bounced whatever the policy",
  `${String(await guardPart.getAttribute("data-standing").catch(() => "none"))} | ${squash(await guardPart.innerText().catch(() => "no part"))} | ${String(
    await guardPart
      .getByRole("link", { name: "G-1" })
      .getAttribute("href")
      .catch(() => "no link"),
  )}`,
  "blocks | G-1 A change that fails this guard is bounced, whatever this project's policy for the predicate. | /ada/demo/conflicts/C-1/probe",
);
const bouncedCiting = recall.getByRole("list", { name: "Changes bounced citing this decision" });
expectEqual(
  "decision: the change the ruling went against and the change bounced citing it are named, each linked",
  `${squash(
    await recall
      .getByRole("list", { name: "Changes the ruling went against" })
      .innerText()
      .catch(() => "no list"),
  )} | ${squash(await bouncedCiting.innerText().catch(() => "no list"))} | ${String(
    await bouncedCiting
      .getByRole("link")
      .getAttribute("href")
      .catch(() => "no link"),
  )}`,
  "#1 | #1205 | /ada/demo/changes/1205",
);
expectEqual(
  "decision: a visitor is not shown that it answered a question",
  `${await recall.getByRole("heading", { name: "The question it answered" }).count()} headings | ${await recall.getByRole("main").getByRole("link", { name: "E-1" }).count()} links`,
  "0 headings | 0 links",
);
// The change the guard bounced says which decision its bounce cites, and leads to it.
await recall.goto(`${built}/ada/demo/changes/1205`, { waitUntil: "domcontentloaded" });
const citedDecision = recall.locator('[data-part="cited-decision"]');
await citedDecision.waitFor({ timeout: 15_000 }).catch(() => undefined);
// The line is drawn with the bounce, the decision's label with it. What an address calls the decision is read once
// for every link on the page, a moment later: the link's address is given its moment, and what stands then is compared.
await citedDecision
  .locator('a[href$="/decisions/D-1"]')
  .waitFor({ timeout: 5_000 })
  .catch(() => undefined);
expectEqual(
  "change: a bounce that cites a decision says so, and links the decision's page",
  `${squash(await citedDecision.innerText().catch(() => "no line"))} | ${String(
    await citedDecision
      .getByRole("link")
      .getAttribute("href")
      .catch(() => "no link"),
  )}`,
  "This bounce cites decision D-1. | /ada/demo/decisions/D-1",
);
// Keel's ways forward name the guard and the decision by their ids: the page calls each by its label, and links
// the decision to its page.
const waysForward = recall.getByRole("list", { name: "Ways forward Keel gave its agent" });
expectEqual(
  "change: the ways forward are Keel's own, each id in them called by its label and a decision linked",
  `${(await waysForward.getByRole("listitem").allInnerTexts())
    .map((way) => squash(way))
    .join(" || ")} | ${(
    await waysForward
      .getByRole("link")
      .evaluateAll((links) =>
        links.map(
          (anchor) =>
            `${anchor.textContent ?? ""} ${URL.canParse(anchor.getAttribute("href") ?? "", location.href) ? new URL(anchor.getAttribute("href") ?? "", location.href).pathname : "unparsed"}`,
        ),
      )
      .catch(() => ["no links"])
  ).join(", ")}`,
  "Fix the guarded behaviour, push, then submit again: guard:G-1 (freshness): a role revoked mid-session is still allowed; it holds decision D-1: Cache allowed if revocation invalidates it || Read decision D-1, which the failed guard holds: Cache allowed if revocation invalidates it | D-1 /ada/demo/decisions/D-1, D-1 /ada/demo/decisions/D-1",
);
await citedDecision
  .getByRole("link")
  .click()
  .catch(() => undefined);
await decisionDrawn(recall);
expectEqual(
  "change: the cited decision's link opens its page",
  pathOf(recall),
  "/ada/demo/decisions/D-1",
);
// The verdict the change bounced on names its batch. The plan it was issued under is read from Keel's view of it.
await recall.goto(`${built}/ada/demo/changes/1205/checks`, { waitUntil: "domcontentloaded" });
const builtSteps = recall.getByRole("list", { name: "The plan's steps, in Keel's order" });
await builtSteps.waitFor({ timeout: 10_000 }).catch(() => undefined);
expectEqual(
  "built: the plan a verdict was issued under, read from Keel's view of the verdict",
  `${await stepsOf(builtSteps)} | ${remembers.calls.some((call) => call.path.startsWith("/v1/verdicts/"))}`,
  "js-ts.suite 0 | worker-app.typecheck 0 | guard:<guard> 2 | true",
);
const heldDecision = builtSteps.locator('li[data-step^="guard:"]').getByRole("link");
await heldDecision
  .first()
  .waitFor({ timeout: 5_000 })
  .catch(() => undefined);
expectEqual(
  "built: a guard's step links the decision it holds",
  `${squash(
    await heldDecision
      .first()
      .innerText({ timeout: 2000 })
      .catch(() => "none"),
  )} | ${String(
    await heldDecision
      .first()
      .getAttribute("href")
      .catch(() => "no link"),
  )}`,
  "decision D-1 | /ada/demo/decisions/D-1",
);
// A decision is one link away wherever the project names it: the chip on a settled conflict's row, and the
// conflict's own page. Each address calls it by its label a moment after the row is drawn, so that is waited for.
const decisionChip = async (shown: Page): Promise<string> => {
  const chip = shown.getByRole("main").getByRole("link", { name: "D-1", exact: true });
  await chip
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
  await shown
    .getByRole("main")
    .locator('a[href$="/decisions/D-1"]')
    .first()
    .waitFor({ timeout: 5_000 })
    .catch(() => undefined);
  return `${await chip.count()} | ${String(
    await chip
      .first()
      .getAttribute("href")
      .catch(() => "no link"),
  )} | ${String(
    await chip
      .first()
      .getAttribute("title")
      .catch(() => "no title"),
  )} | ${String(
    await chip
      .first()
      .getAttribute("data-tone")
      .catch(() => "no tone"),
  )}`;
};
await recall.goto(`${built}/ada/demo/conflicts?state=settled`, { waitUntil: "domcontentloaded" });
expectEqual(
  "conflicts: a settled conflict's decision chip links the decision's page, in the chip's tone and title",
  await decisionChip(recall),
  "1 | /ada/demo/decisions/D-1 | Decision D-1 | quiet",
);
await recall.goto(`${built}/ada/demo/conflicts/C-1`, { waitUntil: "domcontentloaded" });
const settledBy = recall.getByRole("main").getByRole("link", { name: "D-1", exact: true });
await settledBy.waitFor({ timeout: 15_000 }).catch(() => undefined);
await recall
  .getByRole("main")
  .locator('a[href$="/decisions/D-1"]')
  .first()
  .waitFor({ timeout: 5_000 })
  .catch(() => undefined);
const settledByAt = String(await settledBy.getAttribute("href").catch(() => "no link"));
await settledBy.click().catch(() => undefined);
await decisionDrawn(recall);
expectEqual(
  "conflict: the decision that settled it is named by its label, and opens the decision's page",
  `${settledByAt} | ${pathOf(recall)}`,
  "/ada/demo/decisions/D-1 | /ada/demo/decisions/D-1",
);
// Narrowed to a subject, Keel is asked for that subject's decisions, and the way back to all of them is offered.
await recall.goto(`${built}/ada/demo/decisions?subject=authz.permission-evaluation`, {
  waitUntil: "domcontentloaded",
});
await decisionRows
  .first()
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "decisions: narrowed to a subject, Keel is asked for that subject's, and every decision is one link away",
  `${await decisionRows.count()} listed | ${String(
    await recall
      .getByRole("link", { name: "Every decision" })
      .getAttribute("href")
      .catch(() => "no link"),
  )} | ${String(remembers.calls.some((call) => call.path === "/v1/decisions" && new URLSearchParams(call.query).get("subject") === "authz.permission-evaluation"))}`,
  "1 listed | /ada/demo/decisions | true",
);
await recall.goto(`${built}/ada/demo/decisions?subject=none.such`, {
  waitUntil: "domcontentloaded",
});
await recall
  .getByRole("heading", { name: /^No decision/ })
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "decisions: a subject no decision is on says so by its name",
  squash(
    await recall
      .getByRole("heading", { name: /^No decision/ })
      .innerText()
      .catch(() => "no heading"),
  ),
  "No decision on none.such",
);
// An address that names no decision the log has is told as none, and Keel is not asked for a label.
await recall.goto(`${built}/ada/demo/decisions/D-9`, { waitUntil: "domcontentloaded" });
await recall
  .getByRole("heading", { level: 1 })
  .last()
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "decision: an address that names none says so, and asks Keel for nothing by that name",
  `${squash(await recall.getByRole("heading", { level: 1 }).last().innerText())} | ${remembers.calls.filter((call) => call.path === "/v1/decisions/D-9").length} asked`,
  "There is no decision D-9 in what Keel has said so far | 0 asked",
);
// At a phone's width the page's words stay on the screen: each run of text is measured where it is drawn.
await recall.setViewportSize({ width: 390, height: 844 });
await recall.goto(`${built}/ada/demo/decisions/D-1`, { waitUntil: "domcontentloaded" });
await decisionDrawn(recall);
expectEqual(
  "decision: at a phone's width none of its words runs past the screen",
  String(
    await recall.getByRole("main").evaluate((main) => {
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      const edges: number[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.textContent ?? "").trim() === "") continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        edges.push(range.getBoundingClientRect().right);
      }
      return edges.length > 3 && Math.max(...edges) <= window.innerWidth;
    }),
  ),
  "true",
);
await shot(recall, "decision-phone");
await recalling.close();
// A member is read the project's questions, so the decision's page names the one it answered.
const recollecting = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await recollecting.addCookies(await lobby.cookies());
await asDeployed(recollecting, { keel: remembers });
const recollect = watch(await recollecting.newPage(), "decisions, a member");
await recollect.goto(`${built}/ada/demo/decisions/D-1`, { waitUntil: "domcontentloaded" });
await decisionDrawn(recollect);
await shot(recollect, "decision-member");
const answeredQuestion = recollect
  .locator("section", { has: recollect.getByRole("heading", { name: "The question it answered" }) })
  .getByRole("link");
expectEqual(
  "decision: a member is shown the question it answered, linked to it",
  `${squash(await answeredQuestion.innerText().catch(() => "no link"))} | ${String(await answeredQuestion.getAttribute("href").catch(() => "no link"))}`,
  "E-1 | /ada/demo/escalations/E-1",
);
// A member is read the project's questions, so the closed question's row carries its decision, linked.
await recollect.goto(`${built}/ada/demo/escalations?state=closed`, {
  waitUntil: "domcontentloaded",
});
expectEqual(
  "escalations: a ruled question's decision chip links the decision's page, in the chip's tone and title",
  await decisionChip(recollect),
  "1 | /ada/demo/decisions/D-1 | Decision D-1 | quiet",
);
await recollecting.close();
// ── A bounce, once the change has moved on from it ──
// S-2's run on keel.town ends with the careless change withdrawn after its bounce. The bounce is still Keel's record
// of it: the page keeps it, with the decision it cites, under the state that followed.
const moved = createFakeKeel({
  namespace: NAMESPACE,
  visibility: "public",
  story: "s2",
  withdrawn: true,
  readerOf,
  whose: whoseHandle,
  roleIn: (userId, org) => identity.roleIn(userId, org),
});
const movingOn = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await asDeployed(movingOn, { keel: moved });
const movedOn = watch(await movingOn.newPage(), "a bounce moved on from, a visitor");
const pastBounce = movedOn.locator('[data-part="past-bounce"]');
/** The verdict's headline, the past bounce's first line with its time taken out, and its cited decision's link. */
const pastBounceSaid = async (): Promise<string> => {
  await pastBounce.waitFor({ timeout: 15_000 }).catch(() => undefined);
  const cited = pastBounce.locator('[data-part="cited-decision"]');
  await cited
    .locator('a[href$="/decisions/D-1"]')
    .waitFor({ timeout: 5_000 })
    .catch(() => undefined);
  return `${squash(
    await movedOn
      .getByRole("region", { name: "Status" })
      .getByRole("heading", { level: 2 })
      .innerText()
      .catch(() => "no heading"),
  )} | ${squash(
    await pastBounce
      .locator("p")
      .first()
      .innerText()
      .catch(() => "no bounce"),
  ).replace(
    /at \d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?/,
    "at <time>",
  )} | ${squash(await cited.innerText().catch(() => "no line"))} | ${String(
    await cited
      .getByRole("link")
      .getAttribute("href")
      .catch(() => "no link"),
  )}`;
};
await movedOn.goto(`${built}/ada/demo/changes/1205`, { waitUntil: "domcontentloaded" });
expectEqual(
  "change: a change withdrawn after its bounce keeps the bounce and the decision it cites",
  await pastBounceSaid(),
  "Withdrawn | It bounced at <time> and was withdrawn after. It bounced on the verdict above. | This bounce cites decision D-1. | /ada/demo/decisions/D-1",
);
expectEqual(
  "change: a change withdrawn after its bounce keeps the ways forward Keel gave its agent",
  String(
    await pastBounce
      .getByRole("list", { name: "Ways forward Keel gave its agent" })
      .getByRole("listitem")
      .count()
      .catch(() => 0),
  ),
  "2",
);
await shot(movedOn, "bounce-withdrawn");
// History's change bounced on the ruling and landed after: its page keeps that bounce too.
await movedOn.goto(`${built}/ada/demo/changes/1`, { waitUntil: "domcontentloaded" });
await pastBounce.waitFor({ timeout: 15_000 }).catch(() => undefined);
expectEqual(
  "change: a change that landed after a ruling's bounce keeps the bounce, by its decision",
  squash(
    await pastBounce
      .locator("p")
      .first()
      .innerText()
      .catch(() => "no bounce"),
  ).replace(/at \d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?/, "at <time>"),
  "It bounced at <time> and landed on a later try. A ruling went against this change: decision D-1 chose “Cache allowed if revocation invalidates it”, on conflict C-1. It bounced on the ruling: no verdict was issued.",
);
// The other side of history's conflict was surfaced no precedent, though D-1 covers its subject now: the panel says
// what Keel recorded for the change.
await movedOn.goto(`${built}/ada/demo/changes/2`, { waitUntil: "domcontentloaded" });
await movedOn
  .getByRole("region", { name: "Status" })
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
const precedents = movedOn.locator("section.a-panel", {
  has: movedOn.getByRole("heading", { name: "Precedents", exact: true }),
});
expectEqual(
  "change: the Precedents panel says Keel surfaced no precedent to the change, not that no decision covers its subject",
  `${squash(
    await precedents
      .locator("header")
      .innerText()
      .catch(() => "no panel"),
  )} | ${(await precedents.innerText().catch(() => "")).includes("Keel surfaced no precedent to this change")} | ${await precedents.getByRole("listitem").count()} listed`,
  "Precedents decisions this change met | true | 0 listed",
);
await movingOn.close();

// ── A namespace's credentials, and a project's Cloudflare account ──
// No token is typed anywhere. A project's owner presses Connect to Cloudflare on its settings and is sent to
// Cloudflare's consent; Keel's callback makes a token of its own on the account ticked, stores it as a credential
// of the namespace, sets the target with it, and sends the owner back to the settings with how it went.
const GOOD_ACCOUNT = "0123456789abcdef0123456789abcdef";
const deploying = createFakeKeel({
  namespace: NAMESPACE,
  visibility: "private",
  readerOf,
  whose: whoseHandle,
  roleIn: (userId, org) => identity.roleIn(userId, org),
  consentAccount: GOOD_ACCOUNT,
  cloudflare: ({ accountId }) =>
    accountId === GOOD_ACCOUNT
      ? { reaches: true, subdomain: "ada-previews" }
      : { reaches: false, why: "account-unreachable", code: 10000 },
});
await asDeployed(lobby, { keel: deploying, sent: sentToKeel });
// Cloudflare's consent screen, played: the one account is ticked, and Allow sends the browser back to Keel's
// callback, on the console's own origin, with a code and the state Keel sent it with. Allow is a link the owner
// follows, not a redirect: a request the browser is redirected to from a fulfilled one is not routed again.
const consentsAsked: string[] = [];
await lobby.route(
  (url) => `${url.origin}${url.pathname}` === CONSENT_URL,
  async (route) => {
    const asked = new URL(route.request().url());
    consentsAsked.push(asked.href);
    const back = new URL("/v1/cloudflare/callback", built);
    back.searchParams.set("code", "e2e-code");
    back.searchParams.set("state", asked.searchParams.get("state") ?? "");
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Allow Keel</title><a href="${back.href.replaceAll("&", "&amp;")}">Allow</a>`,
    });
  },
);
const credentialsOn = (shown: Page) => shown.getByRole("region", { name: "Credentials" });
const cloudflareOn = (shown: Page) => shown.getByRole("region", { name: "Cloudflare" });
/** The labels of a section's text fields, in order: what it asks the reader to type. */
const fieldsOf = async (section: Locator): Promise<string> => {
  const labels = await section
    .locator("input:not([type=hidden]), textarea")
    .evaluateAll((fields) =>
      fields.map((field) =>
        field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
          ? (field.labels?.[0]?.textContent ?? field.getAttribute("aria-label") ?? field.name)
          : "",
      ),
    )
    .catch(() => ["unread"]);
  return labels.length === 0 ? "none" : labels.join(", ");
};
const connectsOf = (keel: FakeKeel): Call[] =>
  keel.calls.filter((call) => call.method === "POST" && call.path.endsWith("/cloudflare-connect"));
const setsOf = (keel: FakeKeel, name: string): Call[] =>
  keel.calls.filter(
    (call) => call.method === "PUT" && call.path.endsWith(`/deploy-targets/${name}`),
  );
await person.goto(`${built}/ada/demo/settings`, { waitUntil: "domcontentloaded" });
await cloudflareOn(person)
  .getByText("No connected accounts")
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "cloudflare: a project's owner is offered Connect to Cloudflare, and no field to type into: not a token, not an account, not a target's name",
  `${await cloudflareOn(person).getByText("No connected accounts").count()} | ${await cloudflareOn(
    person,
  )
    .getByRole("form", { name: "Connect a Cloudflare account" })
    .getByRole("button", { name: "Connect to Cloudflare" })
    .count()} button | fields ${await fieldsOf(cloudflareOn(person))}`,
  "1 | 1 button | fields none",
);
const revokeLink = cloudflareOn(person).getByRole("link", {
  name: "Revoke on Cloudflare",
});
expectEqual(
  "cloudflare: the owner is told where Keel's token is revoked, opened apart with no referrer",
  `${String(await revokeLink.getAttribute("href").catch(() => "no link"))} | ${String(await revokeLink.getAttribute("target").catch(() => "none"))} | ${String(await revokeLink.getAttribute("rel").catch(() => "none"))}`,
  "https://dash.cloudflare.com/?to=/:account/api-tokens | _blank | noreferrer",
);
// Each address the browser is sent to on the way, by its path and the names of its query's parts.
const hops: string[] = [];
const noteHop = (asked: { url(): string; isNavigationRequest(): boolean }): void => {
  if (!asked.isNavigationRequest()) return;
  const url = new URL(asked.url());
  const query = [...url.searchParams.keys()].join("&");
  hops.push(
    `${url.origin === built ? "" : url.origin}${url.pathname}${query === "" ? "" : `?${query}`}`,
  );
};
person.on("request", noteHop);
const howItWent = cloudflareOn(person).getByRole("status", { name: "How connecting went" });
await cloudflareOn(person)
  .getByRole("button", { name: "Connect to Cloudflare" })
  .click({ timeout: 15_000 })
  .catch(() => undefined);
await person
  .getByRole("link", { name: "Allow" })
  .click({ timeout: 15_000 })
  .catch(() => undefined);
await howItWent.waitFor({ timeout: 15_000 }).catch(() => undefined);
await person
  .waitForURL((url) => !url.searchParams.has("cloudflare"), { timeout: 5_000 })
  .catch(() => undefined);
person.off("request", noteHop);
expectEqual(
  "cloudflare: Connect to Cloudflare goes to Cloudflare's consent, whose callback brings the owner back to the settings with how it went",
  `${hops.join(" → ")} | ${squash(await howItWent.innerText().catch(() => "nothing said"))}`,
  "https://dash.cloudflare.com/oauth2/auth?state → /v1/cloudflare/callback?code&state → /ada/demo/settings?cloudflare | Connected",
);
expectEqual(
  "cloudflare: once it is said, the address is the settings' own again",
  person.url(),
  `${built}/ada/demo/settings`,
);
const targetRows = cloudflareOn(person)
  .getByRole("list", { name: "Connected accounts" })
  .getByRole("listitem");
await targetRows
  .first()
  .getByText(/Token/)
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "cloudflare: the target is listed as Keel's callback set it, on the account consented to, with its workers.dev subdomain and Keel's own token",
  `${(await targetRows.allInnerTexts()).map(squash).join(" || ")} | ${connectsOf(deploying).length} connect, for ${connectsOf(deploying)[0]?.path.split("/").at(-2) ?? "none"} | ${consentsAsked.length} consent | ${deploying.calls.filter((call) => call.path === "/v1/cloudflare/callback").length} callback | ${setsOf(deploying, "production").length} sets from the page`,
  `production Cloudflare account ${GOOD_ACCOUNT} · Previews ada-previews.workers.dev Token: Keel deploys: ada/demo Remove | 1 connect, for production | 1 consent | 1 callback | 0 sets from the page`,
);
// The token is a credential of the namespace: listed on its owner's settings under the label Keel gave it, and
// removable there. Nothing on that page takes a token.
await person.goto(`${built}/settings`, { waitUntil: "domcontentloaded" });
const storedRows = credentialsOn(person)
  .getByRole("list", { name: "Stored credentials" })
  .getByRole("listitem");
await storedRows
  .first()
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "credentials: the token Keel made is listed on its owner's settings by its label, with Remove, and nothing there takes a token",
  `${(await storedRows.allInnerTexts())
    .map(squash)
    .join(" || ")
    .replace(
      /\d{4}-\d{2}-\d{2}/,
      "<day>",
    )} | ${await credentialsOn(person).locator("form").count()} forms | fields ${await fieldsOf(credentialsOn(person))}`,
  "Keel deploys: ada/demo Cloudflare · stored on <day> by you Remove | 0 forms | fields none",
);
// Keel deletes a credential a target still names, and the target keeps the id: the project says so.
await credentialsOn(person)
  .getByRole("button", { name: "Remove Keel deploys: ada/demo" })
  .click({ timeout: 15_000 })
  .catch(() => undefined);
await credentialsOn(person)
  .getByText("No credential is stored.")
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
await person.goto(`${built}/ada/demo/settings`, { waitUntil: "domcontentloaded" });
await targetRows
  .first()
  .getByText(/Token/)
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "cloudflare: a target whose token was removed says it cannot reach its account, and is listed as Keel keeps it",
  `${(await targetRows.allInnerTexts()).map(squash).join(" || ")} | fields ${await fieldsOf(cloudflareOn(person))}`,
  `production Cloudflare account ${GOOD_ACCOUNT} · Previews ada-previews.workers.dev Token: removed, connect again Remove | fields none`,
);
// At a phone's width the section's words stay on the screen: each run of text is measured where it is drawn.
await person.setViewportSize({ width: 390, height: 844 });
expectEqual(
  "cloudflare: at a phone's width none of the section's words runs past the screen",
  String(
    await cloudflareOn(person).evaluate((section) => {
      const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
      const edges: number[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.textContent ?? "").trim() === "") continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        edges.push(range.getBoundingClientRect().right);
      }
      return edges.length > 3 && Math.max(...edges) <= window.innerWidth;
    }),
  ),
  "true",
);
await shot(person, "cloudflare-phone");
await person.setViewportSize({ width: 1280, height: 900 });
await cloudflareOn(person)
  .getByRole("button", { name: "Remove the target production" })
  .click({ timeout: 15_000 })
  .catch(() => undefined);
await cloudflareOn(person)
  .getByRole("button", { name: "Remove the target production" })
  .waitFor({ state: "detached", timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "cloudflare: removing a target clears it in Keel, and the project has none",
  `${deploying.calls.filter((call) => call.method === "DELETE" && call.path.includes("/deploy-targets/")).length} cleared | ${await cloudflareOn(person).getByText("No connected accounts").count()}`,
  "1 cleared | 1",
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
  .getByText("No projects yet")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "passkey sign-up: their own account is there under the handle, with no project yet, and is not called an org",
  squash(await newcomer.getByRole("main").innerText()),
  "turing Your account Projects No projects yet New project Import a repository Read the quickstart",
);
expectEqual(
  "namespace: a person's own page has their tabs, and with no project yet the two ways to start one and the quickstart",
  `${await namespaceTabsOf(newcomer)} || ${await startsOf(newcomer)}`,
  "*Overview → /turing | Projects0 → /turing?tab=projects | Organizations0 → /turing?tab=orgs | Settings → /settings || New project → /new?owner=turing | Import a repository → /new?owner=turing&start=import | Read the quickstart → /start",
);
await shot(newcomer, "own-empty");
await newcomer
  .getByRole("link", { name: "Import a repository", exact: true })
  .click({ timeout: 10_000 })
  .catch(() => undefined);
await newcomer.waitForURL("**/new?**", { timeout: 10_000 }).catch(() => undefined);
const importing = newcomer.locator('input[type="radio"][value="import"]');
await importing.waitFor({ timeout: 10_000 }).catch(() => undefined);
expectEqual(
  "namespace: Import a repository opens making a project on an import, under the account it was asked from",
  `${pathOf(newcomer)}${new URL(newcomer.url()).search} | ${await importing.isChecked({ timeout: 3_000 }).catch(() => "no form")}`,
  "/new?owner=turing&start=import | true",
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

// An agent asks a person to sponsor it, and hands them a link with a code in its fragment. Whoever holds
// the code can sponsor the agent, so the page keeps it in memory alone: out of the address at once, in no
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
const sponsorAgent = (shown: Page, agent: { name: string }) =>
  shown.getByRole("button", { name: `Sponsor ${agent.name}` });
/** Waits for the sponsor's page to have said something, whatever it is. */
const sponsorPage = async (shown: Page, agent: { name: string }): Promise<void> => {
  await shown.getByRole("heading", { level: 1 }).waitFor();
  await sponsorAgent(shown, agent)
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
};
const forBeta = sponsoring.askSponsor(BETA.id);
await newcomer.goto(linkTo(BETA, forBeta.code), { waitUntil: "domcontentloaded" });
await sponsorPage(newcomer, BETA);
await shot(newcomer, "sponsor");
expectEqual(
  "sponsor: the page names the agent as Keel shows it to anyone, and who would sponsor it",
  `${squash(await newcomer.getByRole("heading", { level: 1 }).innerText())} | ${squash(await newcomer.locator("main dl").innerText())} | ${await sponsorAgent(newcomer, BETA).count()} button | ${await newcomer.getByText("You approve with a passkey, as turing.").count()}`,
  "Sponsor beta? | Agent beta Declared as hosted Works in acme | 1 button | 1",
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
  await sponsorAgent(newcomer, BETA).evaluate(
    (button) =>
      `${String(button.getBoundingClientRect().left >= 0)} ${String(button.getBoundingClientRect().right <= window.innerWidth)}`,
  ),
  "true true",
);
await shot(newcomer, "sponsor-phone");
await newcomer.setViewportSize({ width: 1280, height: 900 });
// One tap: the device's passkey signs them in afresh, and the approval goes as them.
await sponsorAgent(newcomer, BETA).click();
await newcomer
  .getByRole("heading", { level: 1, name: "You sponsor beta" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
const turing = await passkeysAlone.whose("turing");
expectEqual(
  "sponsor: one tap, a passkey touch and then the approval, stands the person behind the agent",
  `${squash(await newcomer.getByRole("heading", { level: 1 }).innerText())} | ${sponsoring.sponsorOf(BETA.id) === turing?.id ? "turing" : String(sponsoring.sponsorOf(BETA.id))} | ${await sponsorAgent(newcomer, BETA).count()} button`,
  "You sponsor beta | turing | 0 button",
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
if ((await sponsorAgent(newcomer, GAMMA).count()) > 0) await sponsorAgent(newcomer, GAMMA).click();
await newcomer
  .getByRole("alert")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sponsor: a code that is no longer good is refused in what Keel said, with Keel's way forward and none of the page's own, and no second try",
  `${(await newcomer.getByRole("alert").count()) === 0 ? "no refusal" : squash(await newcomer.getByRole("alert").innerText())} | ${await sponsorAgent(newcomer, GAMMA).count()} button | ${await newcomer.getByText("Ask the agent for a new link.").count()} | ${sponsoring.sponsorOf(GAMMA.id) ?? "nobody"}`,
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
  "This link is incomplete | /sponsor | 0 asked",
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
  `${new URL(newcomer.url()).pathname} | ${squash(await newcomer.locator("header").first().innerText())} | ${await sponsorAgent(newcomer, GAMMA).count()} button | ${await newcomer.getByText("which also signs you in").count()}`,
  "/sponsor | Keel | 1 button | 1",
);
if ((await sponsorAgent(newcomer, GAMMA).count()) > 0) await sponsorAgent(newcomer, GAMMA).click();
await newcomer
  .getByRole("heading", { level: 1, name: "You sponsor gamma" })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sponsor: a visitor's one tap signs them in and stands them behind the agent, and the frame says who they are",
  `${squash(await newcomer.getByRole("heading", { level: 1 }).innerText())} | ${sponsoring.sponsorOf(GAMMA.id) === turing?.id ? "turing" : String(sponsoring.sponsorOf(GAMMA.id))} | ${squash(await newcomer.locator("header").first().innerText())}`,
  "You sponsor gamma | turing | Keel turing",
);

// The sponsor's own second approval. Keel gave the agent one code and the approval spent it, and Keel gives an
// agent somebody sponsors no other: opened again, the link is a code that is no good and is told as that.
// Nobody is told the agent has a sponsor, or to end a link.
await newcomer.goto(linkTo(GAMMA, forGamma.code), { waitUntil: "domcontentloaded" });
await sponsorPage(newcomer, GAMMA);
if ((await sponsorAgent(newcomer, GAMMA).count()) > 0) await sponsorAgent(newcomer, GAMMA).click();
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
// from their own list of the agents they sponsor. Of an agent they do not sponsor it says nothing.
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
  "agent's own page: its sponsor is told they sponsor it and sent to their settings, where the controls are",
  await aboutAgent(newcomer, GAMMA.handle),
  "Agent Name gamma Declared as interactive You sponsor this agent. Manage it in your settings | /settings",
);
expectEqual(
  "agent's own page: someone who does not sponsor the agent is shown its card and no such line, and no control",
  `${await aboutAgent(newcomer, EPSILON.handle)} | ${await newcomer.getByRole("button", { name: /Pause|Unpause|Stop sponsoring/ }).count()} controls`,
  "Agent Name epsilon | no link | 0 controls",
);

// ── The agents a person sponsors, on their settings ──
// Turing sponsors beta and gamma, and signed in by a passkey a moment ago. The page after a yes links to
// the settings, which list what Keel lists: each agent as it declared itself, and as it stands.
const sponsoredOn = (shown: Page) => shown.getByRole("region", { name: "Agents you sponsor" });
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
const toSettings = newcomer.getByRole("link", { name: "See the agents you sponsor" });
if ((await toSettings.count()) > 0) await toSettings.click();
else await newcomer.goto(`${built}/settings`, { waitUntil: "domcontentloaded" });
await offered(newcomer, "Pause gamma");
await shot(newcomer, "settings-sponsored");
expectEqual(
  "sponsored: the page after a yes links to the settings, which list the agents Keel says the person sponsors, each as it declared itself and as it stands",
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
  "beta declared as hosted · Paused | gamma declared as interactive · Active | suspended | It pushed to the wrong branch | Unpause Stop sponsoring",
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
if ((await control(newcomer, "Stop sponsoring gamma").count()) > 0)
  await control(newcomer, "Stop sponsoring gamma").click();
await control(newcomer, "Stop sponsoring gamma")
  .waitFor({ state: "detached", timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sponsored: ending is one click, the row is gone, and Keel says nobody sponsors the agent and that it is active again",
  `${await sponsoredRows(newcomer)} | ${sponsoring.sponsorOf(GAMMA.id) ?? "nobody"} | ${sponsoring.standingOf(GAMMA.id)}`,
  "beta declared as hosted · Active | nobody | active",
);
// An agent that signed itself up has a handle and declared no kind, as most do: the page names it by both, has
// no row for a kind it never gave, and offers cancel or approve, as a code host's page for authorising an app.
const forEpsilon = sponsoring.askSponsor(EPSILON.id);
await newcomer.goto(linkTo(EPSILON, forEpsilon.code), { waitUntil: "domcontentloaded" });
await sponsorPage(newcomer, EPSILON);
await shot(newcomer, "sponsor-handle");
expectEqual(
  "sponsor: an agent with a handle and no declared kind is named by both, with no empty row, in plain sentences, with cancel and approve",
  squash(await newcomer.locator("main").innerText()),
  "Sponsor epsilon? epsilon (epsilon-heron) is asking you to sponsor it. Agent epsilon Handle epsilon-heron Its questions come to you. You can pause it or stop sponsoring it at any time. It gets none of your access and never acts as you. Cancel Sponsor epsilon You approve with a passkey, as turing.",
);
expectEqual(
  "sponsor: cancel leaves for the projects and approves nothing",
  `${await newcomer
    .getByRole("link", { name: "Cancel" })
    .getAttribute("href")
    .catch(() => "no cancel")} | ${sponsoring.sponsorOf(EPSILON.id) ?? "nobody"}`,
  "/ | nobody",
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
    `legal: /${which} has the foot every page has, the two legal documents and nothing else`,
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
expectEqual(
  "legal: an account's page has the foot, the two legal documents and nothing else",
  await footOf(reading),
  "/terms /privacy",
);
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
expectEqual(
  "legal: a project's page has the foot, the two legal documents and nothing else",
  await footOf(reading),
  "/terms /privacy",
);
await reading
  .locator("footer a", { hasText: "Privacy Notice" })
  .click({ timeout: 5000 })
  .catch(() => {});
await reading.waitForURL("**/privacy", { timeout: 5000 }).catch(() => {});
// The document is drawn by a file of its own, asked for once the page knows it is drawing one.
await reading
  .locator("article h1")
  .waitFor({ timeout: 5000 })
  .catch(() => {});
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
  story: "s2",
  readerOf,
  whose: whoseHandle,
  verdictViews: false,
});
const plainly = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await asDeployed(plainly, { keel: asKeelServes });
const reader = watch(await plainly.newPage(), "a change's page, as Keel serves a verdict");
// The change the address names, the agent that declared it and the verdict it bounced on, from the stand-in's
// own log: nine days on, the careless change bounced on its batch's verdict. The verdict names the batch, and the
// bounce names the verdict.
const declaredCareless = asKeelServes
  .events()
  .find((event) => event.type === "IntentDeclared" && event.label === "#1205");
const careless = declaredCareless?.type === "IntentDeclared" ? declaredCareless.payload : undefined;
const itsBounce = asKeelServes
  .events()
  .findLast(
    (event) => event.type === "ChangeBounced" && event.payload.changeId === careless?.changeId,
  );
const itsVerdict = asKeelServes
  .events()
  .find(
    (event) =>
      event.type === "VerdictIssued" &&
      itsBounce?.type === "ChangeBounced" &&
      event.payload.verdictId === itsBounce.payload.verdictId,
  );
await reader.goto(`${built}/ada/demo/changes/1205`, { waitUntil: "domcontentloaded" });
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
  "Keel's verdict was to bounce it.",
);
await reader.goto(`${built}/ada/demo/changes/1205/checks`, { waitUntil: "domcontentloaded" });
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
await noether.getByRole("button", { name: "Invite member" }).click();
await noether
  .getByRole("dialog", { name: "Invite member" })
  .getByLabel("Handle or email")
  .fill("franklin");
await noether
  .getByRole("dialog", { name: "Invite member" })
  .getByRole("button", { name: "Invite", exact: true })
  .click();
const joining = noether.locator("[data-invitation-link]");
await joining.waitFor();
await franklin.goto(new URL(await joining.innerText()).href, { waitUntil: "domcontentloaded" });
await franklin.getByRole("button", { name: "Join" }).click();
await franklin.getByRole("heading", { level: 1, name: /^Symmetry/ }).waitFor();
// An org's credentials are a tab of the org, offered to its owners alone; Keel reads them to nobody else.
await noether.goto(`${built}/orgs/symmetry/credentials`, { waitUntil: "domcontentloaded" });
await credentialsOn(noether)
  .getByText("No credential is stored.")
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "credentials: an org's owner has its credentials as a tab of the org, listed, and nothing there takes a token",
  `${(await noether.getByRole("navigation", { name: "Org" }).getByRole("link").allInnerTexts()).map(squash).join(" | ")} | ${await credentialsOn(noether).getByText("No credential is stored.").count()} | ${await credentialsOn(noether).locator("form").count()} forms | fields ${await fieldsOf(credentialsOn(noether))}`,
  "Overview | Projects 0 | People 2 | Credentials | Settings | 1 | 0 forms | fields none",
);
await franklin.goto(`${built}/orgs/symmetry/credentials`, { waitUntil: "domcontentloaded" });
await credentialsOn(franklin)
  .getByRole("alert")
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "credentials: a member who is no owner is offered no tab of the org's credentials",
  (await franklin.getByRole("navigation", { name: "Org" }).getByRole("link").allInnerTexts())
    .map(squash)
    .join(" | "),
  "Overview | Projects 0 | People 2",
);
expectEqual(
  "credentials: at the tab's address, a member who is no owner is told Keel's refusal and offered nothing to remove",
  `${squash(
    await credentialsOn(franklin)
      .getByRole("alert")
      .innerText()
      .catch(() => "no refusal"),
  )} | ${await credentialsOn(franklin).getByRole("button").count()} buttons`,
  "Refused: role. Ask an owner: this needs that role | 0 buttons",
);

/** The org home's section of the agents that have joined it. */
const orgAgentsOn = (shown: Page): Locator => shown.locator('main section[aria-label="Agents"]');
/** On an org's People page, the agents' rows, in its members and its pending invitations: each has an Agent tag. */
const orgAgentList = (shown: Page): Locator =>
  shown
    .getByRole("main")
    .getByRole("listitem")
    .filter({ has: shown.locator(".a-chip", { hasText: /^Agent$/ }) });
const orgAgentRows = async (shown: Page): Promise<string[]> =>
  (await orgAgentList(shown).allInnerTexts()).map(squash);
/** Keel's refusal where agents are added: the open dialog, or else the page. */
const refusalOn = async (shown: Page): Promise<string> => {
  const dialog = shown.getByRole("dialog");
  const alert = ((await dialog.count()) > 0 ? dialog : shown.getByRole("main")).getByRole("alert");
  return (await alert.count()) === 0 ? "no refusal" : squash(await alert.first().innerText());
};
/** The page has come to say something of an agent, or to a refusal: whichever Keel's answer made it. */
const answeredOn = async (shown: Page, row: string): Promise<void> => {
  await Promise.race([
    orgAgentList(shown).getByText(row).first().waitFor({ timeout: 10_000 }),
    shown.getByRole("alert").first().waitFor({ timeout: 10_000 }),
  ]).catch(() => undefined);
};
/** Invite agent: the dialog opened where it is not yet, the agent's handle, its role, and Invite. */
const inviteAgent = async (shown: Page, handle: string, grant?: string): Promise<void> => {
  const dialog = shown.getByRole("dialog", { name: "Invite agent" });
  if ((await dialog.count()) === 0)
    await shown.getByRole("button", { name: "Invite agent" }).click();
  await dialog.getByLabel("Agent handle or name").fill(handle);
  if (grant !== undefined) await dialog.getByRole("combobox").selectOption({ label: grant });
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
};
const lastInvitation = (): string =>
  hosting.calls.findLast((call) => call.method === "POST" && call.path.endsWith("/agents"))?.body ??
  "nothing asked";

// Any member invites: Franklin is a plain one, and sponsors Tidy Otter. What the row then says is what Keel answered.
hosting.sponsors(OTTER.id, (await inviting.whose("franklin"))?.id ?? "");
await franklin.goto(`${built}/orgs/symmetry/members`, { waitUntil: "domcontentloaded" });
await franklin.getByRole("list", { name: "Members of this org" }).waitFor();
await franklin.getByRole("button", { name: "Invite agent" }).click();
const agentDialog = franklin.getByRole("dialog", { name: "Invite agent" });
const sponsoredFound = agentDialog.getByRole("list", { name: "Agents you sponsor" });
const offeredNow = async (): Promise<string> =>
  (await sponsoredFound.count()) === 0
    ? "nothing offered"
    : (await sponsoredFound.getByRole("listitem").allInnerTexts()).map(squash).join(" | ");
// With nothing typed, the agents he sponsors are offered to pick from, as a code host's "Add people" suggests
// people. Picking one puts its handle in the box.
await sponsoredFound.waitFor({ timeout: 5000 }).catch(() => undefined);
expectEqual(
  "org agents: with nothing typed, the agents the reader sponsors are offered to pick from, each by name and handle",
  await offeredNow(),
  "Tidy Otter @tidy-otter",
);
if ((await sponsoredFound.count()) > 0)
  await sponsoredFound.getByRole("button", { name: /Tidy Otter/ }).click();
expectEqual(
  "org agents: picking an offered agent puts its handle in the box, and offers nothing more under it",
  `${await agentDialog.getByLabel("Agent handle or name").inputValue()} | ${await offeredNow()}`,
  "tidy-otter | nothing offered",
);
// Typing part of its name finds it among the agents he sponsors, with its handle beside it, as a code host's
// "Add people" finds someone by their name.
await agentDialog.getByLabel("Agent handle or name").fill("tidy ot");
await sponsoredFound.waitFor({ timeout: 5000 }).catch(() => undefined);
expectEqual(
  "org agents: typing part of a sponsored agent's name finds it, its name and handle side by side",
  (await sponsoredFound.count()) === 0
    ? "nothing found"
    : (await sponsoredFound.getByRole("listitem").allInnerTexts()).map(squash).join(" | "),
  "Tidy Otter @tidy-otter",
);
await shot(franklin, "invite-agent");
await inviteAgent(franklin, "Tidy Otter", "Read");
await answeredOn(franklin, "Tidy Otter");
expectEqual(
  "org agents: a plain member invites an agent he sponsors by its name, Keel is asked for its handle, to read alone, and its row, pending, says what Keel answered",
  `${(await orgAgentRows(franklin)).join(" | ")} | ${await franklin.getByRole("list", { name: "Invitations not yet answered" }).getByText("Tidy Otter").count()} pending | ${lastInvitation()}`,
  'Tidy Otter Agent @tidy-otter · Invited by you Read | 1 pending | {"agent":"tidy-otter","scopes":["agent:read"]}',
);
await franklin.getByRole("button", { name: "Invite agent" }).click();
await agentDialog.waitFor();
expectEqual(
  "org agents: an agent the org has invited is not offered again",
  await offeredNow(),
  "nothing offered",
);
// A handle no agent has, typed with a space either side of it: Keel is asked for the handle, and says so.
await inviteAgent(franklin, " nobody-here ");
await agentDialog
  .getByRole("alert")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
const nobodyRefused = await refusalOn(franklin);
await shot(franklin, "invite-agent-refused");
// The dialog stays open on a refusal, and holds the page behind it until it is closed.
await franklin
  .getByRole("dialog", { name: "Invite agent" })
  .getByRole("button", { name: "Cancel" })
  .click();
await franklin.getByRole("dialog").waitFor({ state: "detached" });
expectEqual(
  "org agents: a handle no agent has is refused in Keel's own sentence, and nobody is invited",
  `${nobodyRefused} | ${(await orgAgentRows(franklin)).length} listed`,
  "No agent has the handle nobody-here. | 1 listed",
);

// The owner reads who invited it, and invites a second one to read and work.
await noether.goto(`${built}/orgs/symmetry/members`, { waitUntil: "domcontentloaded" });
await answeredOn(noether, "Tidy Otter");
await inviteAgent(noether, "unbroken-heron");
await answeredOn(noether, UNBROKEN.name);
const invitedBy = (rows: readonly string[]): string =>
  rows.map((row) => /Invited by \S+/.exec(row)?.[0] ?? "by nobody").join(" | ");
expectEqual(
  "org agents: each row names the member who invited the agent: by handle, and as you where it is the reader",
  `${invitedBy(await orgAgentRows(noether))} | ${lastInvitation()}`,
  'Invited by @franklin | Invited by you | {"agent":"unbroken-heron","scopes":["agent:read","agent:work"]}',
);
/** What each agent row's menu offers, opened and closed again: its items, and whose row it is. */
const removals = async (shown: Page): Promise<string[]> => {
  const said: string[] = [];
  for (const menu of await orgAgentList(shown).getByRole("button").all()) {
    const rowOf = (await menu.getAttribute("aria-label"))?.replace("Actions for ", "") ?? "";
    await menu.click();
    await shown.getByRole("menuitem").first().waitFor();
    said.push(
      `${(await shown.getByRole("menuitem").allInnerTexts()).map(squash).join("/")} ${rowOf}`,
    );
    await shown.keyboard.press("Escape");
    await shown.getByRole("menu").waitFor({ state: "detached" });
  }
  return said;
};
await franklin.goto(`${built}/orgs/symmetry/members`, { waitUntil: "domcontentloaded" });
await answeredOn(franklin, UNBROKEN.name);
expectEqual(
  "org agents: a plain member is offered the removal of the agent they invited and of no other, an owner of each",
  `${(await removals(franklin)).join(", ")} | ${(await removals(noether)).length}`,
  "Cancel invitation tidy-otter | 2",
);
// At a phone's width a name with nowhere to break wraps. A box that cannot grow keeps to the screen while its
// words run out of it, so what is measured is where each piece of text is drawn, beside each box.
await noether.setViewportSize({ width: 390, height: 844 });
expectEqual(
  "org agents: at a phone's width no word of the page, and no part of it, runs past the screen",
  String(
    await noether.evaluate(() => {
      const section = document.querySelector("main");
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
  `${String((await orgAgentRows(noether))[0]?.includes(`Joined ${today}`))} | ${String(await orgAgentList(noether).getByRole("link", { name: "Tidy Otter" }).getAttribute("href"))} | ${(await removals(noether)).join(", ")}`,
  `true | /tidy-otter | Remove tidy-otter, Cancel invitation unbroken-heron`,
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
  `Tidy Otter Joined ${today} | /tidy-otter`,
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
  `Tidy Otter Joined ${today} | /tidy-otter`,
);

// Ten minutes on, Keel takes no removal from this sign-in: it says so and how to go on, and the page offers the
// passkey touch that answers it.
await inviting.age();
await noether.goto(`${built}/orgs/symmetry/members`, { waitUntil: "domcontentloaded" });
await answeredOn(noether, "Tidy Otter");
await fromMenu(noether, "Actions for tidy-otter", "Remove");
await noether
  .getByRole("main")
  .getByRole("alert")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
const touchForAgents = noether
  .getByRole("main")
  .getByRole("button", { name: "Confirm with passkey" });
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
  "Invited by you | 1 listed | no refusal",
);
// An agent invited to one project of a person's own namespace, as a code host has a repository's collaborators.
// The project is Noether's own here, and public, so anyone reads it. She is its owner; Franklin is nobody to it.
const whoseAmongThem = async (handle: string) =>
  (await inviting.whose(handle)) ??
  [OTTER, UNBROKEN]
    .filter((agent) => agent.handle === handle)
    .map((agent) => ({ id: agent.id, kind: "agent" as const }))[0];
const personal = createFakeKeel({
  namespace: { handle: "noether", kind: "user" },
  visibility: "public",
  agents: [OTTER, UNBROKEN],
  readerOf: async (request) => {
    const asking = await inviting.reads(request);
    if (asking === null) return null;
    return (await inviting.whose("noether"))?.id === asking.id
      ? { ...asking, role: "owner" as const }
      : asking;
  },
  whose: whoseAmongThem,
  roleIn: (userId, org) => inviting.roleIn(userId, org),
});
// The route put on last is the one that answers: from here Noether's Keel is the one with her own project.
await asDeployed(noether.context(), { keel: personal, identity: inviting });
/** A project's settings list who has access to it, as a code host's Collaborators: people and agents in one list. */
const accessOn = (shown: Page): Locator =>
  shown.locator('main section[aria-label="Collaborators"]');
const invitedOn = (shown: Page): Locator =>
  accessOn(shown).getByRole("list", { name: "Who has access to this project" });
const accessRows = async (shown: Page): Promise<string[]> =>
  (await invitedOn(shown).getByRole("listitem").allInnerTexts()).map(squash);
/** The rows of the agents added, which are all but the owner's. */
const invitedRows = async (shown: Page): Promise<string[]> =>
  (await accessRows(shown)).filter((row) => !row.endsWith(" owner"));
const lastProjectInvitation = (): string =>
  personal.calls.findLast(
    (call) => call.method === "POST" && call.path === `/v1/projects/${personal.project.id}/agents`,
  )?.body ?? "nothing asked";
await noether.goto(`${built}/noether/demo/settings`, { waitUntil: "domcontentloaded" });
await accessOn(noether)
  .getByText("No agent has been invited to this project.")
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
if ((await accessOn(noether).getByLabel("The agent's handle").count()) > 0) {
  await accessOn(noether).getByLabel("The agent's handle").fill("tidy-otter");
  await accessOn(noether)
    .getByLabel("What the agent may do on this project")
    .selectOption({ label: "Read" });
  await accessOn(noether).getByRole("button", { name: "Add agent" }).click();
}
await Promise.race([
  invitedOn(noether).getByText("Tidy Otter").first().waitFor({ timeout: 10_000 }),
  accessOn(noether).getByRole("alert").first().waitFor({ timeout: 10_000 }),
]).catch(() => undefined);
await shot(noether, "project-agents");
expectEqual(
  "project agents: the owner invites an agent to her own project by its handle, to read alone, and the row says what Keel answered and nothing of who invited",
  `${(await invitedRows(noether)).join(" | ") || "nothing listed"} | ${lastProjectInvitation()}`,
  'Tidy Otter agent Read · Pending Cancel invitation | {"agent":"tidy-otter","scopes":["agent:read"]}',
);
// The agent accepts, which is its own call. The project's settings then list who has access: its owner and the
// agent, each in the same row, the agent marked as one.
personal.joins(personal.project.id, OTTER.id);
await noether.goto(`${built}/noether/demo/settings`, { waitUntil: "domcontentloaded" });
await invitedOn(noether)
  .getByText(/Joined/)
  .first()
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
await shot(noether, "project-collaborators");
expectEqual(
  "project access: the settings list who has access in one list, the owner and the agent alike, the agent marked as one and linked to its page",
  `${(await accessRows(noether)).join(" | ") || "nothing listed"} | ${await invitedOn(noether)
    .getByRole("link")
    .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? "").join(" "))
    .catch(() => "no links")}`,
  `noether owner | Tidy Otter agent Read · Joined ${today} Remove | /noether /tidy-otter`,
);
// Ten minutes on, Keel takes no removal from this sign-in, and the page offers the passkey touch that answers it.
await inviting.age();
await noether.goto(`${built}/noether/demo/settings`, { waitUntil: "domcontentloaded" });
await invitedOn(noether)
  .getByText("Tidy Otter")
  .first()
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
const takeOff = invitedOn(noether).getByRole("button", {
  name: /^(Remove|Cancel invitation) Tidy Otter$/,
});
if ((await takeOff.count()) > 0) await takeOff.click();
await accessOn(noether)
  .getByRole("alert")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
const touchForProject = accessOn(noether).getByRole("button", { name: SIGN_IN_AGAIN });
expectEqual(
  "project agents: a removal from a sign-in that is not fresh is refused in Keel's sentence with its way forward, a passkey touch is offered, and the agent is still on the project",
  `${await refusalOn(noether)} | ${await touchForProject.count()} offered | ${(await invitedRows(noether)).length} listed`,
  "This needs a fresh sign-in: a passkey sign-in from the last ten minutes. Sign in again with your passkey, then retry | 1 offered | 1 listed",
);
if ((await touchForProject.count()) > 0) await touchForProject.click();
await accessOn(noether)
  .getByText("No agent has been invited to this project.")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "project agents: one touch signs in afresh and asks again what Keel refused, and the agent is off the project",
  `${(await invitedRows(noether)).length} listed | ${await refusalOn(noether)}`,
  "0 listed | no refusal",
);
// An org's project takes no invitation of its own: its settings say so, and send a maintainer to the org.
const ofTheOrg = createFakeKeel({
  namespace: { handle: "symmetry", kind: "org" },
  visibility: "private",
  agents: [OTTER, UNBROKEN],
  readerOf: async (request) => {
    const asking = await inviting.reads(request);
    if (asking === null) return null;
    const role = await inviting.roleIn(asking.id, "symmetry");
    return role === undefined ? asking : { ...asking, role };
  },
  whose: whoseAmongThem,
  roleIn: (userId, org) => inviting.roleIn(userId, org),
});
await asDeployed(noether.context(), { keel: ofTheOrg, identity: inviting });
await noether.goto(`${built}/symmetry/demo/settings`, { waitUntil: "domcontentloaded" });
await noether
  .getByRole("heading", { name: "Who may read this project" })
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "project access: an org's project is its members', people and agents alike, and sends its maintainer to the org's members page to see who and add one",
  (await accessOn(noether).count()) === 0
    ? "no section"
    : `${await accessOn(noether).getByRole("button").count()} buttons | ${String(await accessOn(noether).getByRole("link").first().getAttribute("href"))} | ${squash(await accessOn(noether).innerText())}`,
  "0 buttons | /orgs/symmetry/members | Collaborators Everyone in symmetry has access to this project, its people and its agents alike. See who, and add an agent, on symmetry's members page",
);
// Sync from upstream, on the settings of a project imported from a public repository, for its owner alone, as a
// code host's "Sync fork": upstream named, trunk's head, the action, and what Keel answered.
const syncOn = (shown: Page): Locator =>
  shown.locator('main section[aria-label="Sync from upstream"]');
const syncButton = (shown: Page): Locator =>
  syncOn(shown).getByRole("button", { name: "Sync from upstream" });
const syncSaid = async (shown: Page): Promise<string> =>
  (await syncOn(shown).locator("output").count()) === 0
    ? "nothing said"
    : squash(await syncOn(shown).locator("output").innerText());
/** Whether a sync is offered once the page has had the log's first entry: a short wait, which a fault would meet. */
const syncOffered = async (shown: Page): Promise<string> => {
  await syncOn(shown)
    .waitFor({ timeout: 3000 })
    .catch(() => undefined);
  return `${await syncOn(shown).count()} offered`;
};
// The org's project above was made empty, not imported: its owner is offered no sync.
expectEqual(
  "sync: a project that was not imported offers its owner no sync from upstream",
  await syncOffered(noether),
  "0 offered",
);
const UPSTREAM_HEAD = "5f0e1d2c3b4a5968778695a4b3c2d1e0f9e8d7c6";
const importedOf = (diverged: boolean) =>
  createFakeKeel({
    namespace: { handle: "symmetry", kind: "org" },
    visibility: "private",
    imported: {
      url: "https://github.com/acme/demo",
      ref: "refs/heads/main",
      head: UPSTREAM_HEAD,
      diverged,
    },
    readerOf: async (request) => {
      const asking = await inviting.reads(request);
      if (asking === null) return null;
      const role = await inviting.roleIn(asking.id, "symmetry");
      return role === undefined ? asking : { ...asking, role };
    },
    whose: whoseAmongThem,
    roleIn: (userId, org) => inviting.roleIn(userId, org),
  });
/** Trunk's head as the stand-in's log has it now. */
const trunkIn = (keel: ReturnType<typeof importedOf>): string => {
  let head = "";
  for (const event of keel.events()) {
    if (event.type === "TrunkInitialized") head = event.payload.head;
    if (event.type === "TrunkAdvanced" || event.type === "TrunkSynced") head = event.payload.to;
  }
  return head;
};
const syncing = importedOf(false);
const startedAt = trunkIn(syncing).slice(0, 7);
await asDeployed(noether.context(), { keel: syncing, identity: inviting });
await asDeployed(franklin.context(), { keel: syncing, identity: inviting });
await noether.goto(`${built}/symmetry/demo/settings`, { waitUntil: "domcontentloaded" });
await syncButton(noether)
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
const offeredSync =
  (await syncOn(noether).count()) === 0 ? "no section" : squash(await syncOn(noether).innerText());
if ((await syncButton(noether).count()) > 0) await syncButton(noether).click();
await syncOn(noether)
  .locator("output")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
const firstSync = await syncSaid(noether);
// Keel's feed brings its TrunkSynced, and trunk's row follows it.
await syncOn(noether)
  .getByRole("link", { name: UPSTREAM_HEAD.slice(0, 7) })
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
const trunkAfter = await syncOn(noether)
  .locator("dd a")
  .last()
  .innerText()
  .catch(() => "no trunk");
await shot(noether, "project-sync");
if ((await syncButton(noether).count()) > 0) await syncButton(noether).click();
await syncOn(noether)
  .getByText("Already up to date.")
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sync: the owner of an imported project is offered a sync from upstream on its settings, naming upstream and trunk, fast-forwards trunk, and asked again it is already up to date",
  `${offeredSync} | ${firstSync} | trunk ${trunkAfter} | ${await syncSaid(noether)} | ${
    syncing.calls.filter(
      (call) => call.method === "POST" && call.path === `/v1/projects/${syncing.project.id}/sync`,
    ).length
  } asked`,
  `Sync from upstream Fast-forward trunk to the latest commit on main. Keel refuses if trunk has commits that main does not. Upstream https://github.com/acme/demo main Trunk ${startedAt} Sync from upstream | Fast-forwarded trunk from ${startedAt} to 5f0e1d2. | trunk 5f0e1d2 | Already up to date. | 2 asked`,
);
expectEqual(
  "sync: the upstream is linked at its own address, opened apart from the console",
  await syncOn(noether)
    .getByRole("link", { name: "https://github.com/acme/demo" })
    .evaluate((anchor) => `${anchor.getAttribute("href")} ${anchor.getAttribute("target")}`)
    .catch(() => "no link"),
  "https://github.com/acme/demo _blank",
);
// A plain member of the org reads the project's settings, and is offered no sync: Keel takes one from the owner alone.
await franklin.goto(`${built}/symmetry/demo/settings`, { waitUntil: "domcontentloaded" });
await franklin
  .getByRole("heading", { name: "Who may read this project" })
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
expectEqual(
  "sync: a member who is not the owner is offered no sync from upstream",
  await syncOffered(franklin),
  "0 offered",
);
// Where trunk has commits upstream lacks, Keel refuses, naming both heads, and trunk stays where it was.
const behind = importedOf(true);
const behindAt = trunkIn(behind);
await asDeployed(noether.context(), { keel: behind, identity: inviting });
await noether.goto(`${built}/symmetry/demo/settings`, { waitUntil: "domcontentloaded" });
await syncButton(noether)
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
if ((await syncButton(noether).count()) > 0) await syncButton(noether).click();
await syncOn(noether)
  .getByRole("alert")
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
expectEqual(
  "sync: where trunk is no fast-forward of upstream, Keel's refusal names both heads in its own words, nothing is said to have moved, and trunk stays",
  `${
    (await syncOn(noether).getByRole("alert").count()) === 0
      ? "no refusal"
      : squash(await syncOn(noether).getByRole("alert").first().innerText())
  } | ${await syncSaid(noether)} | ${trunkIn(behind) === behindAt ? "trunk stayed" : "trunk moved"}`,
  `Trunk is at ${behindAt}, and upstream's head ${UPSTREAM_HEAD} does not descend from it: trunk holds commits upstream lacks, or upstream's history was rewritten. Nothing was moved. | nothing said | trunk stayed`,
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
