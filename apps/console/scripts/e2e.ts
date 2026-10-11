// Drives the real page in a real browser.
//
// Two servers are under test. The dev server (`pnpm dev`, port 5311) serves the
// scripted fixtures, and the pages are checked against those. The built console
// is then built and served here (port 5312) and checked the way it is deployed:
// reading Keel through the console's Worker. The Worker's own code runs in this
// process and answers the page's requests; behind it stands a stand-in for Keel.
//
//   node scripts/e2e.ts
import { type BrowserContext, type Page, chromium } from "playwright";
import { build, preview } from "vite";
import { createFakeKeel } from "../test/fixtures/mock/fakeKeel.ts";
import { type Env, createConsole } from "../src/worker/handler.ts";

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
  `${dev}/demo${place}${place.includes("?") ? "&" : "?"}${fixture}`;
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
expectEqual("a fixture offers no phone link", String(await qrOn(page).count()), "0");

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
  "/demo /demo/changes /demo/conflicts /demo/escalations /demo/mission-control /demo/insights",
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
expectEqual("escalations: listed at their own address", pathOf(page), "/demo/escalations");
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
expectEqual("escalation: named in its address", pathOf(page), "/demo/escalations/E-1");
await page.goBack();
await page.getByRole("list", { name: "Escalations, newest first" }).waitFor();
expectEqual("Back returns to the list it was opened from", pathOf(page), "/demo/escalations");
await page.goBack();
await page.getByText("Holding: a person is being asked").waitFor();
expectEqual("Back again returns to the page before that", pathOf(page), "/demo/mission-control");
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

// The conflict is settled, and is found where settled conflicts are listed. Its matrix has gone green where it was red.
await tabs.filter({ hasText: "Conflicts" }).click();
await page.getByRole("heading", { name: "No conflict is open" }).waitFor();
await page
  .getByRole("navigation", { name: "Conflicts, by state" })
  .getByRole("link", { name: /Settled/ })
  .click();
expectEqual(
  "conflicts: a filter is part of the address",
  `${pathOf(page)}?state=${new URL(page.url()).searchParams.get("state") ?? ""}`,
  "/demo/conflicts?state=settled",
);
await page.locator(".a-list-title a").first().click();
await page.getByRole("heading", { name: "World matrix" }).waitFor();
expectEqual("conflict: named in its address", pathOf(page), "/demo/conflicts/C-1");
expectEqual(
  "conflict: called by what the two sides hold, and by Keel's label",
  squash(await page.getByRole("heading", { level: 1 }).innerText()),
  "#2 relies on freshness at most per-request. #1 makes it per-session. C-1",
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
// The control row's fails stay: the probe is meant to fail there, and they are not drawn as critical.
expectEqual(
  "critical cells left in the matrix",
  String(await page.locator('.a-matrix [data-outcome="fail"]:not([data-control="true"])').count()),
  "0",
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
    .filter((path) => path.startsWith("/demo/changes/"))
    .join(" "),
  "/demo/changes/2 /demo/changes/1",
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
expectEqual("change: its files have an address", pathOf(page), "/demo/changes/1/files");
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
  "/demo/changes?state=landed",
);

// The code: the project's files with its README beneath, a file with the reasons beside its lines, and trunk's history.
await page.goto(at("", "scenario=s1&t=700&play=0"), { waitUntil: "networkidle" });
await page.locator(".a-prose h2").first().waitFor();
expectEqual(
  "code: the clone command",
  squash(await page.locator(".a-clone code").innerText()),
  "git clone https://keel.town/demo.git",
);
expectEqual(
  "code: the root, directories first",
  (await page.locator(".a-tree li").allInnerTexts()).map(squash).join(" | "),
  "src | package.json 215 B | README.md 507 B",
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
  "/demo/blob/trunk/src/authz/cache.ts",
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
  "/demo/blob/trunk/src/authz/cache.ts",
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
  "/demo/blob/trunk/src/authz/check.ts",
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
expectEqual("code: Back returns to the directory", pathOf(page), "/demo/tree/trunk/src/authz");
await page.goForward();
await page.locator("[data-why] a", { hasText: "#2" }).click();
await page.getByRole("heading", { level: 1, name: /Owners can revoke collaborators/ }).waitFor();
expectEqual(
  "code: the change that holds a premise opens its page",
  pathOf(page),
  "/demo/changes/2",
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
  "/demo/blob/trunk/src/authz/cache.ts",
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
  String(/^\/demo\/commit\/[0-9a-f]+$/.test(pathOf(page))),
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
await page
  .getByRole("heading", { name: "Keel does not serve this project's repository yet" })
  .waitFor();
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
expectEqual("missing: the way back is the project's code", pathOf(page), "/demo");
// The bare address is the instance's own: it lists the projects Keel's log has named, each a link to its own address.
await page.goto(`${dev}/?scenario=s1&t=700&play=0`, { waitUntil: "networkidle" });
await page.getByRole("heading", { level: 1, name: "Projects" }).waitFor();
const listed = page.getByRole("list", { name: "Projects" }).getByRole("link");
expectEqual(
  "the bare address lists the projects",
  (await listed.allInnerTexts()).join(" "),
  "demo",
);
expectEqual("the bare address has no project's tabs", String(await tabs.count()), "0");
await listed.filter({ hasText: "demo" }).click();
await page.locator(".a-prose h2").first().waitFor();
expectEqual(
  "a project in the list opens at its own address, still on the fixture",
  `${pathOf(page)} ${new URL(page.url()).searchParams.get("scenario")}`,
  "/demo s1",
);
// And Back returns to the list, which has folded nothing of the project's since.
await page.goBack();
await page.getByRole("heading", { level: 1, name: "Projects" }).waitFor();
expectEqual("Back from a project is the list of them", pathOf(page), "/");

// With nothing asked for, the page reads Keel, even in development. There is none behind the dev server, and it says so.
await page.goto(`${dev}/`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "The console could not reach Keel" }).waitFor();
expectEqual(
  "dev, with no fixture asked for: none is shown",
  String(await page.locator(".a-root").count()),
  "0",
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
expectEqual("subject: named in the address", pathOf(page), "/demo/subjects/storage.gc.safety");
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
  "/demo/conflicts/C-7",
);
await page.goBack();
await panel.waitFor();
expectEqual(
  "subject: Back returns to it, open as it was",
  pathOf(page),
  "/demo/subjects/storage.gc.safety",
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
expectEqual("graph: a change opens its page", pathOf(page), "/demo/changes/496");
await page.goto(graph, { waitUntil: "networkidle" });
await page.locator('.a-fn[data-kind="conflict"]', { hasText: "C-13" }).click();
await page.getByRole("heading", { name: "World matrix" }).waitFor();
expectEqual("graph: a conflict opens its page", pathOf(page), "/demo/conflicts/C-13");

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
expectEqual("funnel: at its own address", pathOf(page), "/demo/insights/funnel");
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

// On a phone the console is the question and nothing else, whatever address it was opened at.
const pocket = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const narrow = watch(await pocket.newPage(), "fixture, narrow");
await narrow.goto(at("/mission-control", "scenario=s1&t=472&ruling=live"), {
  waitUntil: "networkidle",
});
await narrow
  .getByRole("heading", { name: "May permission checks be cached within a session?" })
  .waitFor();
expectEqual("narrow: no console chrome", String(await tabsOf(narrow).count()), "0");
expectEqual(
  "narrow: options to tap",
  String(await narrow.locator(".a-option:enabled").count()),
  "3",
);
await pocket.close();

// ─────────────────────────────────────────────────────────────────────────────
// The built console, as it is deployed: reading Keel through its Worker
// ─────────────────────────────────────────────────────────────────────────────
await build({ logLevel: "silent" });
const served = await preview({
  preview: { port: BUILT_PORT, strictPort: true },
  logLevel: "silent",
});

const PRESENTER = "the presenter's key, for this run only";
const keel = createFakeKeel({
  clients: [
    { id: "console-observer", secret: "observer-secret", scopes: ["observer"] },
    { id: "console-operator", secret: "operator-secret", scopes: ["operator"] },
  ],
});
const mission = createConsole();
const env: Env = {
  KEEL: keel,
  KEEL_API_HOST: "keel.example",
  ASSETS: {
    fetch: () =>
      Promise.resolve(
        new Response("not used: the preview server serves the page", { status: 404 }),
      ),
  },
  KEEL_OBSERVER_CLIENT_ID: "console-observer",
  KEEL_OBSERVER_CLIENT_SECRET: "observer-secret",
  KEEL_OPERATOR_CLIENT_ID: "console-operator",
  KEEL_OPERATOR_CLIENT_SECRET: "operator-secret",
  CONSOLE_CAPABILITY_KEY: "a signing key, for this run only",
  CONSOLE_PRESENTER_KEY: PRESENTER,
};

/**
 * Everything the deployed Worker would answer is answered by the Worker's own code, here. `shown` gathers the
 * `authorization` each of the page's reads carried: nothing for a visitor, the presenter's key for the presenter.
 */
async function behindTheWorker(context: BrowserContext, shown: string[] = []): Promise<void> {
  // As deployed, an address that is not one of the build's files gets the page: the Worker's assets are set to answer
  // so. The preview server does that only where the address has no dot in it, so the same is done for it here.
  await context.route(
    (url) =>
      url.origin === built &&
      url.pathname !== "/" &&
      !/^\/(api|present|rule|assets)\//.test(url.pathname),
    async (route) => {
      if (!route.request().isNavigationRequest()) return route.fallback();
      const index = await route.fetch({ url: `${built}/index.html` });
      return route.fulfill({ response: index });
    },
  );
  await context.route(new RegExp(`^${built}/(api|present|rule)/`), async (route) => {
    const request = route.request();
    const headers = Object.fromEntries(
      Object.entries(request.headers()).filter(
        ([name]) => name !== "content-length" && name !== "host",
      ),
    );
    const posted = request.postData();
    if (new URL(request.url()).pathname.startsWith("/api/"))
      shown.push(headers["authorization"] ?? "");
    const response = await mission.fetch(
      new Request(request.url(), {
        method: request.method(),
        headers,
        ...(posted === null ? {} : { body: posted }),
      }),
      env,
    );
    // A page that has gone away no longer wants its answer.
    await route
      .fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      })
      .catch(() => undefined);
  });
}

const NOT_SHOWN = "This page is not shown to visitors yet";
const NO_REPOSITORY = "Keel does not serve this project's repository yet";
const OPEN_ON_TABS =
  "Code | Changes 2 open | Conflicts 1 open | Escalations 1 waiting for a person | Mission Control | Insights";

// ── A visitor: opened by anyone, with no key ──
// Keel reads its log to an observer, and the Worker asks Keel for a visitor with no token. So a visitor has the
// project's frame and what Keel reads to anyone, and every page that is read from the log says that it is.
const street = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const visitorShowed: string[] = [];
await behindTheWorker(street, visitorShowed);
const visitor = watch(await street.newPage(), "built, a visitor");
await visitor.goto(`${built}/`, { waitUntil: "domcontentloaded" });
await visitor
  .getByRole("heading", { name: "Keel's projects are not listed to visitors yet" })
  .waitFor();
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
// Keel's contract has no way to read a repository yet. The built console says so, and shows nothing in its place.
await visitor.goto(`${built}/demo`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { name: NO_REPOSITORY }).waitFor();
expectEqual(
  "visitor: no repository is made up",
  String(await visitor.locator(".a-tree, .a-clone, .a-prose").count()),
  "0",
);
expectEqual(
  "visitor: the project's frame, with nothing counted on it",
  (await tabsOf(visitor).allInnerTexts()).map(squash).join(" | "),
  "Code | Changes | Conflicts | Escalations | Mission Control | Insights",
);
for (const place of ["/mission-control", "/changes", "/escalations/E-1", "/insights/funnel"]) {
  await visitor.goto(`${built}/demo${place}`, { waitUntil: "domcontentloaded" });
  await visitor.getByRole("heading", { name: NOT_SHOWN }).waitFor();
  expectEqual(`visitor: ${place} says it is read from the log`, pathOf(visitor), `/demo${place}`);
}
// Asking the built console for a fixture gets Keel, not the fixture. And no link in it carries the asking further.
await visitor.goto(`${built}/demo/insights/benchmark?scenario=swarm&t=100`, {
  waitUntil: "domcontentloaded",
});
await visitor.getByRole("heading", { name: NOT_SHOWN }).waitFor();
expectEqual(
  "visitor: ?scenario= is not a way in to a fixture",
  String(await visitor.getByText("Test fixture").count()),
  "0",
);
expectEqual(
  "visitor: no link carries a fixture's parameters",
  String(await visitor.locator('a[href*="scenario"], a[href*="t="]').count()),
  "0",
);
// An address with a dot in it opens from nowhere, as it does where the console is deployed.
await visitor.goto(`${built}/demo/subjects/authz.permission-evaluation`, {
  waitUntil: "domcontentloaded",
});
await visitor.getByRole("heading", { name: NOT_SHOWN }).waitFor();
await visitor.goto(`${built}/demo/nowhere`, { waitUntil: "domcontentloaded" });
await visitor.getByRole("heading", { name: "There is nothing at this address" }).waitFor();
expectEqual(
  "visitor: the page showed the Worker no credential",
  [...new Set(visitorShowed)].join(","),
  "",
);
expectEqual(
  "visitor: Keel was asked with no token, and for none",
  [
    ...new Set(
      keel.calls.map(
        (call) => `${call.path} ${call.authorization === "" ? "no token" : "a token"}`,
      ),
    ),
  ]
    .toSorted()
    .join(" | "),
  "/v1/events no token | /v1/lattices no token",
);
const askedForVisitor = keel.calls.length;

// ── The presenter: opened with the key in the address's fragment ──
const desk = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const presenterShowed: string[] = [];
await behindTheWorker(desk, presenterShowed);
const presenter = watch(await desk.newPage(), "built, presenter");
const QUESTION_ASKED = /May permission checks be cached within a session\?/;
await presenter.goto(`${built}/#presenter=${encodeURIComponent(PRESENTER)}`, {
  waitUntil: "domcontentloaded",
});
// The bare address is the instance's: the projects Keel's log names, each with who may read it.
await presenter.getByRole("heading", { level: 1, name: "Projects" }).waitFor();
expectEqual("presenter: the key is taken out of the address", new URL(presenter.url()).hash, "");
expectEqual(
  "presenter: the projects, and who may read each",
  squash(await presenter.getByRole("list", { name: "Projects" }).innerText()),
  "demo private",
);
await presenter.getByRole("list", { name: "Projects" }).getByRole("link", { name: "demo" }).click();
await presenter.getByRole("heading", { name: NO_REPOSITORY }).waitFor();
expectEqual("presenter: a project opens at its own address", pathOf(presenter), "/demo");
expectEqual(
  "presenter: live, and says so",
  String(await presenter.getByText("Live", { exact: true }).count()),
  "1",
);
expectEqual(
  "presenter: nothing calls itself a fixture",
  String(await presenter.getByText("Test fixture").count()),
  "0",
);
expectEqual(
  "presenter: what is open, counted on the tabs",
  (await tabsOf(presenter).allInnerTexts()).map(squash).join(" | "),
  OPEN_ON_TABS,
);

// Playback is for a fixture's log. The built console has none, and no way to move about in Keel's.
await presenter.goto(`${built}/demo/mission-control`, { waitUntil: "domcontentloaded" });
await presenter.locator("dl.a-trunk-line").waitFor();
expectEqual(
  "presenter: people asked / landed",
  await statOn(presenter, "People asked / changes landed"),
  "1/0",
);
// The control is loaded apart from the page, a moment after it. So it is waited for, and must not come.
expectEqual(
  "built: no playback",
  await presenter
    .getByLabel("Position in the log")
    .waitFor({ timeout: 3_000 })
    .then(
      () => "shown",
      () => "none",
    ),
  "none",
);

// Asking the built console for a fixture gets Keel, not the fixture. And no link in it carries the asking further.
await presenter.goto(`${built}/demo/insights/benchmark?scenario=swarm&t=100`, {
  waitUntil: "domcontentloaded",
});
await presenter.getByRole("heading", { name: "No sealed run here" }).waitFor();
expectEqual(
  "presenter: ?scenario= is not a way in to a fixture",
  (await tabsOf(presenter).allInnerTexts()).map(squash).join(" | "),
  OPEN_ON_TABS,
);
expectEqual(
  "presenter: no link carries a fixture's parameters",
  String(await presenter.locator('a[href*="scenario"], a[href*="t="]').count()),
  "0",
);

// Keel sends no funnel counters yet: those stages are left empty, and probes and questions are counted from events.
await presenter.goto(`${built}/demo/insights/funnel`, { waitUntil: "domcontentloaded" });
await presenter.getByRole("heading", { name: "Review funnel" }).waitFor();
expectEqual(
  "built: stages with no count are left empty",
  String(await presenter.getByText("not counted yet").count()),
  "4",
);
expectEqual("built: subject index", await stageOn(presenter, 0), "— | — not counted yet | — | —");
expectEqual(
  "built: probe, counted from events",
  await stageOn(presenter, 4),
  "1 | 0 0% 1 passed on | 1 | $0.0021",
);
expectEqual(
  "built: a person, being asked",
  await stageOn(presenter, 5),
  "1 | 0 0% 1 waiting for a person 1 waiting for a person Open the escalations |  | a person's time",
);

// The conflict's line is drawn from the lattices the Worker read from Keel, and a verdict's evidence from Keel's view of it.
await presenter.goto(`${built}/demo/conflicts/C-1`, { waitUntil: "domcontentloaded" });
await presenter.getByRole("heading", { name: "World matrix" }).waitFor();
await presenter.locator("[data-lattice-value]").first().waitFor({ timeout: 10_000 });
expectEqual(
  "built: the lattice's line, read from Keel",
  (await presenter.locator("[data-lattice-value]").allInnerTexts()).join(" < "),
  "per-call < per-request < per-session < static",
);
await presenter.goto(`${built}/demo/changes/1/verification`, { waitUntil: "domcontentloaded" });
await presenter
  .getByText("Probe P-1 fails in A+B, three runs out of three")
  .first()
  .waitFor({ timeout: 10_000 });
expectEqual(
  "built: a verdict's evidence, read from Keel",
  String(
    keel.calls.some(
      (call) => call.path.startsWith("/v1/verdicts/") && call.authorization.endsWith("_observer"),
    ),
  ),
  "true",
);
expectEqual(
  "built: the lattices, read from Keel",
  String(
    keel.calls.some(
      (call) => call.path === "/v1/lattices" && call.authorization.endsWith("_observer"),
    ),
  ),
  "true",
);

// Keel's contract has no way to read a change's diff either. Its page says so, and counts no files.
await presenter.goto(`${built}/demo/changes/1/files`, { waitUntil: "domcontentloaded" });
await presenter.getByText("Keel does not serve this change's diff").waitFor({ timeout: 10_000 });
expectEqual(
  "built: a diff Keel does not serve is not counted as no files",
  squash(
    await presenter
      .getByRole("navigation", { name: "Change" })
      .getByRole("link", { name: /Files changed/ })
      .innerText(),
  ),
  "Files changed",
);

// An address with a dot in it opens from nowhere, as it does where the console is deployed.
await presenter.goto(`${built}/demo/subjects/authz.permission-evaluation`, {
  waitUntil: "domcontentloaded",
});
await presenter
  .getByRole("complementary", { name: "Subject authz.permission-evaluation" })
  .waitFor();
expectEqual(
  "built: a subject, opened cold",
  pathOf(presenter),
  "/demo/subjects/authz.permission-evaluation",
);
await presenter.goto(`${built}/demo/nowhere`, { waitUntil: "domcontentloaded" });
await presenter.getByRole("heading", { name: "There is nothing at this address" }).waitFor();
// An observer's log names every project, so a name it does not have is no project's, and the way on is the list.
await presenter.goto(`${built}/keel/changes`, { waitUntil: "domcontentloaded" });
await presenter.getByRole("heading", { name: "There is no project called keel here" }).waitFor();
expectEqual(
  "built: a project Keel does not have leads to the ones it has",
  await presenter
    .getByRole("main")
    .getByRole("link", { name: "See the projects Keel has" })
    .evaluate((link) => (link instanceof HTMLAnchorElement ? new URL(link.href).pathname : "")),
  "/",
);

expectEqual(
  "built: Keel is asked only for what its contract has",
  [
    ...new Set(
      keel.calls.map((call) => call.path.replace(/\/v1\/verdicts\/.+/, "/v1/verdicts/{id}")),
    ),
  ]
    .toSorted()
    .join(" "),
  "/v1/events /v1/lattices /v1/oauth/token /v1/verdicts/{id}",
);
// The presenter's page showed its key on every read, and the Worker read Keel as the observer for each: never
// with the key itself, and never as anything more.
expectEqual(
  "presenter: every read showed the key",
  [...new Set(presenterShowed)].join(","),
  `Bearer ${PRESENTER}`,
);
expectEqual(
  "presenter: every read went out as the observer",
  String(
    keel.calls
      .slice(askedForVisitor)
      .filter((call) => call.method === "GET")
      .every((call) => call.authorization.endsWith("_observer")),
  ),
  "true",
);

// The question, with the presenter's key: its options can be tapped, and a QR code is beside it.
await presenter.goto(`${built}/demo/escalations/E-1`, { waitUntil: "domcontentloaded" });
await presenter.getByRole("heading", { level: 1, name: QUESTION_ASKED }).waitFor();
// What Keel says on the entry and in the payload reaches the page through the Worker: the changes' numbers, and the default.
expectEqual(
  "built: the parked changes, by Keel's numbers",
  String(await presenter.getByText("parked on this: #1 and #2").count()),
  "1",
);
expectEqual(
  "built: the default is said",
  String(await presenter.getByText("Both changes wait. Nothing lands on this subject.").count()),
  "1",
);
const phoneLink = presenter.getByRole("link", { name: "Open the phone view" });
await phoneLink.waitFor();
const phoneUrl = (await phoneLink.getAttribute("href")) ?? "";
expectEqual(
  "presenter: a QR code is offered with the question",
  String(await qrOn(presenter).count()),
  "1",
);
expectEqual(
  "presenter: the link names the project, and carries a capability and no key",
  String(/^http:\/\/localhost:5312\/demo\?rule=[\w-]+\.[\w-]+$/.test(phoneUrl)),
  "true",
);
expectEqual(
  "presenter: options can be tapped",
  String(await presenter.locator(".a-option:enabled").count()),
  "3",
);

// A phone opens what the QR code encodes. It holds a capability to answer one question, and no key to read with:
// Keel reads a question only to an observer today, so the phone says that it cannot show the question, and
// does not say that nothing is waiting.
const hand = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
await behindTheWorker(hand);
const handset = watch(await hand.newPage(), "built, phone");
await handset.goto(phoneUrl, { waitUntil: "domcontentloaded" });
await handset.getByRole("heading", { name: "This phone cannot show the question yet" }).waitFor();
expectEqual(
  "phone: nothing of the console around it, and nothing to tap",
  `${await tabsOf(handset).count()} tabs, ${await handset.locator(".a-option").count()} options`,
  "0 tabs, 0 options",
);
expectEqual(
  "phone: it does not say that nothing is waiting",
  String(await handset.getByText("Nothing is waiting for a person").count()),
  "0",
);

// The presenter answers on the console. Not the option a script would have chosen: what lands must be what was tapped.
await presenter.locator(".a-option", { hasText: "Never cache permission checks" }).click();
await presenter
  .getByRole("heading", { name: "Ruled: Never cache permission checks" })
  .waitFor({ timeout: 15_000 });
expectEqual(
  "Keel: one ruling, the presenter's",
  keel
    .events()
    .flatMap((event) => (event.type === "RulingGiven" ? [event.payload.option] : []))
    .join(","),
  "no-cache",
);
const rulings = keel.calls.filter((call) => call.path.endsWith("/ruling"));
expectEqual(
  "Keel: ruled as an operator, with the capability's nonce as the idempotency key",
  String(
    rulings.length === 1 &&
      (rulings[0]?.authorization ?? "").endsWith("_operator") &&
      /^console:[0-9a-f]{24}$/.test(rulings[0]?.idempotencyKey ?? ""),
  ),
  "true",
);

// The capability a phone was given is good for that question once. The question is answered: it rules nothing more.
const again = await handset.evaluate(async (link) => {
  const capability = new URL(link).searchParams.get("rule") ?? "";
  const response = await fetch(`/rule/${capability}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"option":"invalidate"}',
  });
  return response.status;
}, phoneUrl);
expectEqual("phone: a question already answered is not answered again", String(again), "409");

// A capability the Worker did not sign is refused by the Worker, whoever sends it.
const forgedCapability = "eyJlIjoiZXNjXzEiLCJ4Ijo5OTk5OTk5OTk5LCJuIjoiYSJ9.c2lnbmVkLWJ5LW5vLW9uZQ";
const forged = await handset.evaluate(
  async (capability) =>
    (
      await fetch(`/rule/${capability}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"option":"invalidate"}',
      })
    ).status,
  forgedCapability,
);
expectEqual("forged capability: refused by the Worker", String(forged), "403");
expectEqual(
  "Keel: still one ruling",
  String(keel.events().filter((event) => event.type === "RulingGiven").length),
  "1",
);

await browser.close();
await new Promise<void>((resolve) => {
  served.httpServer.close(() => resolve());
});
if (errors.length > 0) console.log(`console errors:\n  ${errors.join("\n  ")}`);
const failed = failures.length > 0 || errors.length > 0;
if (!failed) console.log("\nAll checks passed.");
// Long-polls the stand-in is still holding would keep this process alive for their full wait.
process.exit(failed ? 1 : 0);
