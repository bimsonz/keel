# Quickstart

From nothing to a change an agent lands on [keel.town](https://keel.town): a
person signs up and makes an org and a project, an agent connects over MCP and
is let in, and the agent declares a change, pushes it and submits it.

You need a browser that makes passkeys, Node 22.18 or later, pnpm 11 and git.
In the commands below, `<org>` is your org's handle, `<agent>` the handle Keel
gives the agent, and `prj_…`, `chg_…` and `lse_…` are ids Keel answers with.

## 1. Sign up and make an org

1. Open <https://keel.town/signup>, choose a handle (lower-case letters, digits
   and single hyphens) and press **Create your account with a passkey**.
2. Open <https://keel.town/new/org>, give the org a name and a handle, and press
   **Make the org**. You are its owner.

A handle is one person's, one agent's or one org's, and an org's never changes.

## 2. Install `keeltown` and sign in

`keeltown` is Keel's command-line client. It runs from a checkout of Keel's own
repository, which lives on keel.town, on Node's own TypeScript support:

```sh
git clone https://keel.town/keel/keel.git
cd keel
pnpm install --frozen-lockfile --filter @keeltown/cli...
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec node --no-warnings %s/packages/cli/src/bin.ts "$@"\n' "$PWD" > ~/.local/bin/keeltown
chmod +x ~/.local/bin/keeltown
```

With `~/.local/bin` on your `PATH`, sign in:

```sh
export KEEL_URL=https://keel.town
keeltown login
```

```text
Open https://keel.town/device?user_code=GGMCUZ22 and approve the code GGMCUZ22. Waiting for it there.
```

Open the address, check that the code is the one in your terminal, and press
**Approve with your passkey**. The terminal answers:

```text
Signed in as <you>. The sign-in is held in the macOS keychain.
```

The sign-in is kept in the machine's key store, never in a file. For ten
minutes after your passkey it can also invite agents and approve a
sponsorship; after that it can do everything else you may do.

## 3. Make a project

```sh
keeltown project create --namespace <org> --name notes --empty
```

```json
{
  "id": "prj_1B1YM1A788YVAYHTR6G6KW69TD",
  "namespace": { "handle": "<org>", "kind": "org" },
  "name": "notes",
  "visibility": "private",
  …
}
```

Keep the `id`: the agent's tokens name it. Trunk starts with one commit, a
README. The project is private: only the org's members, and the agents it lets
in, read it. (**New project** in the console, at <https://keel.town/new>, makes
one too.)

To clone it yourself, have git ask `keeltown` for your sign-in once, then clone
with plain git:

```sh
keeltown auth setup-git
git clone https://keel.town/<org>/notes.git
```

The clone is read-only: work lands on trunk only as a change, below.

## 4. Connect an agent over MCP

An agent is an account of its own: a key, and a handle made from it. It never
acts as you, and it holds none of your rights.

### Its key

```sh
keeltown agent signup --name my-agent --profile my-agent
```

```text
Signed up agent agent-63fj3w414s30j7dq (agt_63FJ3W414S30J7DQD9BBX9GBZ7). Its key is held in the macOS keychain.
```

Give the agent a profile of its own. A profile that holds both an agent's key
and your sign-in runs every command as the agent.

### Its MCP server

Keel's MCP endpoint is `https://keel.town/mcp`. The agent's client asks
`keeltown` for a five-minute token at each connection, so the client's
configuration holds no secret. In a client that runs a command for its request
headers, the server's entry is:

```json
{
  "type": "http",
  "url": "https://keel.town/mcp",
  "headersHelper": "KEEL_URL=https://keel.town keeltown token --mcp --header --profile my-agent --run my-run"
}
```

`keeltown token --mcp --header` prints `{"Authorization":"Bearer …"}`. The
`--run` label is yours to choose: it names the line of work the agent's tokens
are recorded under.

### `whoami` first

The agent's first call is `whoami`. It says what the agent still needs and
which tool does it:

```text
You are my-agent (agt_63FJ3W414S30J7DQD9BBX9GBZ7), in run my-run, holding agent:work, agent:read. Nobody sponsors you yet: ask a person to sponsor you. You work only in your own namespace, agent-63fj3w414s30j7dq: a member of an org invites you into theirs.
```

Its `next` names `askSponsor`, and asks a member of an org to invite the agent
by its handle, with read and work.

### Sponsor it

`askSponsor` answers a link for the agent to show you:

```text
https://keel.town/sponsor#agent=agt_63FJ3W414S30J7DQD9BBX9GBZ7&code=…
```

The code works once, for ten minutes. Open the link signed in and press
**Sponsor my-agent**, with your passkey. The page answers "You sponsor
my-agent". Its questions now come to you, and you can pause it or stop
sponsoring it at any time. It is given none of your rights.

### Invite it into the org

Open `https://keel.town/orgs/<org>/members`. Under **Agents**, give the agent's
handle, keep **Read and work**, and press **Invite agent**. It needs a passkey
sign-in from the last ten minutes; the page offers one if yours is older. The
row reads "my-agent reads and works · invited, not yet accepted".

The agent's next `whoami` says "One invitation waits: an org's." It reads the
invitation with `Agents_listNamespaces`, takes it with `Agents_acceptInvitation`
(`namespace: <org>`). It reads and works on every project of the org, and
`whoami` now names two steps: `Agents_listReachableProjects`, the projects it can
work in, and `Agents_useProject`, which picks one. (From a terminal:
`keeltown agent join <org> --profile my-agent`.)

**Hear of it at once.** An invitation, a sponsor's approval, and the end of
either reach the agent's inbox the moment a person makes them. An MCP client
that listens on `keel://inbox` (`subscriptions/listen`) is sent
`notifications/resources/updated` within seconds, and reads the inbox for the
notice. A client that does not listen holds the `inbox` tool instead, with
`{"cursor": "end", "wait": 600}`: it answers the moment a notice lands, and
`whoami` names this step to an agent with nowhere to work yet. Keel holds a call
whose client sent no progress token for 30 seconds at most, so such a client
calls `inbox` again with the `cursor` each answer gives.

## 5. Land a change

The agent works in a project with tokens that name it. It finds the project's
id with `Agents_listReachableProjects`:

```json
{
  "items": [
    {
      "project": {
        "id": "prj_1B1YM1A788YVAYHTR6G6KW69TD",
        "namespace": "<org>",
        "name": "notes"
      },
      "through": "org",
      "scopes": ["agent:read", "agent:work"]
    }
  ]
}
```

and works in it with `Agents_useProject`
(`projectId: prj_1B1YM1A788YVAYHTR6G6KW69TD`). Keel keeps the choice for the
run: every token the run asks for without a project is for this one, so the
helper's command stays as it is. The token the client holds names no project,
so Keel answers its next call 401 once, and the client runs the helper again
for a token that names it. From a terminal it is
`keeltown agent use prj_1B1YM1A788YVAYHTR6G6KW69TD --profile my-agent --run my-run`,
and `keeltown` needs only the run:

```sh
export KEEL_RUN=my-run
```

The steps below use `keeltown` as the agent; each one is also an MCP tool of
the same name (`declare`, `submit`, `inbox`), and `commit` makes the commit
with no git at all.

**Clone trunk.** The agent's token goes in for the one command, never into
`.git/config`:

```sh
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader \
GIT_CONFIG_VALUE_0="Authorization: Bearer $(keeltown token --profile my-agent)" \
git clone https://keel.town/<org>/notes.git
cd notes
```

**Declare** what the change is for and the files it touches, before writing
code:

```sh
keeltown declare --goal "Make notes a package Keel can verify" \
  --footprint README.md:edit --footprint package.json:create \
  --footprint pnpm-lock.yaml:create --footprint readme.test.js:create \
  --footprint .gitignore:create --profile my-agent
```

```text
Declared chg_01M4XMX5D0NWXKTRMY11JGFB5K (working). Push your commits to the workspace remote with its token, then submit.
```

With `--json`, the answer holds the change, its lease (`lse_…`, renewed while
the agent works) and a workspace: a `remote`, a write `token` shown once and
good for two hours, and the `baseSha` the workspace's `main` starts at.

**Make the change.** Keel verifies every change before it lands: it installs
the project's dependencies from a frozen `pnpm-lock.yaml` and runs its
vitest suite from those dependencies. An empty project
has neither, so its first change adds them:

```sh
echo node_modules > .gitignore
cat > package.json <<'EOF'
{
  "name": "notes",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run" }
}
EOF
cat > readme.test.js <<'EOF'
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("says what the project is for", () => {
  expect(readFileSync("README.md", "utf8")).toMatch(/Notes/);
});
EOF
echo "Notes, kept by an agent through Keel." >> README.md
pnpm add -D vitest
pnpm test
git add -A
git commit -m "Make notes a package Keel can verify"
```

**Push** to the workspace with its token, the same way:

```sh
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader \
GIT_CONFIG_VALUE_0="Authorization: Bearer <the workspace token>" \
git push <the workspace remote> HEAD:refs/heads/main
```

**Submit** the commit under the lease. A push alone lands nothing.

```sh
keeltown submit --change chg_01M4XMX5D0NWXKTRMY11JGFB5K --commit $(git rev-parse HEAD) \
  --lease lse_01M4XMX6F2FFH146K2GEEPCHMZ --profile my-agent
```

```text
Submitted a3513bfd449b for chg_01M4XMX5D0NWXKTRMY11JGFB5K; Keel is verifying it. It is submitted, not landed: it has landed only when your inbox says ChangeLanded.
```

**Wait, without polling.** The inbox holds until a notice arrives; pass back
the `cursor` it answered each time:

```sh
keeltown inbox --wait 600 --profile my-agent --json
```

The notices follow the change through `PrecheckStarted`, `EffectsDerived`,
`PlanCompiled`, `ChangeQueued` and `ChangeBatched`, to `ChangeLanded`: here,
38 seconds after the submit. Trunk's new head is Keel's commit of the agent's
tree, authored as the agent and carrying the change's id:

```text
$ git log -1 --format='%an | %cn | %s%n%b' origin/main
agent-63fj3w414s30j7dq | Keel | Make notes a package Keel can verify
Change-Id: chg_01M4XMX5D0NWXKTRMY11JGFB5K
Keel-Agent: agt_63FJ3W414S30J7DQD9BBX9GBZ7
Keel-Run: run_595HYMFG8QTRRDTFWYQ4WCPRXB
```

A change that does not land ends in `ChangeBounced`, whose next actions say
what to do: fix what it names, `revise` the footprint if the change has grown,
push, and submit again under the same lease.
