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

Keel reads its event log only to an observer today. So a visitor sees a project's frame and, once Keel serves them, its code; Changes, Conflicts, Escalations, Mission Control and Insights say that they are read from the log, and show nothing in its place.

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
- `src/source/http.ts` is Keel as the page reaches it, through the Worker at `/api`. `src/source/repository.ts` is the repository port.
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
| The Worker in workerd, with its real config, the built page as its assets and a stand-in `keel` behind the real service binding: the page for any path; a visitor's read reaching Keel with no `Authorization`; the presenter's reaching it as the observer; a wrong key refused without asking Keel | `test/pool`, project `pool:console` |
| The build contains no fixture and no playback control | `scripts/guard-build.ts`, in `deploy:dry` |
| No retired name for a view comes back | `test/unit/names.test.ts` |

Each was seen failing against a planted fault. The faults for the security rule and for folding by project are in `test/mutants/console-*.patch`, for `pnpm prove:red console`.

Not yet moved here: the browser checks (the real page in Chrome, on the fixtures and on the built console behind its Worker) and the captures. Until they are, what a browser shows is checked by hand.

Not yet checked against a running Keel: the console has read only the stand-in. The first read of a real Keel is on staging, with the presenter's key.
