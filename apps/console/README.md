# The Keel console

How a person sees Keel: the projects an instance holds, and for each project its code, its changes, the conflicts between them, the few questions that need a person, and Mission Control, the live graph of a swarm of agents changing one codebase. All of it is read from Keel.

A Keel holds namespaces and a namespace holds projects, so a project's address is `/<namespace>/<project>`, as a repository's is on a code host. A namespace is a person's, an agent's or an org's (`kind`), and its handle is the first segment. The bare address is the home: the projects Keel names to whoever is reading. A project is the frame: Code, Changes, Conflicts, Escalations, Mission Control and Insights are its tabs, with Settings beside them for whoever may change them, every thing in it has a page and an address of its own, and each kind of thing is listed one way and shown one way.

It reads Keel and nothing else. There is no replay in it and no recorded stand-in: what the console shows is what Keel says, and where Keel does not say something yet the console leaves that place empty and says so.

It is a Vite single-page app (React, Tailwind, Cloudflare's Kumo components, React Flow for Mission Control and for Verification Plans, `@pierre/diffs` for code) and a small Worker, `keel-console`, that serves the built page and does nothing else.

## Who may read what

| Who | Reads | Can |
|---|---|---|
| A visitor, with no session | The projects an org has made public. The home lists them, and each one's code and the public part of its log are theirs to read: its changes, conflicts, probes, verdicts, decisions and trunk | Nothing but read |
| Someone signed in | That, and all of the projects of the orgs they are a member of: the questions put to a person and their rulings, the agents' names and sessions, the settings | Answer a question Keel has put to them, or one of a project whose org they maintain |
| An owner or a maintainer of a project's org | The same, and the project's settings | Make the project public, or private again |

**The console holds no credential, and has no way to Keel of its own.** The page reads `/v1` on its own origin and puts nothing on a request. Who is reading is the session cookie Keel's own sign-in set (`__Secure-keel.session_token`), which the browser sends and the page cannot read. The Worker has no secret and no binding to Keel: it answers `/healthz` and serves the page. Keel decides every read and every ruling.

**Keel reads part of a project's log to its members alone**: the questions put to a person and their rulings, an agent's enrolment, standing and sessions, and the project's settings. Anyone else, signed in or not, is read the rest. So for that reader the console has no question and no agent's name, and cannot tell whether there is none or it was not shown. It says which (`src/engine/audience.ts`): the Escalations pages say that Keel shows a project's questions to its members, never that nothing is waiting; people asked is not counted, in trunk's numbers or in the funnel; a conflict that waits on a ruling says so, since that much is the conflict's own and public, and that the question is the members'; and a change's agent is shown as an agent with no name and no class, never as a kind nobody said it was.

A project Keel does not show a reader is the same answer whether it is private or not there at all, and the page says the same of both: "There is no project `<namespace>/<project>` here".

A question is answered with Keel's own operation (`Operator_giveRuling`), as whoever is signed in. Keel takes an answer from the person the question was put to first, and from an owner or a maintainer of the project's namespace. So its options can be tapped by an owner or a maintainer (`viewer.role`), and by anyone Keel lists the question to (`GET /v1/escalations`, asked when the question's page is opened by a plain member); any other member reads the question and is told who answers it. A refusal is shown in Keel's words, with the ways forward it gave: an option the question does not offer, a question someone else has answered since, one that is not there. Beside an open question is a QR code of the question's own address and nothing more: no key and no capability. Whoever opens it on a phone signs in, and Keel decides whether they may answer.

A project's settings are Keel's (`Operator_getSettings`, `Operator_putSettings`), at `/<namespace>/<project>/settings`. The frame offers a Settings tab where Keel named the reader an owner or a maintainer of the project's namespace. The page shows who may read the project (an org's members, or the person or agent whose namespace it is) and the rest of what Keel holds for it, and changes one thing: making it public waits for the project's name to be typed, since anyone then reads its code and its log, and making it private again is one click. Keel replaces a project's settings whole, and reads a setting left out as its default (verification required, the project private), so the page sends back everything Keel answered with that one field changed. What Keel answers is what the page and the frame then say. Anyone else who opens the address is shown Keel's refusal in its words.

## The questions waiting for you

For someone signed in the home begins with **Waiting for you**: the open questions Keel lists to them across every project (`GET /v1/escalations?state=open`), in Keel's order, each by Keel's label (`E-n`) under its project, and a link to the question's own page, where it is answered. Keel decides whose a question is: the person its agent names, at once, and the maintainers of the project's namespace after thirty minutes, or at once where nobody is named. Where Keel lists none the home says so in a line. A visitor has no such list, and Keel is not asked for one.

**The list is never read by the clock.** The home holds one waiting read on the reader's own feed (`GET /v1/events` with no project named, which Keel reads a person across every project it may), and reads the list again when an entry arrives that puts a question or closes one (`EscalationRaised`, `EscalationWithdrawn`, `RulingGiven`, `ConflictResolved`), and when the tab comes back into view (`src/engine/waiting.ts`). So a phone left open on the home shows a question when Keel raises it. The feed is first read to its end, a request for every 500 entries of the instance, since a cursor can only be had by reading up to it; Keel's `cursor=end` will make that one request.

## Accounts

Keel's users sign up and sign in through Better Auth, which Keel mounts at `/v1/auth` on the console's own origin. The pages above every project speak to it directly, and the console's Worker has no part in it.

| Address | What it is |
|---|---|
| `/signup`, `/login` | A passkey, always: a new person signs up with a handle and a passkey made on their own device, and is asked for no address. A code sent by email and GitHub are shown only where this Keel offers them; someone who signs up by one of those chooses their handle next. The handle is their name on this Keel, and their own projects live under it. Signing up says nothing of an org: a person needs none |
| `/settings` | The user's passkeys, the agents they stand behind, and signing out here or everywhere else. Where Keel refuses a change to the passkeys for want of a fresh sign-in, the page offers the way to one that this person has: a touch of a passkey, which asks again what was refused, or with no passkey signing in again the way they came. "Agents you stand behind" is Keel's list of the agents the reader sponsors (`Agents_listSponsored`), each with what a sponsor may ask of it: pause, unpause, end |
| `/device` | Approving a terminal that is running `keeltown login`, by the code it shows |
| `/<handle>` | To the person whose handle it is: "Your projects", their own account. Keel keeps a person's namespace as an org named by the handle, and the console never presents it as one: no role, no members, no settings, and `/orgs/<own handle>/…` says it is their own account. To anyone else a handle's page lists the projects Keel names to them, and calls it neither a person nor an org until Keel says which |
| `/<handle>` | A namespace's own page, worded from what Keel says the handle is (`Namespaces_getNamespace`, which anyone may ask). To its owner a person's is "Your projects". To a member an org's is its home: its projects and its people. To anyone else it is the handle, "Agent" or "Org" beside it where it is one, and the projects of it Keel names to them; one with none to show is still there and says so, and a handle nobody has is "There is no `<handle>` here". `/orgs/<org>` is put right to it |
| `/new/org` | Making an org: a name, and a handle that is then fixed |
| `/orgs/<org>/members` | Members, by handle and role. Inviting by handle or by email, with a link to pass on. Changing a role, removing a member, leaving |
| `/orgs/<org>/settings` | Renaming, and deleting once the org's handle is typed |
| `/invite/<id>` | An invitation, read only to the person it was made to, to join or to decline. Once it was answered or has lapsed, the page tells that person so, in Keel's words |
| `/sponsor#agent=<agentId>&code=<code>` | Where an agent sends the person it asks to stand behind it. The page names the agent as Keel shows it to anyone (`Agents_getAgent`), with its kind as the agent declared it, and says what standing behind it is. Opening it approves nothing. One button: a passkey touch, which signs a visitor in as it signs anyone in afresh, then the approval (`Agents_approveSponsor`). The code is read from the fragment, taken out of the address at once, held in memory alone and sent only in that call's body. What Keel refuses is said in its words with the way forward it gave, and after a yes the page links to the settings, where the agent is listed |
| `/terms`, `/privacy` | The Terms of Service and the Privacy Notice, for anyone to read. The text is `docs/legal/terms.md` and `docs/legal/privacy.md`, built into the page, so these two pages ask Keel nothing. A foot on every page links both, and the sign-up page says that creating an account agrees to them |

- **The session is an HttpOnly cookie**, which the page cannot read. Better Auth's answers also carry the session's token in their body, so one module (`src/account/account.ts`) is the only code that sees an answer, and it hands on nothing but the user's id, email, name and handle.
- **The page puts no credential on a request.** A visitor's request carries none.
- **The address names the org.** Every call names the org it is about. Better Auth also keeps an "active organisation" for a session, and the console neither reads it nor sets it.
- **No page shows another person's address.** A member is shown by handle and name, and an invitation made by handle is told by the handle. Better Auth's answers carry every member's address, so `account.ts` hands on none but one a member typed into an invitation.
- **Roles are Keel's three**: owner, maintainer and member (`src/account/roles.ts`). A maintainer does everything but delete the org and make or unmake an owner. Keel decides; a page only keeps from offering what Keel would refuse.
- **The frame is a code host's**: `Keel / <namespace> / <project>`, where each name is a link and has a dropdown beside it to the others of its kind (`src/views/Switch.tsx`): "Switch account" lists the reader's own handle first, marked as theirs, then the orgs they made or joined (`src/account/accounts.ts`), and "Switch project" the owner's projects. A visitor has a way to sign in there that comes back to the page they were on. It is offered once Keel has listed those orgs, and not before.
- **An org that is not the reader's is told as one that is not there**, and so is an invitation made to someone else, whatever has become of it.
- **A refusal is shown in Keel's words**, and under them the ways forward Keel gave with it, where it gave any. An org's only owner who would leave is told to make another member an owner first.
- **The page shows no way in that Keel would refuse.** It asks Keel which it offers besides a passkey (`GET /v1/auth/methods`), and a Keel that does not say offers a passkey alone.
- **Keel takes a change to how an account signs in only from a fresh session**: one signed in by a passkey in the last ten minutes (`FRESH_SIGN_IN_REQUIRED`, from adding or removing a passkey). The settings page says Keel's sentence and, to someone who has a passkey, offers "Sign in again with a passkey": one tap signs them in afresh and asks again exactly what Keel refused. Should the passkey be another account's, the page is read again as whoever is now signed in and nothing is asked. Someone with no passkey has none to touch. Keel takes an account's first passkey from a sign-in of its own made in the last ten minutes, so they are offered "Sign in again", which ends the session and comes back to the settings by the sign-in page (`wayToFresh` in `src/account/fresh.ts`). On `/v1` the same rule answers a sponsor's move with `auth.fresh_sign_in_required`, and the settings page offers the same touch there.
- **A user who signed up with a passkey has no address.** Keel keeps one for them in a domain that can never receive mail, and `account.ts` hands no such address to a page.
- **Where Keel serves no identity yet**, these pages say that signing in is not open, and show no form.
- **In tests the real Better Auth stands in for Keel's** (`test/fixtures/identity/standIn.ts`), with the plugins Keel uses and its origin check on, so nothing imitates a route by hand. The browser checks sign up by a code, sign out and back in by one, and ten minutes on (`identity.age()`) are refused a first passkey in Keel's words, sign in again as the page offers, and add it. On a stand-in that offers passkeys alone, as keel.town first did, they sign up with a handle and a passkey made by Chrome's own virtual authenticator and nothing else, sign out and back in with it, add a second device's passkey while the session is fresh, and ten minutes on (`identity.age()`) are refused the removal of the first, sign in again with one tap and see it removed. Then, with a second person in a browser of her own: make an org, invite her by handle, join by the invitation's link, open the link again and be told it was answered, change her role, remove her, let a second invitation lapse, have her join as an owner and leave first so that the only owner is refused, and delete the org. The stand-in has Keel's roles, keeps no org for a person, and resolves a handle to its user for an invitation, as Keel does. It refuses in Keel's codes and sentences too: an invitation that was answered or has lapsed, to the person it was made to and nobody else, an org's only owner who would leave, and a change to how an account signs in from a session that is not fresh (it records how each session was signed in, as Keel's `fresh.ts` does, and takes an account's first passkey from a sign-in of its own that new).

## The code

The Code tab is read from Keel's four repository reads (`Repo_getTree`, `Repo_getBlob`, `Repo_listCommits`, `Repo_getCommit`), which Keel answers to whoever it shows the project to.

- An address says whether it names a file (`/blob/`) or a directory (`/tree/`), and Keel is asked for that. The other is asked for only when Keel answers `repo.path_not_found`.
- Keel's history gives a commit and the change it carries. The log gives the rest, joined by the commit: the change's `#n`, how high trunk stood once the commit was its head, and whether that advance was verified. When a commit landed is its committer's time, since a change restacked onto trunk keeps its author's own.
- **The code does not wait for the log.** Keel finds a project by its namespace's handle and its name (`Namespaces_getProject`) and answers with its id. The code is asked for at once, at the project's `main`, and drawn when it comes; the log is read behind it. When the log says trunk is at the commit Keel read `main` at, what was read stands and nothing is read twice.
- **The heaviest parts are files of their own.** The code viewer, which carries the highlighter, and the two graphs are asked for by the pages that draw them (`src/views/later.tsx`): the home, a handle's page, the account pages and every list wait for none of them. A place asks for what it draws as soon as its address is read (`warm`), and the built page's HTML asks sooner, by the address alone (`early()` in `vite.config.ts`). A directory's page asks for the viewer a moment after it is up, so the first file opened from it has it. The build fails if the viewer or the graph stops being a file of its own.
- One thing the page can show is not Keel's to give yet, and is shown only on a test fixture: the reasons beside a file's lines (`src/contract/provisional.ts`). Keel serves no clone address yet, and the page shows none.

## A conflict

A conflict's page is drawn from Keel's own shape for one, `ConflictDetail`: what `GET /v1/conflicts/{id}` answers. The console folds that shape from the project's log (`src/engine/conflict.ts`), out of the events Keel folds it from, so the page fills as a probe runs.

- **The two sides are Keel's to name.** Its suspicion carries the premise at stake with the change that holds it, and the effect against it with the change that makes it, and says how the effect is known: declared by its agent, or derived and by which method. The console works none of it out. A conflict Keel suspected without them, such as a change against a tenet trunk already holds, has a page that names its parties and says Keel named no two sides.
- **The matrix is Keel's record.** Five worlds, and in each the probe's runs and the suites Keel ran there: trunk's own on trunk, each side's own in its world, and both where the two are composed. Keel records a run when it has ended and runs the worlds in no fixed order, so a run it has not recorded is still to come and nothing is said to be running.
- **It is called by Keel's own fields**: its subject and predicate, or its `C-n` where Keel named no subject. How it was proven, why it was dismissed, the move that resolved it and why a probe was discarded are each in Keel's word.
- **Before a person is asked, the Evidence tab lists Keel's records of it**: what each side holds, how the effect is known, the probe's runs and each suite's count where the two are composed. No row is reasoned by the console. Once a person is asked, the list is the question's own evidence.
- **A probe's source is Keel's** (`Probes_getProbeSource`), read when its tab is opened and drawn file by file. A probe none of whose drafts compiled has none, and the page says so.

`node scripts/level.ts <origin> <namespace> <project>` sets the console's fold of a public project's log beside Keel's own read of each of its conflicts, and says where the two differ. It reads only, as a visitor.

## Addresses

`src/route.ts` is the whole table. `O` is an org's handle and `P` a project's name in it.

| Address | What is there |
|---|---|
| `/` | The home: the projects Keel names to the reader, each under its namespace, and the reader's orgs where someone is signed in |
| `/N` | The namespace's own page: its projects |
| `/N/P`, `/N/P/tree/<ref>/<path>`, `/N/P/blob/<ref>/<path>` | The code. `ref` is a commit, or `trunk` for wherever trunk's head is |
| `/N/P/commits`, `/N/P/commit/<sha>` | Trunk's history, and one commit's diff |
| `/N/P/changes`, `/N/P/changes/<n>`, `…/verification`, `…/files`, `…/alternatives` | The changes, and one change with its parts. `?state=` is `in-flight`, `parked`, `bounced`, `landed` or `not-landed`. `…/alternatives` sets the change beside the others Keel told it have its intent, in Keel's order and never ranked |
| `/N/P/conflicts`, `/N/P/conflicts/<C-n>`, `…/probe`, `…/evidence` | The conflicts, and one conflict. `?state=` is `open` or `settled` |
| `/N/P/escalations`, `/N/P/escalations/<E-n>` | The questions put to a person, and one of them. `?state=` is `open` or `closed` |
| `/N/P/mission-control`, `/N/P/subjects/<key>` | The live graph with trunk's numbers above it, and the graph with one subject open beside it |
| `/N/P/insights`, `/N/P/insights/funnel`, `/N/P/insights/benchmark` | Trunk's numbers, the review funnel, the benchmark |
| `/N/P/settings` | Who may read the project, and what else Keel holds for it. A tab for an owner or a maintainer of the project's namespace |

No namespace is called one of the reserved first segments: the pages above every project, the build's own files and what Keel answers itself. The list is Keel's own, `RESERVED_SEGMENTS` in `@keeltown/contracts`: Keel refuses each as a handle, and the route table reads the same list before it takes a segment for one. Every other path that is not a file is the page, a path with a dot in it included.

A project's log is asked for by the project's id, and the page folds only the events that name that project (`src/engine/projects.ts`), so one project's advances and questions are never counted in another's. Keel's log is the whole instance's: a page is its next stretch with the project's entries picked out, so a stretch that holds none of them is an empty page whose cursor has moved on. The console reads on until the cursor stops moving, and takes no empty page for the log's end. An entry of Keel's log that the console cannot fold is left out and counted beside "Live", so one such entry never stops the rest from being shown.

## How it is put together

```
route  →  pages  →  views  →  engine (playhead, world, projections)  →  source  →  contract (types)
```

- `src/contract/keel/` names `@keeltown/contracts`: every request, response, model and event the console reads is Keel's own generated type. `src/contract/events.ts` lays over that the short list of what has been decided and Keel has not built (`Ahead`); `pnpm typecheck` fails there the day Keel builds one.
- `src/source/http.ts` is Keel as the page reaches it: `/v1` on the page's own origin, with nothing added. `src/source/repository.ts` is the repository port, in Keel's own shapes.
- `src/engine/` is the playhead and the projections each page reads. `src/views/` draws them and never touches a transport.
- `src/account/` is the pages above every project, on Keel's identity at `/v1/auth`.
- `src/worker/` is the Worker: `/healthz`, and the page for everything else. `handler.ts` needs nothing of the Workers runtime but fetch, so it is tested as it is, in Node; `index.ts` is its entry.
- `test/fixtures/` holds the scripted logs, held to Keel's catalogue and state machines, a stand-in for Keel's API that knows a reader by their session and reads a non-member the public part of the log alone, as Keel's read scope does, and the real Better Auth standing in for Keel's identity. They are test code. The page reaches a scripted log only in development, through a dynamic import that is not in the build.

`wrangler.jsonc` serves `dist` as static assets with `not_found_handling: "single-page-application"` and runs the Worker first only for `/healthz`. It has no binding but those files, and no secret.

## Run it

```sh
pnpm --dir apps/console dev      # the page alone, http://localhost:5311
```

With nothing else in the address, the page reads Keel at `/v1` on its own origin, and the dev server has none: a project's address says it could not reach Keel. In development only, a test fixture is asked for by name, and the header says "Test fixture" whenever one is showing:

| In development | What the fixture shows |
|---|---|
| `/?scenario=s1` | The home with scenario 1's one project, `acme/demo`. Every fixture's projects are in the org `acme` |
| `/acme/demo/conflicts/C-1?scenario=s1&t=7:23&play=0` | Conflict C-1, with the world matrix one run from full |
| `/acme/demo/mission-control?scenario=swarm` | 800 of a load generator's agents in Mission Control, beside three REAL sessions |
| `/acme/demo/mission-control?scenario=s1&t=8:30&play=0` | The first change has come back relying on a second subject: it stands in its own lane, and the second subject's lane shows it again, as a reference to where it stands |
| `/acme/demo/changes/1205?scenario=s2&t=3:20&play=0` | Nine days on: a careless change bounces on guard G-1, citing decision D-1 |
| `/acme/demo/changes/1?scenario=s3&t=8:15&play=0` | Scenario 1's conflict where the changes' plans say nothing of its predicate: Keel notes it on both and holds neither, and #1 lands as written |
| `/acme/demo/changes/1?scenario=s4&t=7:40&play=0` | The same conflict where the plans block on its predicate: both changes bounce on the conflict itself, with no verdict |
| `/acme/demo/changes/2/alternatives?scenario=s5&t=2:40&play=0` | Three agents with the same intent, shown to each other: one landed, one withdrew, one is still working |

## Checks

All of these run in the repository's `pnpm check`:

| Check | Where |
|---|---|
| The page's and the Worker's TypeScript projects, and the console's own lint (React and accessibility rules the root lint does not carry, `oxlint.console.json`) | `typecheck` |
| Unit tests: the engine, the fixtures' conformance to Keel's state machines, the page's source against the stand-in Keel, the account pages against the real Better Auth, the Worker's handler | `test/unit`, in the `unit` project |
| The Worker in workerd, with its real config and the built page as its assets: the page for any path, `/healthz`, nothing bound to it but its files and its host, and the page where its proxy once was | `test/pool`, project `pool:console` |
| The build contains no fixture and no playback control; and neither it, the Worker's code nor its config names a credential or a path the console once read Keel through | `scripts/guard-build.ts`, in `deploy:dry` |
| No retired name for a view comes back | `test/unit/names.test.ts` |

Each was seen failing against a planted fault. The faults for the security rules, for reading by project and for the rest are in `test/mutants/console-*.patch`, for `pnpm prove:red console`.

One check is run by hand, because it needs Chrome and a dev server:

```sh
pnpm --dir apps/console dev      # in one terminal
pnpm --dir apps/console e2e      # in another: the real page in headless Chrome
```

It drives the pages on the fixtures the dev server serves (every tab and row a link with an address of its own, Back returning the way one came, any page opening from its address alone, a conflict's matrix with the five suites Keel runs and no cell waiting on one it does not, a conflict with no sides, a probe's source, and the same pages at a phone's width with nothing off the side of the screen). Then it builds the console and drives it as it is deployed, with the real Better Auth answering `/v1/auth` and a stand-in Keel the rest of `/v1`, which knows a reader by their session:

- **a visitor on a public project**, whose entries lie behind 1,200 of other projects' in the stand-in's log: the home lists it, its code is on the page before Keel has answered about the log, the log is read past the other projects' entries without waiting, its questions are said to be its members' to read and none is counted or shown, a conflict that waits on a ruling says so, a probe's source is read from Keel when its tab is opened, a change's agent has no name and no class, and the frame's way in comes back to the page;
- **someone signed in who is no member, on a public project**: told of its questions what a visitor is;
- **a visitor, and someone signed in who is no member, on a private project**: both are told what they are told of a project that is not there;
- **a member**: her home lists first the question Keel has put to her, by its label and under its project, at a phone's width too; left open in a second tab it asks for the list twice and not again while Keel's log says nothing, and loses the question when she answers it in the first, with no reload; her own page lists the project, the frame drops down on the account and on the project, the QR code beside a question says the question's own address, and her answer reaches Keel as its own operation with no credential of the page's;
- **an owner, on the project's settings**: the tab is offered to her and not to a visitor, making the project public waits for its whole name, Keel is sent the settings whole with that one field changed, a visitor then reads the project and is refused its settings in Keel's word, and one click makes it private again.

The dev server goes on serving the old version of a file that a script has written, so restart it before running this after an edit.

What has been seen on keel.town, and when, is in `docs/status/tenancy-ui.md`.
