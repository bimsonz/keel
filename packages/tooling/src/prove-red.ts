// What `scripts/prove-red.ts` adds to a mutant's command so that it runs only
// the tests the mutant claims to kill. Pure: the script does the running.

const escaped = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** Whether a command already says which tests to run, by `-t` or `--testNamePattern`. */
const namesItsTests = (command: string): boolean =>
  /(?:^|\s)(?:-t|--testNamePattern)(?:[\s=]|$)/.test(command);

/** A vitest name pattern matching exactly the titles that carry one of these tags as `[tag]`. */
export function claimedPattern(kills: readonly string[]): string {
  return kills.map((tag) => escaped(`[${tag}]`)).join("|");
}

/**
 * The command narrowed to the tests it claims: `-t '<pattern>'` appended,
 * quoted for the shell. A command with no claims, or one that already names
 * its tests, comes back as written.
 */
export function filteredToClaims(command: string, kills: readonly string[]): string {
  if (kills.length === 0 || namesItsTests(command)) return command;
  return `${command} -t ${quoted(claimedPattern(kills))}`;
}
