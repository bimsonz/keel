import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entryName } from "./agent-key.ts";
import type { ExitCode, Io } from "./run.ts";

/** The tools whose use a note follows: every one that reads or writes a file. */
export const FILE_TOOLS = "Read|Edit|MultiEdit|Write|NotebookEdit";

/** Claude Code's own limit on each hook, in seconds: a backstop behind the hook's shorter deadline. */
const TIMEOUT_S = 10;

/** A run label as Keel takes one. */
const RUN_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** A command this CLI wrote, by the hook it runs. */
const OURS = /(?:^|\s)keeltown hook (?:post-tool-use|session-start)(?:\s|$)/u;

interface Group {
  readonly matcher?: string;
  readonly hooks: readonly {
    readonly type: string;
    readonly command: string;
    readonly timeout: number;
  }[];
}

const isOurs = (group: unknown): boolean => {
  const hooks: unknown = Reflect.get(Object(group), "hooks");
  return (
    Array.isArray(hooks) &&
    hooks.some((hook) => {
      const command: unknown = Reflect.get(Object(hook), "command");
      return typeof command === "string" && OURS.test(command);
    })
  );
};

/**
 * `hooks install`: turns Keel's hooks on for Claude Code in a clone, in its
 * `.claude/settings.local.json`, the settings Claude Code keeps for this
 * machine alone. Each hook is a `keeltown hook` command naming Keel, the
 * profile and the run, so the CLI mints a token as each hook runs: no
 * credential is ever written. Running it again replaces the hooks it wrote
 * and leaves every other setting and hook as it was.
 */
export async function installHooks(
  io: Io,
  options: {
    readonly baseUrl: string;
    readonly dir: string;
    readonly profile?: string | undefined;
    readonly run?: string | undefined;
  },
): Promise<ExitCode> {
  // The profile is checked as every command checks it; a bad one throws the CLI's own KeyError.
  entryName(options.baseUrl, options.profile);
  if (options.run !== undefined && !RUN_LABEL.test(options.run)) {
    io.stderr("--run takes a run label: lower-case letters, digits, '.', '_' and '-', 64 at most");
    return 2;
  }
  if (/['\s]/u.test(options.baseUrl)) {
    io.stderr("KEEL_URL holds a quote or a space: it is not an address a hook can name");
    return 2;
  }
  const top = await io.exec?.("git", ["-C", options.dir, "rev-parse", "--show-toplevel"]);
  if (top === undefined || top.code !== 0) {
    io.stderr(
      `${options.dir} is not in a git clone: run \`keeltown hooks install\` in the clone of a Keel project`,
    );
    return 2;
  }
  const file = join(top.stdout.trim(), ".claude", "settings.local.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = Object(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ENOENT") {
      io.stderr(
        `${file} is not JSON this command can add to: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 2;
    }
  }
  const command = (event: string) =>
    [
      `KEEL_URL='${options.baseUrl}' keeltown hook ${event}`,
      ...(options.profile === undefined ? [] : [`--profile '${options.profile}'`]),
      ...(options.run === undefined ? [] : [`--run '${options.run}'`]),
    ].join(" ");
  const ours: Record<string, Group> = {
    PostToolUse: {
      matcher: FILE_TOOLS,
      hooks: [{ type: "command", command: command("post-tool-use"), timeout: TIMEOUT_S }],
    },
    SessionStart: {
      hooks: [{ type: "command", command: command("session-start"), timeout: TIMEOUT_S }],
    },
  };
  const hooks: Record<string, unknown> = Object(settings["hooks"] ?? {});
  for (const [event, group] of Object.entries(ours)) {
    const theirs: unknown = hooks[event];
    hooks[event] = [...(Array.isArray(theirs) ? theirs.filter((g) => !isOurs(g)) : []), group];
  }
  mkdirSync(join(top.stdout.trim(), ".claude"), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  io.stdout(
    `Keel's hooks are on for Claude Code in ${file}: a session starts with Keel's primer, and reading or editing a file a decision is anchored in brings its note. Each hook mints its own token from this machine's key; none is written.`,
  );
  return 0;
}
