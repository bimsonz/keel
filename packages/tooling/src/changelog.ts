/**
 * Changelog fragments. Each change describes itself in a file of its own under
 * `changes/unreleased/`, so changes made side by side never edit the same lines
 * of CHANGELOG.md. A release folds the fragments into CHANGELOG.md under a new
 * heading, and CHANGELOG.md's `## Unreleased` section stays empty between
 * releases.
 */

/** Where the fragments of the next release are kept, from the repository's root. */
export const FRAGMENTS = "changes/unreleased";

/** The sections a fragment may write under, in the order a release prints them. */
export const SECTIONS = [
  "Changed (breaking)",
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
] as const;
export type Section = (typeof SECTIONS)[number];

const isSection = (name: string): name is Section => (SECTIONS as readonly string[]).includes(name);

export interface FragmentProblem {
  /** 1-based. */
  readonly line: number;
  readonly message: string;
}

export interface ParsedFragment {
  /** Each section the fragment writes under, with its entries as written. */
  readonly entries: readonly (readonly [Section, string])[];
  readonly problems: readonly FragmentProblem[];
}

const trimBlankLines = (lines: readonly string[]): string[] => {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end);
};

/**
 * Reads a fragment: one or more `### <section>` headings, each followed by its
 * entries as a Markdown list. Nothing may come before the first heading, a
 * section may not repeat, and each must hold at least one `- ` entry.
 */
export function parseFragment(text: string): ParsedFragment {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const entries: (readonly [Section, string])[] = [];
  const problems: FragmentProblem[] = [];
  let open:
    | { readonly section: Section; readonly line: number; readonly body: string[] }
    | undefined;
  /** Whether a heading has been read: the lines under one refused are its own, not a preamble. */
  let headed = false;
  const close = (): void => {
    if (open === undefined) return;
    const body = trimBlankLines(open.body);
    if (body.length === 0 || !body[0]?.startsWith("- "))
      problems.push({
        line: open.line,
        message: `### ${open.section} holds no entry: its first line must be a "- " list item`,
      });
    else entries.push([open.section, body.join("\n")]);
    open = undefined;
  };
  lines.forEach((written, index) => {
    const line = index + 1;
    if (written.startsWith("#")) {
      close();
      headed = true;
      const heading = /^### (.+?)\s*$/.exec(written)?.[1];
      if (heading === undefined)
        problems.push({ line, message: `${written.trim()} is not a "### <section>" heading` });
      else if (!isSection(heading))
        problems.push({
          line,
          message: `### ${heading} is not a changelog section (${SECTIONS.join(", ")})`,
        });
      else if (entries.some(([section]) => section === heading))
        problems.push({ line, message: `### ${heading} is written twice` });
      else open = { section: heading, line, body: [] };
      return;
    }
    if (open !== undefined) open.body.push(written);
    else if (!headed && written.trim() !== "")
      problems.push({ line, message: 'text before the first "### <section>" heading' });
  });
  close();
  if (entries.length === 0 && problems.length === 0)
    problems.push({ line: 1, message: 'names no "### <section>" heading' });
  return { entries, problems };
}

export interface Fragment {
  /** The file's name, which orders fragments within a section. */
  readonly name: string;
  readonly text: string;
}

/**
 * The sections a release prints for these fragments: each section in
 * `SECTIONS` order, its entries in fragment-name order, one blank line apart.
 * A fragment with problems is not folded; the guard reports it first.
 */
export function foldFragments(fragments: readonly Fragment[]): string {
  const bySection = new Map<Section, string[]>();
  for (const fragment of fragments.toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const parsed = parseFragment(fragment.text);
    if (parsed.problems.length > 0) continue;
    for (const [section, body] of parsed.entries)
      bySection.set(section, [...(bySection.get(section) ?? []), body]);
  }
  return SECTIONS.filter((section) => bySection.has(section))
    .map((section) =>
      [`### ${section}`, "", (bySection.get(section) ?? []).join("\n\n")].join("\n"),
    )
    .join("\n\n");
}

const UNRELEASED = "## Unreleased";

/**
 * CHANGELOG.md with the fragments folded in under `## <version> (<date>)`,
 * right below the empty `## Unreleased` heading, which stays for the next
 * release. Fails when the changelog has no `## Unreleased` heading, when it
 * holds anything, or when no fragment is left to fold.
 */
export function release(
  changelog: string,
  version: string,
  date: string,
  fragments: readonly Fragment[],
): string {
  const lines = changelog.split("\n");
  const at = lines.indexOf(UNRELEASED);
  if (at < 0) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" heading`);
  let next = at + 1;
  while (next < lines.length && !lines[next]?.startsWith("## ")) {
    if (lines[next]?.trim() !== "")
      throw new Error(
        `CHANGELOG.md's Unreleased section holds line ${next + 1}: move it to a fragment first`,
      );
    next += 1;
  }
  const body = foldFragments(fragments);
  if (body === "") throw new Error(`no fragment in ${FRAGMENTS} to release`);
  return [
    ...lines.slice(0, at + 1),
    "",
    `## ${version} (${date})`,
    "",
    body,
    "",
    ...lines.slice(next),
  ].join("\n");
}
