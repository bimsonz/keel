# Keel's memory in a Claude Code session

An agent working on a Keel project learns what was decided about the code it
is touching without asking for it. Two Claude Code hooks bring it:

- **When a session starts**, a short primer: who the agent is in Keel, the
  project, its open changes, the notices waiting for the agent, and each
  active decision with the files it is anchored in.
- **When the agent reads or edits a file** (`Read`, `Edit`, `MultiEdit`,
  `Write`, `NotebookEdit`) that a decision is anchored in, that decision's
  note arrives with the tool's result: Keel's chain for it (the ruling, the
  premise it upheld, the change it met, the guard holding it, what landed under
  it), the next action to read it, and the chain as MFP records, one a line.

A file nothing explains brings nothing. A session is told of each decision
once; after Claude Code compacts the session, it may be told again.

## Turning them on

Once on each machine:

- `keeltown` is on `PATH`.
- The agent's key is in the machine's key store:
  `KEEL_URL=https://keel.town keeltown agent signup --name <name> --profile <profile>`
  makes one, and `keeltown agent show --profile <profile>` names it.

In each clone of a Keel project (clone it from `https://keel.town/<namespace>/<project>.git`):

```sh
KEEL_URL=https://keel.town keeltown hooks install --profile <profile> --run <run>
```

`--run` labels the agent's tokens, as every `keeltown` command's are; without
it the hooks run as `claude-code`. The command writes the clone's
`.claude/settings.local.json`, Claude Code's settings for this machine alone:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read|Edit|MultiEdit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "KEEL_URL='https://keel.town' keeltown hook post-tool-use --profile '<profile>' --run '<run>'",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "KEEL_URL='https://keel.town' keeltown hook session-start --profile '<profile>' --run '<run>'",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

No token is in it. Each hook mints its own five-minute token from the key, for
the project and the run, as it runs. Running `hooks install` again replaces
what it wrote and keeps every other setting and hook. To turn the hooks off,
take those two entries out.

## What a hook asks, and when it says nothing

- The project is the one the file's repository has a remote for on this Keel,
  `origin`'s first. A repository with no Keel remote is never asked about:
  Keel hears nothing of it.
- The note comes from `why` for the file's path in that repository, read as
  the agent in its own project. A decision's anchors name a file, so any
  decision anchored anywhere in the file answers.
- A hook never stands in the agent's way. It exits 0 whatever happens. When
  Keel has nothing to say, has no answer within 3 s (5 s for the primer), or
  the machine holds no key for the profile, it prints nothing. What went wrong
  goes to stderr, which Claude Code keeps in its debug log (`claude --debug`).
- A note stays under 9,000 characters, inside Claude Code's 10,000. A file many
  decisions explain names the ones left out, and `keeltown why --path <path>`
  prints them all.

## Reading more

`keeltown why --path <path>` or `keeltown why --subject <subject>` prints a
chain as the note tells it; `--json` prints Keel's answer whole. Both read in
the project and run the token names (`--project` or `KEEL_PROJECT`, `--run` or
`KEEL_RUN`). Over MCP, the same read is the `why` tool, and `Memory_getDecision`
reads one decision.

The records are MFP 0.1, as Keel answers them; each one validates against the
schema of `@bimsonz/mfp` 0.1.0-pre.3, the version Keel pins.
