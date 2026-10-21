/**
 * The tests a JUnit XML report names: the format vitest
 * (`--reporter=junit`), pytest (`--junitxml`), go-junit-report and
 * cargo-nextest all write, whatever the language. Core has no DOM, so this
 * reads only what a verdict cites, by scanning tags: each `<testcase>` is one
 * test, and one that holds a `<failure>` or an `<error>` is one failing test.
 * A skipped test (`<skipped>`) is not a failure, and not a pass.
 */

/** One failing test, as a report names it: its file (or class), and its name. */
export type JunitFailure = {
  readonly file: string;
  readonly test?: string;
};

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decodes XML's five named entities and its character references; anything else stays as written. */
const decodeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    if (!entity.startsWith("#")) return ENTITIES[entity] ?? whole;
    const code = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const attributesOf = (text: string): ReadonlyMap<string, string> =>
  new Map(Array.from(text.matchAll(ATTRIBUTE), (m) => [m[1] ?? "", decodeXml(m[2] ?? m[3] ?? "")]));

/** A start, end or empty-element tag, its name and its attributes' text. */
const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

/** One test case as a report lists it: its file and name, and whether it failed or was skipped. */
type JunitCase = JunitFailure & { readonly failed: boolean; readonly skipped: boolean };

const caseOf = (
  attributes: ReadonlyMap<string, string>,
  failed: boolean,
  skipped: boolean,
): JunitCase => {
  const file = attributes.get("file") ?? attributes.get("classname") ?? "";
  const test = attributes.get("name");
  return test === undefined || test === ""
    ? { file, failed, skipped }
    : { file, test, failed, skipped };
};

/**
 * Every test case in a JUnit XML report, in the order it lists them, or
 * undefined when the text is not one: no `<testsuites>` or `<testsuite>`
 * element, or a `<testcase>` left open or opened inside another. A test's
 * file is its `file` attribute, else its `classname` (vitest writes the
 * path there; pytest and go-junit-report a module or package); its name is
 * `name`. Comments and CDATA (where failure messages often quote markup)
 * are dropped before any tag is read.
 */
const casesOf = (xml: string): readonly JunitCase[] | undefined => {
  const text = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  let suites = false;
  let open:
    | { readonly attributes: ReadonlyMap<string, string>; failed: boolean; skipped: boolean }
    | undefined;
  const cases: JunitCase[] = [];
  for (const [, closing, name, attributes, empty] of text.matchAll(TAG)) {
    if (name === "testsuites" || name === "testsuite") suites = true;
    else if (name === "testcase" && closing === "") {
      if (open !== undefined) return undefined;
      const read = attributesOf(attributes ?? "");
      if (empty === "") open = { attributes: read, failed: false, skipped: false };
      else cases.push(caseOf(read, false, false));
    } else if (name === "testcase") {
      if (open === undefined) return undefined;
      cases.push(caseOf(open.attributes, open.failed, open.skipped));
      open = undefined;
    } else if (closing === "" && open !== undefined) {
      if (name === "failure" || name === "error") open.failed = true;
      else if (name === "skipped") open.skipped = true;
    }
  }
  return suites && open === undefined ? cases : undefined;
};

/** The failing tests in a JUnit XML report, in the order it lists them, or undefined when the text is not one. */
export const failingTestsOf = (xml: string): readonly JunitFailure[] | undefined =>
  casesOf(xml)
    ?.filter((c) => c.failed)
    .map(({ file, test }) => (test === undefined ? { file } : { file, test }));

/** How many tests a JUnit XML report names: all of them, and how many of those passed, failed and were skipped. */
export type JunitCounts = {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
};

/**
 * How many tests a JUnit XML report names, or undefined when the text is not
 * one: a test that failed counts as failed even when it was skipped too, and
 * one neither failed nor skipped passed.
 */
export const testCountsOf = (xml: string): JunitCounts | undefined => {
  const cases = casesOf(xml);
  if (cases === undefined) return undefined;
  const failed = cases.filter((c) => c.failed).length;
  const skipped = cases.filter((c) => !c.failed && c.skipped).length;
  return { total: cases.length, passed: cases.length - failed - skipped, failed, skipped };
};
