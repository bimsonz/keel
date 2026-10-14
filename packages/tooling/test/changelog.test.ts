import { describe, expect, it } from "vitest";
import { foldFragments, parseFragment, release } from "../src/changelog.ts";

const CHANGELOG = [
  "# Changelog",
  "",
  "Intro.",
  "",
  "## Unreleased",
  "",
  "## 1.0.0 (1 Jan 2026)",
  "",
  "### Added",
  "",
  "- The first release.",
  "",
].join("\n");

const problems = (text: string) => parseFragment(text).problems;

describe("a changelog fragment", () => {
  it("[changelog.parse] reads each section's entries as written, and refuses a section it does not know, one written twice, text before the first heading, a section with no list item, and a file with no section", () => {
    expect(
      parseFragment(
        "### Fixed\n\n- **One.** First.\n  - its detail\n\n- Two.\n\n### Changed (breaking)\n\n- Three.\n",
      ),
    ).toEqual({
      entries: [
        ["Fixed", "- **One.** First.\n  - its detail\n\n- Two."],
        ["Changed (breaking)", "- Three."],
      ],
      problems: [],
    });
    expect(problems("### Improved\n\n- One.\n")).toEqual([
      {
        line: 1,
        message:
          "### Improved is not a changelog section (Changed (breaking), Added, Changed, Deprecated, Removed, Fixed, Security)",
      },
    ]);
    expect(problems("### Added\n\n- One.\n\n### Added\n\n- Two.\n")).toEqual([
      { line: 5, message: "### Added is written twice" },
    ]);
    expect(problems("A note.\n\n### Added\n\n- One.\n")).toEqual([
      { line: 1, message: 'text before the first "### <section>" heading' },
    ]);
    expect(problems("### Added\n\nA sentence.\n")).toEqual([
      { line: 1, message: '### Added holds no entry: its first line must be a "- " list item' },
    ]);
    expect(problems("## Added\n\n- One.\n")).toEqual([
      { line: 1, message: '## Added is not a "### <section>" heading' },
    ]);
    expect(problems("\n\n")).toEqual([{ line: 1, message: 'names no "### <section>" heading' }]);
  });
});

describe("folding fragments", () => {
  it("[changelog.fold] prints each section once, in the release's order, with every fragment's entries in file-name order", () => {
    expect(
      foldFragments([
        { name: "b.md", text: "### Fixed\n\n- B fixed.\n\n### Added\n\n- B added.\n" },
        { name: "a.md", text: "### Added\n\n- A added.\n  - its detail\n" },
        { name: "c.md", text: "### Changed (breaking)\n\n- C broke.\n" },
        { name: "broken.md", text: "### Improved\n\n- Not folded.\n" },
      ]),
    ).toBe(
      [
        "### Changed (breaking)",
        "",
        "- C broke.",
        "",
        "### Added",
        "",
        "- A added.",
        "  - its detail",
        "",
        "- B added.",
        "",
        "### Fixed",
        "",
        "- B fixed.",
      ].join("\n"),
    );
  });

  it("[changelog.release] writes the folded sections under the version's heading, below an Unreleased heading left empty, and refuses a changelog whose Unreleased section holds anything", () => {
    const released = release(CHANGELOG, "1.1.0", "14 Oct 2026", [
      { name: "a.md", text: "### Added\n\n- A added.\n" },
    ]);
    expect(released).toBe(
      [
        "# Changelog",
        "",
        "Intro.",
        "",
        "## Unreleased",
        "",
        "## 1.1.0 (14 Oct 2026)",
        "",
        "### Added",
        "",
        "- A added.",
        "",
        "## 1.0.0 (1 Jan 2026)",
        "",
        "### Added",
        "",
        "- The first release.",
        "",
      ].join("\n"),
    );
    expect(() =>
      release(
        released.replace("## Unreleased\n", "## Unreleased\n\n- Written here.\n"),
        "1.2.0",
        "15 Oct 2026",
        [{ name: "b.md", text: "### Fixed\n\n- B.\n" }],
      ),
    ).toThrow(/Unreleased section holds line 7/);
    expect(() => release(CHANGELOG, "1.1.0", "14 Oct 2026", [])).toThrow(/no fragment/);
    expect(() => release("# Changelog\n", "1.1.0", "14 Oct 2026", [])).toThrow(
      /no "## Unreleased" heading/,
    );
  });
});
