# forge-lite scenarios

forge-lite is a small repo-hosting API built on Hono for Cloudflare Workers:
users, sessions, repositories, collaborators, roles and permissions, all in
memory. It exists to be changed by two agents at once. This directory holds
those changes as patches, a probe that checks the one premise they disagree
about, and scripts that build every combination and show the result.

## The base fixture

- `createApp({ store, clock, ids })` returns the Hono app; `src/index.ts`
  exports `createApp(memoryDeps())`. Time comes from an injected `Clock`,
  identifiers from an injected generator, state from an in-memory store.
- Roles form a lattice, read < triage < write < maintain < admin, with owner
  above it. `src/domain/permissions.ts` maps each action to its minimum role.
- Every store mutation emits a typed event (`src/events.ts`):
  `collaborator.added`, `collaborator.role-changed`, `repo.deleted` and so on.
- `requirePermission(action)` (`src/authz/require-permission.ts`) evaluates
  the caller's role from the store on every request. A caller who cannot see a
  repository gets 404; one who can see it but may not act gets 403 (401 if
  anonymous). Errors are `application/problem+json`; requests that match no
  route get Hono's default plain-text 404.
- **Access only ever grows on base.** Owners and admins can add collaborators
  and raise their roles. There is no way to remove a collaborator, and
  lowering a role is refused with 409.
- 200 tests: a permission matrix (8 subjects × 8 actions × public/private,
  via `it.each`) plus users, sessions and expiry, repositories, collaborators,
  events and error shapes. All but seven (unit tests of the role lattice,
  permission table and event bus) go through `app.request(...)`. They use only
  `describe`, `it`, `it.each` and `expect`, with no mocks, fake timers or Node
  built-ins, so they can later run unchanged inside workerd.

## The patches

Paths inside each patch are relative to `fixtures/forge-lite/`; apply them
with `git apply` from that directory. Each starts with a short description,
which `git apply` ignores.

| Patch | Applies on | What it represents |
|---|---|---|
| `s1/a.patch` | base | **Agent A: owners can revoke collaborators, effective immediately.** Adds `DELETE /repos/:owner/:repo/collaborators/:username` and `Store.removeCollaborator`, which emits `collaborator.removed`. |
| `s1/b.patch` | base | **Agent B: speed up permission checks.** Adds `src/authz/cache.ts`, a per-session cache of the evaluated collaborator role keyed by (session, repository), and uses it in `requirePermission`. No invalidation. |
| `s1/b-revised.patch` | base + A + B | **B′, after the ruling "a cache is allowed if revocation invalidates it".** The cache subscribes to `collaborator.removed` and evicts the revoked collaborator's entries in all their sessions. The subscription is `src/authz/cache.ts:42`. No new tests: the probe guards it. |
| `s2/careless.patch` | base + A + B + B′ | **"Simplify the permissions code".** Removes the cache's event subscription and the eviction method only it used, as unused complexity. The suite stays green. |

**A's premise: permission evaluation freshness ≤ per-request.** A relies on
`requirePermission` reading the role from the store on every request, so it
does not touch `src/authz/`. Its seven tests check that a revoked user is
denied, but only with a session that never touched the repository before the
revoke, which is the realistic gap.

**B's derived effect: freshness = per-session.** Once a session has a cached
role for a repository, that session keeps it. On base this is safe: roles only
go up, so a cached role can lag behind a promotion but never exceed what the
caller holds, and B re-checks any cached role that falls short of an action.
B's seven tests count collaborator lookups through a store subclass, and check
hits, misses, per-session and per-repository entries, and promotions.

Each patch is correct on its own, and A and B touch disjoint files, so git
merges them cleanly in either direction. Together they let a revoked
collaborator keep their access for as long as their session lives.

## The probe

`s1/probe.test.ts` is kept outside the suite. Alice owns `alice/forge` and Bob
is an admin collaborator. Bob's session reads the repository (warming any
cache), Alice revokes Bob through the DELETE collaborator route, and Bob sends
`DELETE /repos/alice/forge` on the same session. The premise holds if that is
refused with 403 and the repository still exists.

`pnpm probe` runs it through `scenarios/run-probe.mjs`, which prints the
probe's observations and then exactly one JSON line:

| Outcome | Exit | When |
|---|---|---|
| `pass` | 0 | Bob's DELETE was refused with 403 and Alice can still read the repository. |
| `fail` | 1 | Anything else; the reason names the first step that answered differently. |
| `n/a` | 3 | The revoke route is absent: Hono's default 404 (status 404, `text/plain`, body `404 Not Found`) on that exact request. The reason is `revoke route absent`. |

A pass requires the test to run to its last assertion and report Bob's
DELETE on the way. n/a is signalled by the probe throwing a marked error, not
by returning early, so a world without the route can never pass. A problem
with the harness itself (no report, no test, a skipped test) is reported as
`fail` with exit 2.

## Running

From `fixtures/forge-lite`:

```sh
pnpm install --ignore-workspace
pnpm test          # the suite
pnpm typecheck     # tsc --noEmit
pnpm lint          # oxlint
pnpm probe         # the revocation probe on the current tree
pnpm worlds        # every world: suite once, probe three times, compared with the expected matrix
pnpm cold-open     # the demo's opening: merge, test, probe in a throwaway git repo
bash scenarios/merge-both-ways.sh   # A and B merge cleanly in both directions
bash scenarios/na-precision.sh      # n/a fires only for the absent route
```

`pnpm-workspace.yaml` makes this directory a pnpm workspace root of its own,
so pnpm never reaches for the repository's workspace above it, and turns off
pnpm's install-before-run check: `worlds.sh` and `cold-open.sh` run scripts in
throwaway copies whose `node_modules` is a symlink back to this one.

To build a world by hand, copy the fixture somewhere and apply the patches in
order, for example `git apply scenarios/s1/a.patch scenarios/s1/b.patch`.

### Expected matrix

| World | Suite | Probe |
|---|---|---|
| base | green, 200 | n/a |
| A | green, 207 | pass |
| B | green, 207 | n/a |
| A+B | green, 214 | **fail** |
| A+B+B′ | green, 214 | pass |
| A+B+B′+careless | green, 214 | **fail** |

`worlds.sh` holds this table and exits 0 only if every world matches it,
including the test count and a probe outcome that is the same on all three
runs. In its output B′ is written `B'`.

## Captured output

Captured on 2026-10-10 on macOS with Node 22.22.3 and pnpm 11.18.0, colour
off. Absolute paths are shortened: the fixture to `fixtures/forge-lite`,
temporary directories to `$TMPDIR/...`. `[exit N]` is the command's exit
status.

### Base: suite, typecheck, lint

```
$ pnpm test
$ vitest run

 RUN  v5.0.3 fixtures/forge-lite

 ✓ test/domain.test.ts (6 tests) 3ms
 ✓ test/problems.test.ts (3 tests) 67ms
 ✓ test/users.test.ts (14 tests) 76ms
 ✓ test/events.test.ts (8 tests) 82ms
 ✓ test/sessions.test.ts (10 tests) 84ms
 ✓ test/collaborators.test.ts (10 tests) 96ms
 ✓ test/repos.test.ts (21 tests) 113ms
 ✓ test/permission-matrix.test.ts (128 tests) 410ms

 Test Files  8 passed (8)
      Tests  200 passed (200)
   Start at  19:50:38
   Duration  651ms (tests 50%, transform 36%, import 12%, worker 1%)

[exit 0]
```

```
$ pnpm typecheck
$ tsc --noEmit
[exit 0]
```

```
$ pnpm lint
$ oxlint --deny-warnings
Found 0 warnings and 0 errors.
Finished in 52ms on 39 files with 152 rules using 12 threads.
[exit 0]
```

### Base: probe

```
$ pnpm probe
$ node scenarios/run-probe.mjs
alice DELETE /repos/alice/forge/collaborators/bob -> 404 Not Found (no such route)
{"outcome":"n/a","reason":"revoke route absent"}
[ELIFECYCLE] Command failed with exit code 3.
[exit 3]
```

### Each patch applies on its intended base

```
$ git apply --check scenarios/s1/a.patch && git apply --check scenarios/s1/b.patch && echo 'a.patch and b.patch apply on base'
a.patch and b.patch apply on base
[exit 0]
```

```
$ w=$(mktemp -d) && cp -R src test "$w" && cd "$w" && git apply $F/scenarios/s1/{a,b}.patch && git apply --check $F/scenarios/s1/b-revised.patch && ... careless.patch
b-revised.patch applies on base+A+B
careless.patch applies on base+A+B+B'
[exit 0]
```

### A and B merge cleanly both ways

```
$ bash scenarios/merge-both-ways.sh
changed by A:    src/domain/permissions.ts src/events.ts src/routes/collaborators.ts src/store/memory.ts src/store/types.ts test/revoke-collaborator.test.ts 
changed by B:    src/authz/cache.ts src/authz/require-permission.ts test/permission-cache.test.ts 
changed by both: 
$ git checkout agent-a && git merge --no-commit agent-b
Automatic merge went well; stopped before committing as requested
$ git checkout agent-b && git merge --no-commit agent-a
Automatic merge went well; stopped before committing as requested
[exit 0]
```

### All worlds

```
$ pnpm worlds
$ bash scenarios/worlds.sh
world             suite           probe  stable     detail
-----             -----           -----  ------     ------
base              200/200 green   n/a    yes (3/3)  revoke route absent
A                 207/207 green   pass   yes (3/3)  bob DELETE /repos/alice/forge -> 403 (expected 403)
B                 207/207 green   n/a    yes (3/3)  revoke route absent
A+B               214/214 green   FAIL   yes (3/3)  bob DELETE /repos/alice/forge -> 204 (expected 403)
A+B+B'            214/214 green   pass   yes (3/3)  bob DELETE /repos/alice/forge -> 403 (expected 403)
A+B+B'+careless   214/214 green   FAIL   yes (3/3)  bob DELETE /repos/alice/forge -> 204 (expected 403)

matrix matches the expected outcomes
[exit 0]
```

### Cold open

```
$ pnpm cold-open
$ bash scenarios/cold-open.sh
$ git merge --no-commit agent-b
Automatic merge went well; stopped before committing as requested

$ pnpm test
$ vitest run

 RUN  v5.0.3 $TMPDIR/forge-lite-cold-open.kU9Qyp/forge-lite

 ✓ test/domain.test.ts (6 tests) 3ms
 ✓ test/problems.test.ts (3 tests) 43ms
 ✓ test/users.test.ts (14 tests) 48ms
 ✓ test/events.test.ts (8 tests) 58ms
 ✓ test/sessions.test.ts (10 tests) 59ms
 ✓ test/permission-cache.test.ts (7 tests) 68ms
 ✓ test/collaborators.test.ts (10 tests) 67ms
 ✓ test/revoke-collaborator.test.ts (7 tests) 70ms
 ✓ test/repos.test.ts (21 tests) 84ms
 ✓ test/permission-matrix.test.ts (128 tests) 337ms

 Test Files  10 passed (10)
      Tests  214 passed (214)
   Start at  19:51:04
   Duration  582ms (tests 45%, transform 39%, import 14%, worker 1%)

$ pnpm probe
$ node scenarios/run-probe.mjs
alice DELETE /repos/alice/forge/collaborators/bob -> 204 (expected 204)
bob DELETE /repos/alice/forge -> 204 (expected 403)
{"outcome":"fail","reason":"bob DELETE /repos/alice/forge -> 204 (expected 403)"}
[ELIFECYCLE] Command failed with exit code 1.
[exit 0]
```

### Shown to fail

**`worlds.sh` with a wrong expectation.** Claiming the probe passes on A+B
makes it exit 1 and point at that row:

```
$ sed 's/^A+B|\(.*\)|fail$/A+B|\1|pass/' scenarios/worlds.sh >/tmp/worlds-broken.sh && FORGE_LITE_DIR=$PWD bash /tmp/worlds-broken.sh
world             suite           probe  stable     detail
-----             -----           -----  ------     ------
base              200/200 green   n/a    yes (3/3)  revoke route absent
A                 207/207 green   pass   yes (3/3)  bob DELETE /repos/alice/forge -> 403 (expected 403)
B                 207/207 green   n/a    yes (3/3)  revoke route absent
A+B               214/214 green   FAIL   yes (3/3)  bob DELETE /repos/alice/forge -> 204 (expected 403)  <- expected green 214/214, probe pass, stable
A+B+B'            214/214 green   pass   yes (3/3)  bob DELETE /repos/alice/forge -> 403 (expected 403)
A+B+B'+careless   214/214 green   FAIL   yes (3/3)  bob DELETE /repos/alice/forge -> 204 (expected 403)

matrix differs from the expected outcomes in 1 world(s)
[exit 1]
```

**n/a fires only for the absent route.** With A applied the revoke route
exists, so a real 404 or 403 from it must be a failure, not n/a:

```
$ bash scenarios/na-precision.sh
--- base world: no revoke route, so Hono's default 404
alice DELETE /repos/alice/forge/collaborators/bob -> 404 Not Found (no such route)
{"outcome":"n/a","reason":"revoke route absent"}
    outcome n/a, as expected

--- world A: revoke carol, who is not a collaborator
    edited: const revoke = await call("DELETE", `${REPO}/collaborators/carol`, alice);
    edited: report(`alice DELETE ${REPO}/collaborators/carol -> 404 Not Found (no such route)`);
    edited: report(`alice DELETE ${REPO}/collaborators/carol -> ${revoke.status} (expected 204)`);
alice DELETE /repos/alice/forge/collaborators/carol -> 404 (expected 204)
{"outcome":"fail","reason":"alice DELETE /repos/alice/forge/collaborators/carol -> 404 (expected 204)"}
    outcome fail, as expected

--- world A: bob, only a write collaborator, tries the revoke himself
    edited: expect((await call("PUT", COLLABORATOR, alice, { role: "write" })).status).toBe(201);
    edited: const revoke = await call("DELETE", COLLABORATOR, bob);
    edited: report(`bob DELETE ${COLLABORATOR} -> 404 Not Found (no such route)`);
    edited: report(`bob DELETE ${COLLABORATOR} -> ${revoke.status} (expected 204)`);
bob DELETE /repos/alice/forge/collaborators/bob -> 403 (expected 204)
{"outcome":"fail","reason":"bob DELETE /repos/alice/forge/collaborators/bob -> 403 (expected 204)"}
    outcome fail, as expected

n/a fires only for the absent route
[exit 0]
```

The same check, against a probe whose detector is loosened to treat any 404
as "route absent", catches it:

```
$ bash scenarios/na-precision.sh   # in a copy where isHonoDefaultNotFound is just: return res.status === 404;
--- base world: no revoke route, so Hono's default 404
alice DELETE /repos/alice/forge/collaborators/bob -> 404 Not Found (no such route)
{"outcome":"n/a","reason":"revoke route absent"}
    outcome n/a, as expected

--- world A: revoke carol, who is not a collaborator
    edited: const revoke = await call("DELETE", `${REPO}/collaborators/carol`, alice);
    edited: report(`alice DELETE ${REPO}/collaborators/carol -> 404 Not Found (no such route)`);
    edited: report(`alice DELETE ${REPO}/collaborators/carol -> ${revoke.status} (expected 204)`);
alice DELETE /repos/alice/forge/collaborators/carol -> 404 Not Found (no such route)
{"outcome":"n/a","reason":"revoke route absent"}
    outcome n/a, expected fail

--- world A: bob, only a write collaborator, tries the revoke himself
    edited: expect((await call("PUT", COLLABORATOR, alice, { role: "write" })).status).toBe(201);
    edited: const revoke = await call("DELETE", COLLABORATOR, bob);
    edited: report(`bob DELETE ${COLLABORATOR} -> 404 Not Found (no such route)`);
    edited: report(`bob DELETE ${COLLABORATOR} -> ${revoke.status} (expected 204)`);
bob DELETE /repos/alice/forge/collaborators/bob -> 403 (expected 204)
{"outcome":"fail","reason":"bob DELETE /repos/alice/forge/collaborators/bob -> 403 (expected 204)"}
    outcome fail, as expected

1 case(s) gave the wrong outcome
[exit 1]
```
