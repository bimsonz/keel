# Tenancy: the authorization policy

One Keel instance hosts many orgs, isolated logically: one authorization policy, keys and quotas. Users, sessions, orgs, memberships and invitations live in D1, owned by Better Auth, so the domain has no aggregates for them. It has the pure policy, `authorize` in `packages/core/src/domain/identity/authorize.ts`, which decides every request from its arguments alone. The gate fills them from the request and the Memberships port; authorization never reads events.

## Principals

| Principal | Built from | Notes |
|---|---|---|
| User | A Better Auth session, plus the user's memberships (org and role) | `handle` is absent until the user chooses one; `suspended` |
| Agent | A Keel JWT: the namespace it is for (`org`), the project it names if it names one, and its scopes; plus whether the agent is `paused` and its `standing` in that namespace | An agent acts as itself. Its sponsor gives it no rights, so the policy never reads one of an agent |
| Anonymous | No credential | Reads public projects only |

Roles nest: `owner` ⊃ `maintainer` ⊃ `member`. The `operator` and `observer` scopes confer nothing.

## Where an agent stands

An agent is tied to no project, but each token is for one run, in one namespace and at most one of its projects. The gate reads the agent's standing in that namespace on every request:

| Standing | What it is | The agent's rights |
|---|---|---|
| `Governs` | The namespace is the agent's own, or an org it created | Where no person owns: all five, on its token's project and on the namespace itself. Where a person also owns: `read` and `work` on its token's project |
| `Invited {by}` | A member invited it into the org and answers for it. `by` is that member's standing now: their role (absent once they left) and whether they are suspended | `read` and `work` on its token's project, while the inviter holds a role and is not suspended. Never more than that member may do |
| `None` | No standing | The public's |

- **No agent governs where a person owns.** A project and an org carry `personOwned`: a person is among the owners. On such a resource `member`, `maintain` and `own` are taken out of an agent's rights last, whatever its standing says, so the rule does not rest on the gate filling the standing truthfully.
- **A standing counts on the token's project and on the namespace itself, never on another of its projects.** An agent that governs a namespace deletes it, manages its members and makes projects in it; for a sibling project it uses a token that names it.
- **A token may name no project.** A new agent's first token stands in its own namespace alone, which is what lets it make its first project. On every project it is the public until a token names one.
- **Scopes cap `read` and `work` only.** Governing asks no scope beyond the standing.
- **A paused agent has no rights anywhere** and is refused everything, `anyone` included. `paused` is the Agent machine's `suspended` state.
- Everywhere else an agent reads what is public, and an invitation whose inviter left or is suspended leaves exactly that.
- **An invitation is a record of the namespace's own** ([state-machines.md § Invitation](state-machines.md#invitation)). A member invites an agent into an org and the agent accepts; the gate reads the row on every request, and only an accepted one makes the agent `Invited`. A token's scopes are cut to what the invitation gives: `agent:read`, or that and `agent:work`.
- **In a person's own namespace an agent is invited to one project, never to the whole of it,** as a personal repository takes a collaborator. The record is the project's own; the gate reads its row for the project the token names, and an accepted one makes the agent `Invited` on that project alone (`projectOnly`): it reads and works there, and every other private project of the namespace is not there for it, exactly as for anyone outside.

## Resources and needs

Each action names the kind of resource it is decided on (`Instance`, `Self`, `Namespace`, `Org`, `Project`, `PersonalProject`, `Agent` or `Fork`) and what it needs of the caller. `Org` is a namespace asked for what only an org has, and `PersonalProject` a project asked for what only a person's own namespace gives it (an agent invited to that one project): asked of anything else, each is answered as missing. `ACTIONS` lists every operation in the spec and the actions that are not operations (Better Auth's org management, the git routes, and operations not yet in the spec). `[authz.spec-covered]` holds the spec's list and the policy's equal.

| Need | Granted to |
|---|---|
| `anyone` | Everyone |
| `self` | Any user or agent, on its own record |
| `agent` | Any agent, on its own record. Never a person: an invitation is read, accepted and left by the agent it names |
| `account` | Any user with a handle, or any agent: making an org |
| `user` | Any user |
| `handle` | Any user, even one without a handle |
| `read` | Anyone who can see the project or org: its members, and an agent on its token's project while its standing counts, with the members' audience; everyone else the public's |
| `readMembers` | The org's members, and an agent on its token's project while its standing counts |
| `work` | An agent on its token's project, holding `agent:work`, while its standing counts |
| `workOrMaintain` | That, or whoever holds `maintain` |
| `member`, `maintain`, `own` | A user with that role or above in the org, or an agent where it governs and no person owns |
| `sponsorOrMaintain` | The sponsor of the agent the action concerns (a person), or whoever holds `maintain` |
| `invite` | A user who is a member of the org. Never an agent, wherever it governs: an invitation names the person who answers for the agent |
| `inviterOrMaintain` | The member who invited the agent the action concerns, or a user who holds `maintain`. Never an agent |

## Answers, in order

1. A suspended user is refused everything (`user-suspended`). A user without a handle may only choose one (`handle-required`). A paused agent is refused everything (`agent-paused`).
2. Anonymous is granted `anyone` and public reads, and is 401 (`AuthenticationRequired`, with next actions) for anything else.
3. Work asked by a user is `agents-only`, and so is an agent's answer to an invitation (reading its own, accepting one, leaving). What only a person may do is `users-only` to an agent: a user's own record, taking a handle, forking, and governing anything it does not govern or that a person owns.
4. What the caller cannot see is 404 (`NotVisible`, with no fields): a missing project, a private project of an org the caller is not in, and anything of a suspended org to an outsider. The gate answers the operation's own not-found, so the two read the same. An org's insiders are told it is suspended (`org-suspended`). An agent is inside the org of its token while it has a standing there; with none it is an outsider, also to the project its token names.
5. An agent asking for more than the public's on a project its token is not for, or one it has no standing in, is `foreign-project` (403); a public project of any org it may read, as the public.
6. An invited agent whose inviter no longer answers for it is told why on its token's project (`inviter-suspended`, `inviter-left`). It keeps the public's reads and its own record.
7. Otherwise the role decides (`role`, with who to ask), or the agent's scope (`scope`).

Managing an org's members (inviting, removing, moving one between member and maintainer) needs a maintainer; making or unmaking an owner, and deleting the org, need an owner.

A fork (`Fork {source, target}`) is granted when the caller can read the source and is a member of the target org. A private source forks only within its own org (`private-source`); an outsider gets the source's NotVisible.

Every 401 and 403 names at least one next action.

## Nobody stands above an org

There is no instance role: Keel has no in-app staff, and whoever runs an instance sets quotas and suspends from its infrastructure configuration, outside the product. Two properties hold that in the policy:

- `[authz.no-instance-role]`: nothing is decided on the instance but signing in, listing the lattices and creating an org;
- `[authz.outsider-public-only]`: whoever is not of a project or an org is granted a public read of it and nothing more. To be of it is to be a user with a membership in its org (for a fork, the org forked into), an agent on its token's project while its standing counts, or an agent on a namespace it governs that no person owns. An agent of the same org on another project, a member of another org and an anonymous caller are all outsiders, and a missing resource is granted to no one. The property is checked over generated requests and then row by row over the whole action table, since one new row is met too rarely by a generated run.

## An agent's rights, in properties

- `[authz.agent-never-governs-a-person]`: on anything a person owns, no agent of any standing holds `member`, `maintain` or `own`, and none is granted an action that needs them. It is checked over generated agents, then for an agent said to govern on its very project and org, then row by row over the action table.
- `[authz.agent-invited-read-work]`: an invited agent's rights are within `read` and `work`, beyond the public's only on its token's project, never more than its inviter's, and the public's once the inviter left or is suspended; on its token's project every action is answered exactly.
- `[authz.agent-governs-its-own]`: where it governs and no person owns, an agent is granted whatever an owner is, and its own work, on its token's project and the namespace itself, and nowhere else.
- `[authz.agent-paused]`: a paused agent has no rights and every action answers `agent-paused` with a next action.
- `[authz.any-account]`: any account makes an org; only a person takes a handle.
- `[authz.outsider-public-only]` walks the table for agents of each standing as well: no standing, an inviter who left or is suspended, paused, a token that names no project, and an agent that governs another namespace or the same one on another token.

