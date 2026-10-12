# Tenancy: the authorization policy

One Keel instance hosts many orgs, isolated logically: one authorization policy, keys and quotas. Users, sessions, orgs, memberships and invitations live in D1, owned by Better Auth, so the domain has no aggregates for them. It has the pure policy, `authorize` in `packages/core/src/domain/identity/authorize.ts`, which decides every request from its arguments alone. The gate fills them from the request and the Memberships port; authorization never reads events.

## Principals

| Principal | Built from | Notes |
|---|---|---|
| User | A Better Auth session, plus the user's memberships (org and role) | `handle` is absent until the user chooses one; `suspended` |
| Agent | A Keel JWT: its org, its one project and its scopes, plus its sponsor's standing | The sponsor is the user who minted the credential: its role in the agent's org (absent once it left) and whether it is suspended |
| Anonymous | No credential | Reads public projects only |

Roles nest: `owner` ⊃ `maintainer` ⊃ `member`. The `operator` and `observer` scopes confer nothing.

## Resources and needs

Each action names the kind of resource it is decided on (`Instance`, `Self`, `Org`, `Project` or `Fork`) and what it needs of the caller. `ACTIONS` lists every operation in the spec and the actions that are not operations (Better Auth's org management, the git routes, the instance admin's moves). `[authz.spec-covered]` holds the spec's list and the policy's equal.

| Need | Granted to |
|---|---|
| `anyone` | Everyone |
| `self` | Any user or agent, on its own record |
| `user` | Any user |
| `handle` | Any user, even one without a handle |
| `read` | Anyone who can see the project or org: its members (and its agent, on its own project) with the members' audience, everyone else the public's |
| `readMembers` | The org's members, and an agent on its own project |
| `work` | An agent on its own project, holding `agent:work`, whose sponsor is a member |
| `workOrMaintain` | That, or a maintainer |
| `member`, `maintain`, `own` | A user with that role or above in the org |
| `sponsorOrMaintain` | The sponsor of the agent the action concerns, or a maintainer |

## Answers, in order

1. A suspended user is refused everything (`user-suspended`). A user without a handle may only choose one (`handle-required`). An agent whose sponsor is suspended is refused everything (`sponsor-suspended`).
2. Anonymous is granted `anyone` and public reads, and is 401 (`AuthenticationRequired`, with next actions) for anything else.
3. Work asked by a user is `agents-only`; governance asked by an agent is `users-only`. An agent whose sponsor left its org may do nothing there (`sponsor-left`).
4. What the caller cannot see is 404 (`NotVisible`, with no fields): a missing project, a private project of an org the caller is not in, and anything of a suspended org to an outsider. The gate answers the operation's own not-found, so the two read the same. An org's insiders are told it is suspended (`org-suspended`).
5. An agent asking about a project of its org that is not its own is `foreign-project` (403); a public project of any org it may read, as the public.
6. Otherwise the role decides (`role`, with who to ask), or the agent's scope (`scope`).

Managing an org's members (inviting, removing, moving one between member and maintainer) needs a maintainer; making or unmaking an owner, and deleting the org, need an owner.

A fork (`Fork {source, target}`) is granted when the caller can read the source and is a member of the target org. A private source forks only within its own org (`private-source`); an outsider gets the source's NotVisible.

Every 401 and 403 names at least one next action.
