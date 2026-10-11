# The Keel console

How a person sees Keel: the projects an instance holds, and for each project its code, its changes, the conflicts between them, the few questions that need a person, and Mission Control, the live graph of a swarm of agents changing one codebase. All of it is read from Keel.

One Keel is one organisation's, so the bare address lists its projects. A project is the frame, as a repository is on a code host: Code, Changes, Conflicts, Escalations, Mission Control and Insights are its tabs, every thing in it has a page and an address of its own, and each kind of thing is listed one way and shown one way.

It reads Keel and nothing else. There is no replay in it and no recorded stand-in: what the console shows is what Keel says, and where Keel does not say something yet the console leaves that place empty and says so.

It is a Vite single-page app (React, Tailwind, Cloudflare's Kumo components, React Flow for Mission Control and for Verification Plans, `@pierre/diffs` for code) and a small Worker, `keel-console`, that serves the built page and stands between it and Keel.

## Who may read what

| Opened | Reads | Can |
|---|---|---|
| By anyone | What Keel reads to anyone. The Worker passes the read to Keel **with no token**, so a `public` project answers and a private one is a plain 404 | Nothing but read |
| With the presenter's key, once, in the address's fragment (`/#presenter=…`) | The whole instance, as Keel's observer | Answer a question, and show a QR code beside it. The key is kept for the session and taken out of the address |
| From that QR code, on a phone | | Answer that one question, once, within ten minutes |

The page never holds a credential for Keel. The Worker holds two: an observer's and an operator's. The observer reads every project, private ones included, so its token is added only to a read that shows the presenter's key; a key that is not the presenter's is refused by the Worker and never reaches Keel. The operator's token is used for exactly one thing: a ruling reaches Keel only through `POST /rule/<capability>`, where the capability is signed by the Worker and names one question.

Keel reads its event log only to an observer today. So Changes, Conflicts, Escalations, Mission Control and Insights tell a visitor that they are read from the log, and show nothing in its place.

## Accounts

Keel's users sign up and sign in through Better Auth, which Keel mounts at `/v1/auth` on the console's own origin. The pages above every project speak to it directly, and the console's Worker has no part in it.

| Address | What it is |
|---|---|
| `/signup`, `/login` | A passkey, GitHub, or a code sent by email. A new address is signed up by its first code, and then chooses a handle: its name on this Keel, and the name of its own org |
| `/settings` | The user's passkeys, and signing out here or everywhere else |
| `/device` | Approving a terminal that is running `keeltown login`, by the code it shows |
| `/orgs/<org>` | An org's home: its members, and its projects once Keel says which org a project is in. It moves to `/<org>` when an org's handle becomes the first segment of an address |
| `/new/org` | Making an org: a name, and a handle that is then fixed |
| `/orgs/<org>/members` | Members, by handle and role. Inviting by handle or by email, with a link to pass on. Changing a role, removing a member, leaving |
| `/orgs/<org>/settings` | Renaming, and deleting once the org's handle is typed. A user's own org is never deleted |
| `/invite/<id>` | An invitation, read only to the person it was made to, to join or to decline |

- **The session is an HttpOnly cookie**, which the page cannot read. Better Auth's answers also carry the session's token in their body, so one module (`src/account/account.ts`) is the only code that sees an answer, and it hands on nothing but the user's id, email, name and handle.
- **The page puts no credential on a request.** A visitor's request carries none.
- **The address names the org.** Every call names the org it is about. Better Auth also keeps an "active organisation" for a session, and the console neither reads it nor sets it.
- **No page shows another person's address.** A member is shown by handle and name, and an invitation made by handle is told by the handle. Better Auth's answers carry every member's address, so `account.ts` hands on none but one a member typed into an invitation.
- **Roles are Keel's three**: owner, maintainer and member (`src/account/roles.ts`). A maintainer does everything but delete the org and make or unmake an owner. Keel decides; a page only keeps from offering what Keel would refuse.
- **The frame is a code host's**: `Keel / <org>`, where the name is a link and has a dropdown beside it to the reader's other orgs, the same one a project's name has (`src/views/Switch.tsx`).
- **An org that is not the reader's is told as one that is not there**, and so is an invitation made to someone else.
- **Where Keel serves no identity yet**, these pages say that signing in is not open, and show no form.
- **In tests the real Better Auth stands in for Keel's** (`test/fixtures/identity/standIn.ts`), with the plugins Keel uses and its origin check on, so nothing imitates a route by hand. The browser checks sign up, add a passkey with Chrome's own virtual authenticator, sign out and sign back in with it. Then, with a second person in a browser of her own: make an org, invite her by handle, join by the invitation's link, change her role, remove her, and delete the org. The stand-in has Keel's roles, makes a user's own org when their handle is first set, and resolves a handle to its user for an invitation, as Keel does.

## The code

The Code tab is read from Keel's four repository reads (`Repo_getTree`, `Repo_getBlob`, `Repo_listCommits`, `Repo_getCommit`), which Keel answers with no token for a public project.

- A path is a directory or a file, and only Keel knows which: the tree is asked for first, and when Keel answers `repo.path_not_found` the file is.
- Keel's history gives a commit and the change it carries. The log gives the rest, joined by the commit: the change's `#n`, how high trunk stood once the commit was its head, and whether that advance was verified. When a commit landed is its committer's time, since a change restacked onto trunk keeps its author's own.
- Keel reads a repository by the project's id, and an address has its name. The console learns ids from the log, so today the presenter sees every project's code, and a visitor is told that the code is not shown to visitors yet. A visitor reads a public project's code once Keel answers a name with an id.
- Two things the page can show are not Keel's to give yet, and are shown only on a test fixture: the reasons beside a file's lines, and where to clone the project from. Their shapes are in `src/contract/provisional.ts`.

## Addresses

`src/route.ts` is the whole table. `P` is a project's name.

| Address | What is there |
|---|---|
| `/` | The instance: its projects, each with who may read it |
| `/P`, `/P/tree/<ref>/<path>`, `/P/blob/<ref>/<path>` | The code. `ref` is a commit, or `trunk` for wherever trunk's head is |
| `/P/commits`, `/P/commit/<sha>` | Trunk's history, and one commit's diff |
| `/P/changes`, `/P/changes/<n>`, `…/verification`, `…/files` | The changes, and one change with its parts. `?state=` is `in-flight`, `parked`, `bounced`, `landed` or `not-landed` |
| `/P/conflicts`, `/P/conflicts/<C-n>`, `…/probe`, `…/evidence` | The conflicts, and one conflict. `?state=` is `open` or `settled` |
| `/P/escalations`, `/P/escalations/<E-n>` | The questions put to a person, and one of them. `?state=` is `open` or `closed` |
| `/P/mission-control`, `/P/subjects/<key>` | The live graph with trunk's numbers above it, and the graph with one subject open beside it |
| `/P/insights`, `/P/insights/funnel`, `/P/insights/benchmark` | Trunk's numbers, the review funnel, the benchmark |

A project is never called `api`, `present`, `rule`, `healthz` or `assets`: the Worker answers the first four itself, and the last is the build's own files. Every other path that is not a file is the page, a path with a dot in it included.

An observer's log holds every project. A project's pages are folded from its own events and no other's (`src/engine/projects.ts`), so one project's advances and questions are never counted in another's. An entry of Keel's log that the console cannot fold is left out and counted beside "Live", so one such entry never stops the rest from being shown.

## How it is put together

```
route  →  pages  →  views  →  engine (playhead, world, projections)  →  source  →  contract (types)
                                                                          │
                                                                  worker (the page's way to Keel)
```

- `src/contract/keel/` names `@keeltown/contracts`: every request, response, model and event the console reads is Keel's own generated type. `src/contract/events.ts` lays over that the short list of what has been decided and Keel has not built (`Ahead`); `pnpm typecheck` fails there the day Keel builds one.
- `src/source/http.ts` is Keel as the page reaches it, through the Worker at `/api`. `src/source/repository.ts` is the repository port, in Keel's own shapes.
- `src/engine/` is the playhead and the projections each page reads. `src/views/` draws them and never touches a transport.
- `src/worker/` is the Worker. `handler.ts` needs nothing of the Workers runtime but fetch and Web Crypto, so it is tested as it is, in Node; `index.ts` is its entry.
- `test/fixtures/` holds three scripted logs, held to Keel's catalogue and state machines, and a stand-in for Keel's API. They are test code. The page reaches one only in development, through a dynamic import that is not in the build.

`wrangler.jsonc` serves `dist` as static assets with `not_found_handling: "single-page-application"`, runs the Worker first only for `/api/*`, `/rule/*`, `/present/*` and `/healthz`, and reaches Keel through a service binding to the `keel` Worker.

## Run it

```sh
pnpm --dir apps/console dev      # the page alone, http://localhost:5311
```

With nothing else in the address, the page reads Keel through its Worker at `/api`, and the dev server has none: `/` says it could not reach Keel. In development only, a test fixture is asked for by name, and the header says "Test fixture" whenever one is showing:

| In development | What the fixture shows |
|---|---|
| `/?scenario=s1` | The instance with scenario 1's one project, `demo` |
| `/demo/conflicts/C-1?scenario=s1&t=7:23&play=0` | Conflict C-1, with the world matrix one run from full |
| `/demo/mission-control?scenario=swarm` | 800 of a load generator's agents in Mission Control, beside three REAL sessions |
| `/demo/changes/1205?scenario=s2&t=3:20&play=0` | Nine days on: a careless change bounces on guard G-1, citing decision D-1 |

## Checks

All of these run in the repository's `pnpm check`:

| Check | Where |
|---|---|
| The page's and the Worker's TypeScript projects, and the console's own lint (React and accessibility rules the root lint does not carry, `oxlint.console.json`) | `typecheck` |
| Unit tests: the engine, the fixtures' conformance to Keel's state machines, the page's source, the Worker's handler against the stand-in Keel | `test/unit`, in the `unit` project |
| The Worker in workerd, with its real config, the built page as its assets and a stand-in `keel` behind the real service binding: the page for any path; a visitor's read of the log and of a project's code reaching Keel with no `Authorization`; the presenter's reaching it as the observer; a wrong key refused without asking Keel | `test/pool`, project `pool:console` |
| The build contains no fixture and no playback control | `scripts/guard-build.ts`, in `deploy:dry` |
| No retired name for a view comes back | `test/unit/names.test.ts` |

Each was seen failing against a planted fault. The faults for the security rule, for folding by project and for the rest of what the move added are in `test/mutants/console-*.patch`, for `pnpm prove:red console`.

One check is run by hand, because it needs Chrome and a dev server:

```sh
pnpm --dir apps/console dev      # in one terminal
pnpm --dir apps/console e2e      # in another: the real page in headless Chrome
```

It drives the pages on the fixtures the dev server serves (every tab and row a link with an address of its own, Back returning the way one came, any page opening from its address alone), then builds the console and drives it as it is deployed, with the Worker's own code answering the page and a stand-in Keel behind it: as a visitor, who is shown what Keel reads to anyone and sends no credential; as the presenter, who reads the whole instance and answers a question; and on a phone that holds a capability and nothing else. The dev server goes on serving the old version of a file that a script has written, so restart it before running this after an edit.

A phone cannot show its question yet. Keel reads a question only to an observer, and a QR code carries a capability to answer one question, not a key to read with; the phone says so. It will read that one question through the Worker once Keel serves a question on its own.

Not yet checked against a running Keel: the console has read only the stand-in. The first read of a real Keel is on staging, with the presenter's key.
