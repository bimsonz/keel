# The Keel console

How a person sees Keel: the projects an instance holds, and for each project its code, its changes, the conflicts between them, the few questions that need a person, and Mission Control, the live graph of a swarm of agents changing one codebase. All of it is read from Keel.

A Keel holds orgs and an org holds projects, so a project's address is `/<org>/<project>`, as a repository's is on a code host. The bare address is the home: the projects Keel names to whoever is reading. A project is the frame: Code, Changes, Conflicts, Escalations, Mission Control and Insights are its tabs, every thing in it has a page and an address of its own, and each kind of thing is listed one way and shown one way.

It reads Keel and nothing else. There is no replay in it and no recorded stand-in: what the console shows is what Keel says, and where Keel does not say something yet the console leaves that place empty and says so.

It is a Vite single-page app (React, Tailwind, Cloudflare's Kumo components, React Flow for Mission Control and for Verification Plans, `@pierre/diffs` for code) and a small Worker, `keel-console`, that serves the built page and does nothing else.

## Who may read what

| Who | Reads | Can |
|---|---|---|
| A visitor, with no session | The projects an org has made public. The home lists them, and each one's code, its log and everything folded from the log are theirs to read | Nothing but read |
| Someone signed in | That, and the projects of the orgs they are a member of | Answer a question in a project of an org they are a member of |

**The console holds no credential, and has no way to Keel of its own.** The page reads `/v1` on its own origin and puts nothing on a request. Who is reading is the session cookie Keel's own sign-in set (`__Secure-keel.session_token`), which the browser sends and the page cannot read. The Worker has no secret and no binding to Keel: it answers `/healthz` and serves the page. Keel decides every read and every ruling.

A project Keel does not show a reader is the same answer whether it is private or not there at all, and the page says the same of both: "There is no project `<org>/<project>` here".

A question is answered with Keel's own operation (`Operator_giveRuling`), as whoever is signed in. Its options can be tapped where Keel's answer about the project names the reader a member of its org (`viewer.role`), and a refusal is shown in Keel's words, with the ways forward it gave. Beside an open question is a QR code of the question's own address and nothing more: no key and no capability. Whoever opens it on a phone signs in, and Keel decides whether they may answer.

## Accounts

Keel's users sign up and sign in through Better Auth, which Keel mounts at `/v1/auth` on the console's own origin. The pages above every project speak to it directly, and the console's Worker has no part in it.

| Address | What it is |
|---|---|
| `/signup?claim` | Where whoever set a Keel up makes its first account: the same page with a "Claim code" field. The code is typed, never in an address. It rides as `Keel-Claim` on the two passkey calls and on nothing else, and the page keeps it nowhere once the sign-up has ended |
| `/signup`, `/login` | A passkey, always: a new person signs up with a handle and a passkey made on their own device, and is asked for no address. A code sent by email and GitHub are shown only where this Keel offers them; someone who signs up by one of those chooses their handle next. The handle is their name on this Keel, and the name of their own org |
| `/settings` | The user's passkeys, and signing out here or everywhere else |
| `/device` | Approving a terminal that is running `keeltown login`, by the code it shows |
| `/<org>` | An org's home: its projects. Anyone may open it, and a visitor is shown the public ones. `/orgs/<org>` is put right to it |
| `/new/org` | Making an org: a name, and a handle that is then fixed |
| `/orgs/<org>/members` | Members, by handle and role. Inviting by handle or by email, with a link to pass on. Changing a role, removing a member, leaving |
| `/orgs/<org>/settings` | Renaming, and deleting once the org's handle is typed. A user's own org is never deleted |
| `/invite/<id>` | An invitation, read only to the person it was made to, to join or to decline. Once it was answered or has lapsed, the page tells that person so, in Keel's words |
| `/terms`, `/privacy` | The Terms of Service and the Privacy Notice, for anyone to read. The text is `docs/legal/terms.md` and `docs/legal/privacy.md`, built into the page, so these two pages ask Keel nothing. A foot on every page links both, and the sign-up page says that creating an account agrees to them |

- **The session is an HttpOnly cookie**, which the page cannot read. Better Auth's answers also carry the session's token in their body, so one module (`src/account/account.ts`) is the only code that sees an answer, and it hands on nothing but the user's id, email, name and handle.
- **The page puts no credential on a request.** A visitor's request carries none.
- **The address names the org.** Every call names the org it is about. Better Auth also keeps an "active organisation" for a session, and the console neither reads it nor sets it.
- **No page shows another person's address.** A member is shown by handle and name, and an invitation made by handle is told by the handle. Better Auth's answers carry every member's address, so `account.ts` hands on none but one a member typed into an invitation.
- **Roles are Keel's three**: owner, maintainer and member (`src/account/roles.ts`). A maintainer does everything but delete the org and make or unmake an owner. Keel decides; a page only keeps from offering what Keel would refuse.
- **The frame is a code host's**: `Keel / <org> / <project>`, where each name is a link and has a dropdown beside it to the others of its kind: the reader's orgs, and the org's projects (`src/views/Switch.tsx`). A visitor has a way to sign in there that comes back to the page they were on. It is offered once Keel has listed those orgs, and not before.
- **An org that is not the reader's is told as one that is not there**, and so is an invitation made to someone else, whatever has become of it.
- **A refusal is shown in Keel's words**, and under them the ways forward Keel gave with it, where it gave any. An org's only owner who would leave is told to make another member an owner first.
- **The page shows no way in that Keel would refuse.** It asks Keel which it offers besides a passkey (`GET /v1/auth/methods`), and a Keel that does not say offers a passkey alone.
- **A user who signed up with a passkey has no address.** Keel keeps one for them in a domain that can never receive mail, and `account.ts` hands no such address to a page.
- **Where Keel serves no identity yet**, these pages say that signing in is not open, and show no form.
- **In tests the real Better Auth stands in for Keel's** (`test/fixtures/identity/standIn.ts`), with the plugins Keel uses and its origin check on, so nothing imitates a route by hand. The browser checks sign up, add a passkey with Chrome's own virtual authenticator, sign out and sign back in with it. On a stand-in that offers passkeys alone, as keel.town first did, they sign up with a handle and a passkey and nothing else. Then, with a second person in a browser of her own: make an org, invite her by handle, join by the invitation's link, open the link again and be told it was answered, change her role, remove her, let a second invitation lapse, have her join as an owner and leave first so that the only owner is refused, and delete the org. The stand-in has Keel's roles, makes a user's own org when their handle is first set, and resolves a handle to its user for an invitation, as Keel does. It refuses in Keel's codes and sentences too: an invitation that was answered or has lapsed, to the person it was made to and nobody else, and an org's only owner who would leave.

## The code

The Code tab is read from Keel's four repository reads (`Repo_getTree`, `Repo_getBlob`, `Repo_listCommits`, `Repo_getCommit`), which Keel answers to whoever it shows the project to.

- An address says whether it names a file (`/blob/`) or a directory (`/tree/`), and Keel is asked for that. The other is asked for only when Keel answers `repo.path_not_found`.
- Keel's history gives a commit and the change it carries. The log gives the rest, joined by the commit: the change's `#n`, how high trunk stood once the commit was its head, and whether that advance was verified. When a commit landed is its committer's time, since a change restacked onto trunk keeps its author's own.
- **The code does not wait for the log.** Keel finds a project by its org and name (`Orgs_getProject`) and answers with its id. The code is asked for at once, at the project's `main`, and drawn when it comes; the log is read behind it. When the log says trunk is at the commit Keel read `main` at, what was read stands and nothing is read twice.
- One thing the page can show is not Keel's to give yet, and is shown only on a test fixture: the reasons beside a file's lines (`src/contract/provisional.ts`). Keel serves no clone address yet, and the page shows none.

## Addresses

`src/route.ts` is the whole table. `O` is an org's handle and `P` a project's name in it.

| Address | What is there |
|---|---|
| `/` | The home: the projects Keel names to the reader, each under its org, and the reader's orgs where someone is signed in |
| `/O` | The org's home: its projects |
| `/O/P`, `/O/P/tree/<ref>/<path>`, `/O/P/blob/<ref>/<path>` | The code. `ref` is a commit, or `trunk` for wherever trunk's head is |
| `/O/P/commits`, `/O/P/commit/<sha>` | Trunk's history, and one commit's diff |
| `/O/P/changes`, `/O/P/changes/<n>`, `…/verification`, `…/files`, `…/alternatives` | The changes, and one change with its parts. `?state=` is `in-flight`, `parked`, `bounced`, `landed` or `not-landed`. `…/alternatives` sets the change beside the others Keel told it have its intent, in Keel's order and never ranked |
| `/O/P/conflicts`, `/O/P/conflicts/<C-n>`, `…/probe`, `…/evidence` | The conflicts, and one conflict. `?state=` is `open` or `settled` |
| `/O/P/escalations`, `/O/P/escalations/<E-n>` | The questions put to a person, and one of them. `?state=` is `open` or `closed` |
| `/O/P/mission-control`, `/O/P/subjects/<key>` | The live graph with trunk's numbers above it, and the graph with one subject open beside it |
| `/O/P/insights`, `/O/P/insights/funnel`, `/O/P/insights/benchmark` | Trunk's numbers, the review funnel, the benchmark |

An org is never called one of the reserved first segments (`RESERVED` in `src/route.ts`): the pages above every project, the build's own files and `healthz`. Keel refuses each as a handle. Every other path that is not a file is the page, a path with a dot in it included.

A project's log is asked for by the project's id, and the page folds only the events that name that project (`src/engine/projects.ts`), so one project's advances and questions are never counted in another's. An entry of Keel's log that the console cannot fold is left out and counted beside "Live", so one such entry never stops the rest from being shown.

## How it is put together

```
route  →  pages  →  views  →  engine (playhead, world, projections)  →  source  →  contract (types)
```

- `src/contract/keel/` names `@keeltown/contracts`: every request, response, model and event the console reads is Keel's own generated type. `src/contract/events.ts` lays over that the short list of what has been decided and Keel has not built (`Ahead`); `pnpm typecheck` fails there the day Keel builds one.
- `src/source/http.ts` is Keel as the page reaches it: `/v1` on the page's own origin, with nothing added. `src/source/repository.ts` is the repository port, in Keel's own shapes.
- `src/engine/` is the playhead and the projections each page reads. `src/views/` draws them and never touches a transport.
- `src/account/` is the pages above every project, on Keel's identity at `/v1/auth`.
- `src/worker/` is the Worker: `/healthz`, and the page for everything else. `handler.ts` needs nothing of the Workers runtime but fetch, so it is tested as it is, in Node; `index.ts` is its entry.
- `test/fixtures/` holds the scripted logs, held to Keel's catalogue and state machines, a stand-in for Keel's API that knows a reader by their session, and the real Better Auth standing in for Keel's identity. They are test code. The page reaches a scripted log only in development, through a dynamic import that is not in the build.

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

It drives the pages on the fixtures the dev server serves (every tab and row a link with an address of its own, Back returning the way one came, any page opening from its address alone, and the same pages at a phone's width with nothing off the side of the screen). Then it builds the console and drives it as it is deployed, with the real Better Auth answering `/v1/auth` and a stand-in Keel the rest of `/v1`, which knows a reader by their session:

- **a visitor on a public project**: the home lists it, its code is on the page before Keel has answered about the log, nothing can be tapped on a question, and the frame's way in comes back to the page;
- **a visitor, and someone signed in who is no member, on a private project**: both are told what they are told of a project that is not there;
- **a member**: her org's home lists the project, the frame drops down on the org and on the project, the QR code beside a question says the question's own address, and her answer reaches Keel as its own operation with no credential of the page's;
- **the claim**: the code rides on the two passkey calls and on nothing else, and is in no storage and no address afterwards.

The dev server goes on serving the old version of a file that a script has written, so restart it before running this after an edit.

What has been seen on keel.town, and when, is in `docs/status/tenancy-ui.md`.
