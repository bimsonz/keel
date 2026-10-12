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
import { type BrowserContext, type Page, chromium } from "playwright";
import { encode } from "uqr";
import { build, preview } from "vite";
import { createAccount } from "../src/account/account.ts";
import { type Identity, createIdentity } from "../test/fixtures/identity/standIn.ts";
import { type FakeKeel, type Reader, createFakeKeel } from "../test/fixtures/mock/fakeKeel.ts";

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
const shot = async (shown: Page, name: string): Promise<void> => {
  const folder = process.env["SHOTS"];
  if (folder !== undefined && folder !== "")
    await shown.screenshot({ path: `${folder}/${name}.png` });
};
/** The frame's tabs: the places a project has. */
const tabsOf = (page: Page) => page.getByRole("navigation", { name: "Project" }).getByRole("link");
const qrOn = (page: Page) =>
  page.locator("svg", { has: page.locator("title", { hasText: "QR code" }) });
const stageOn = async (page: Page, index: number): Promise<string> =>
  (await page.locator("table.a-funnel tbody tr").nth(index).locator("td").allInnerTexts())
    .map(squash)
    .join(" | ");

// ─────────────────────────────────────────────────────────────────────────────
// The pages, on the fixtures the dev server serves
// ─────────────────────────────────────────────────────────────────────────────
const page = watch(await browser.newPage({ viewport: { width: 1920, height: 1080 } }), "fixtures");
const stat = (label: string): Promise<string> => statOn(page, label);
const stage = (index: number): Promise<string> => stageOn(page, index);
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

// Insights: trunk's numbers with what each means, the review funnel, and the benchmark where a run was sealed.
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
  "stages in the funnel",
  String(await page.locator("table.a-funnel tbody tr").count()),
  "6",
);
expectEqual(
  "stages are named as stages",
  squash(await page.locator("table.a-funnel tbody tr").nth(2).locator("th").innerText()).slice(
    0,
    12,
  ),
  "Stage 2 Clef",
);
expectEqual("comparisons per change", await stat("Comparisons per change"), "2.4");
expectEqual(
  "subject index",
  await stage(0),
  "1,004,556 | 1,002,025 99.7% 1,002,025 settled here, 2,531 passed on | 2,531 | $0.00016",
);
expectEqual(
  "lattice",
  await stage(1),
  "2,531 | 2,146 84.8% 2,146 settled here, 385 passed on | 385 | $0",
);
expectEqual(
  "code model, one probe still being drafted",
  await stage(3),
  "16 | 0 0% 1 still here, 15 passed on 1 still here | 15 | $0.014",
);
expectEqual(
  "probe, four still deciding",
  await stage(4),
  "15 | 10 66.7% 10 settled here, 4 still here, 1 passed on 3 dismissed as false alarms · 7 proven · 4 still here | 1 | $0.011",
);
expectEqual(
  "a person, being asked",
  await stage(5),
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
/** The org the stand-in's project is in: Ada's own, once she has signed up below. */
const ORG = "ada";

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
  const org = await asThem.org(ORG, who).catch(() => null);
  return org === null ? {} : { role: org.role };
};

// Two Keels, alike but for who may read the project: on one its org has made it public, on the other it has not.
// On each, 1,200 entries of other projects lie ahead of this one's in the instance's log, as they do for every
// project of a Keel but its first: a stretch of them is an empty page whose cursor has moved on.
const AHEAD = 1200;
const open = createFakeKeel({ org: ORG, visibility: "public", readerOf, ahead: AHEAD });
const shut = createFakeKeel({ org: ORG, visibility: "private", readerOf, ahead: AHEAD });

/** What the page sent to /v1, as the browser sent it. */
interface Sent {
  path: string;
  authorization: string | undefined;
  /** The claim code, where a request carried one. */
  claim: string | undefined;
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
      claim: headers["keel-claim"],
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
  "Code | Changes 2 open | Conflicts 1 open | Escalations 1 waiting for a person | Mission Control | Insights";
/**
 * The tabs as someone who is no member of the project's org is shown them: Keel reads a project's questions to
 * its members alone, so none is counted for anyone else.
 */
const PUBLIC_ON_TABS =
  "Code | Changes 2 open | Conflicts 1 open | Escalations | Mission Control | Insights";
const QUESTION_ASKED = /May permission checks be cached within a session\?/;
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
const toldAt = async (shown: Page, org: string, name: string): Promise<string> => {
  await shown.goto(`${built}/${org}/${name}`, { waitUntil: "domcontentloaded" });
  await shown.getByRole("heading").first().waitFor();
  await shown.waitForTimeout(400);
  // A page that could not read Keel at all has no frame. What it says is still read, so that a check can say so.
  const said =
    (await shown.getByRole("main").count()) > 0 ? shown.getByRole("main") : shown.locator("body");
  return `${squash(await said.innerText()).replaceAll(`${org}/${name}`, "<org>/<name>")} | ${await tabsOf(shown).count()} tabs`;
};
const NO_PROJECT = "There is no project <org>/<name> here";

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
await visitor.goto(`${built}/`, { waitUntil: "domcontentloaded" });
// The home lists the projects Keel names to anyone, each under its org.
await visitor.getByRole("list", { name: "Projects" }).getByRole("link").first().waitFor();
expectEqual(
  "visitor: the home lists the public projects, each under its org",
  squash(await visitor.getByRole("list", { name: "Projects" }).innerText()),
  "ada / demo public",
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
await visitor.goto(`${built}/ada/demo/mission-control`, { waitUntil: "domcontentloaded" });
await visitor.locator("dl.a-trunk-line").waitFor();
expectEqual(
  "visitor: changes landed, and no count of people asked, which a visitor is not read",
  await statOn(visitor, "People asked / changes landed"),
  "—/0",
);
await shot(visitor, "visitor-mission-control");
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

// Keel sends no funnel counters yet: those stages are left empty, and probes and questions are counted from events.
await visitor.goto(`${built}/ada/demo/insights/funnel`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { name: "Review funnel" }).waitFor();
expectEqual(
  "built: stages with no count are left empty",
  String(await visitor.getByText("not counted yet").count()),
  "4",
);
expectEqual("built: subject index", await stageOn(visitor, 0), "— | — not counted yet | — | —");
expectEqual(
  "built: probe, counted from events",
  await stageOn(visitor, 4),
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
expectEqual(
  "visitor: the stage where a person is asked is not counted, and says whose it is to read",
  `${await stageOn(visitor, 5)} | ${await statOn(visitor, "People asked").catch(() => "no tile")}`,
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
await shot(visitor, "visitor-changes");
await visitor.goto(`${built}/ada/demo/changes/1`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("main").getByRole("heading").first().waitFor();
await visitor.waitForTimeout(500);
await shot(visitor, "visitor-change");
// Keel names a project's agents to its members. A visitor is shown that a change has an agent, and neither
// which nor of what kind: no class is made up for it.
expectEqual(
  "visitor: a change's agent is not named, and is given no class Keel did not say",
  `${squash(
    await visitor
      .getByRole("complementary")
      .getByText("Agent", { exact: true })
      .last()
      .innerText()
      .catch(() => "no agent shown"),
  )} | ${await visitor.getByText(/\b(REAL|HOSTED|SYNTHETIC)\b/).count()} classes`,
  "Agent | 0 classes",
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
          .replace(/\/v1\/verdicts\/.+/, "/v1/verdicts/{id}")
          .replace(/\/v1\/probes\/[^/]+\/source$/, "/v1/probes/{id}/source")
          .replace(/\/v1\/orgs\/[^/]+\/projects\/[^/]+$/, "/v1/orgs/{org}/projects/{name}")
          .replace(/\/v1\/projects\/[^/]+\//, "/v1/projects/{id}/"),
      ),
    ),
  ]
    .toSorted()
    .join(" "),
  "/v1/events /v1/lattices /v1/orgs/{org}/projects/{name} /v1/probes/{id}/source /v1/projects /v1/projects/{id}/repo/blob /v1/projects/{id}/repo/commits /v1/projects/{id}/repo/tree /v1/verdicts/{id}",
);
// The page put nothing of its own on anything it asked: no token, no key. A visitor's browser holds no session.
expectEqual(
  "visitor: the page sent Keel no credential, and the browser had none to send",
  `${visitorSent.filter((request) => request.authorization !== undefined).length} ${open.calls.filter((call) => call.authorization !== "").length} ${(await street.cookies()).length}`,
  "0 0 0",
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
await person.getByRole("heading", { name: "Your account" }).waitFor();
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

// A passkey, made on this device and kept by Keel under the name given.
await person.getByText("You have no passkey yet.").waitFor();
await person.getByLabel("Name for a new passkey").fill("This laptop");
await person.getByRole("button", { name: "Add a passkey" }).click();
await person.getByRole("list", { name: "Your passkeys" }).getByText("This laptop").waitFor();
await shot(person, "settings");
expectEqual(
  "account: the passkey is listed",
  String(await person.getByRole("list", { name: "Your passkeys" }).getByRole("listitem").count()),
  "1",
);

// Sign out, then back in with the passkey alone: no address and no code.
await person.getByRole("button", { name: "Sign out", exact: true }).click();
await person.waitForURL(`${built}/`);
expectEqual(
  "account: signed out, the session cookie is gone",
  String((await lobby.cookies()).filter((cookie) => cookie.name.endsWith("session_token")).length),
  "0",
);
await person.goto(`${built}/login?next=%2Fsettings`, { waitUntil: "domcontentloaded" });
await shot(person, "login");
await person.getByRole("button", { name: "Sign in with a passkey" }).click();
await person.getByRole("heading", { name: "Your account" }).waitFor();
expectEqual(
  "account: signed in with the passkey, as the same user",
  squash(await person.locator("header").first().innerText()),
  "Keel ada",
);

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

// Making one. A handle in use is refused, and said.
await person.goto(`${built}/new/org`, { waitUntil: "domcontentloaded" });
await person.getByLabel("Name").fill("Lovelace");
await person.getByLabel("Handle").fill("ada");
await person.getByRole("button", { name: "Make the org" }).click();
await person.getByText("That handle is taken.").waitFor();
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
await grace.getByRole("heading", { name: "There is no lovelace here" }).waitFor();
expectEqual(
  "orgs: removed, the org is to her as one that is not there",
  String(await grace.getByRole("navigation", { name: "Org" }).count()),
  "0",
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
  "Keel / ada / demo private Live ada",
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
await visiting.close();
await second.close();

// Ada answers. Not the option a script would have chosen: what lands must be what was tapped.
await person.locator(".a-option", { hasText: "Never cache permission checks" }).click();
await person
  .getByRole("heading", { name: "Ruled: Never cache permission checks" })
  .waitFor({ timeout: 15_000 });
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
  "/ada/demo/settings | private Only members of ada read it. | Settings",
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
  "public Anyone reads its code and its log, signed in or not. | Keel / ada / demo public Live ada",
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
  "src | package.json | README.md | 6 tabs",
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
  "private Only members of ada read it. | Keel / ada / demo private Live ada | 2",
);
expectEqual(
  "settings: and a visitor is told of it what they are told of a project that is not there",
  await toldAt(passer, "ada", "demo"),
  told.none,
);
await passing.close();

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
await authenticator.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
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
await newcomer.getByRole("heading", { name: "Your account" }).waitFor();
await newcomer.getByRole("list", { name: "Your passkeys" }).getByRole("listitem").first().waitFor();
expectEqual(
  "passkey sign-up: signed up and in, by a handle and a passkey, and no address is shown",
  `${squash(await newcomer.locator("header").first().innerText())} | ${squash(await newcomer.locator("main header").innerText())} | ${await newcomer.getByRole("list", { name: "Your passkeys" }).getByRole("listitem").count()} | ${String((await newcomer.content()).includes("keel.invalid"))}`,
  "Keel turing | Your account turing | 1 | false",
);
await newcomer.goto(`${built}/turing`, { waitUntil: "domcontentloaded" });
await newcomer.getByRole("heading", { level: 1 }).first().waitFor();
expectEqual(
  "passkey sign-up: their own account is there under the handle, with no project yet, and is not called an org",
  squash(await newcomer.getByRole("main").innerText()),
  "Your projects turing You have no project yet.",
);
await newcomer.goto(`${built}/settings`, { waitUntil: "domcontentloaded" });
await newcomer.getByRole("button", { name: "Sign out", exact: true }).click();
await newcomer.waitForURL(`${built}/`);
await newcomer.goto(`${built}/login?next=%2Fsettings`, { waitUntil: "domcontentloaded" });
await newcomer.getByRole("button", { name: "Sign in with a passkey" }).click();
await newcomer.getByRole("heading", { name: "Your account" }).waitFor();
expectEqual(
  "passkey sign-up: signed back in with the same passkey",
  squash(await newcomer.locator("header").first().innerText()),
  "Keel turing",
);
expectEqual(
  "passkey sign-up: the page sent Keel no Authorization",
  String(sentAtTheDoor.filter((request) => request.authorization !== undefined).length),
  "0",
);
await door.close();

// Whoever set a Keel up makes its first account at /signup?claim, with the code they were given. The code is typed,
// and rides on the two passkey calls and on nothing else. Once the sign-up has ended the page holds it nowhere.
const CLAIM = "a-claim-code-for-this-run-only";
const founding = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const sentClaiming: Sent[] = [];
await asDeployed(founding, { keel: open, identity: passkeysAlone, sent: sentClaiming });
const founder = watch(await founding.newPage(), "account, the claim");
const foundersKey = await founding.newCDPSession(founder);
await foundersKey.send("WebAuthn.enable");
await foundersKey.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
const withTheCode = (): string =>
  sentClaiming
    .filter((request) => request.claim !== undefined)
    .map(
      (request) =>
        `${request.path.replace("/v1/auth/passkey/", "")}${request.claim === CLAIM ? "" : " with another code"}`,
    )
    .join(" ");
await founder.goto(`${built}/signup`, { waitUntil: "domcontentloaded" });
await founder.getByLabel("Handle").waitFor();
expectEqual(
  "claim: a sign-up page nobody asked a claim of has no field for one",
  String(await founder.getByLabel("Claim code").count()),
  "0",
);
await founder.goto(`${built}/signup?claim`, { waitUntil: "domcontentloaded" });
await founder.getByLabel("Claim code").waitFor();
await founder.getByLabel("Handle").fill("lamarr");
expectEqual(
  "claim: with no code typed, there is no account to make",
  String(
    await founder.getByRole("button", { name: "Create your account with a passkey" }).isDisabled(),
  ),
  "true",
);
await founder.getByLabel("Claim code").fill(CLAIM);
await shot(founder, "signup-claim");
await founder.getByRole("button", { name: "Create your account with a passkey" }).click();
// Signed up or not, the page ends somewhere with a heading: the checks below say which.
await founder.waitForURL(`${built}/`, { timeout: 10_000 }).catch(() => undefined);
expectEqual(
  "claim: the code rode on both passkey calls, and on nothing else",
  withTheCode(),
  "generate-register-options verify-registration",
);
await founder.goto(`${built}/settings`, { waitUntil: "domcontentloaded" });
await founder.getByRole("heading", { name: "Your account" }).waitFor();
await founder.getByRole("list", { name: "Your passkeys" }).getByRole("listitem").first().waitFor();
expectEqual(
  "claim: the account is made, and once it is nothing more carries the code",
  `${squash(await founder.locator("main header").innerText())} | ${withTheCode()}`,
  "Your account lamarr | generate-register-options verify-registration",
);
expectEqual(
  "claim: and the page keeps it in no storage and no address",
  String(
    await founder.evaluate(
      (code) =>
        JSON.stringify([
          Object.entries(window.localStorage),
          Object.entries(window.sessionStorage),
          document.cookie,
          window.location.href,
          window.history.state,
        ]).includes(code),
      CLAIM,
    ),
  ),
  "false",
);
await founding.close();

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

await browser.close();
await new Promise<void>((resolve) => {
  served.httpServer.close(() => resolve());
});
if (errors.length > 0) console.log(`console errors:\n  ${errors.join("\n  ")}`);
const failed = failures.length > 0 || errors.length > 0;
if (!failed) console.log("\nAll checks passed.");
// Long-polls the stand-in is still holding would keep this process alive for their full wait.
process.exit(failed ? 1 : 0);
