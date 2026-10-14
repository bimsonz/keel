/**
 * The failing tests a JUnit XML report names: the format vitest
 * (`--reporter=junit`), pytest (`--junitxml`), go-junit-report and
 * cargo-nextest all write, whatever the language. Core has no DOM, so this
 * reads only what a verdict cites, by scanning tags: each `<testcase>` that
 * holds a `<failure>` or an `<error>` is one failing test. A skipped test is
 * not a failure.
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

/**
 * The failing tests in a JUnit XML report, in the order it lists them, or
 * undefined when the text is not one: no `<testsuites>` or `<testsuite>`
 * element, or a `<testcase>` left open or opened inside another. A test's
 * file is its `file` attribute, else its `classname` (vitest writes the
 * path there; pytest and go-junit-report a module or package); its name is
 * `name`. Comments and CDATA (where failure messages often quote markup)
 * are dropped before any tag is read.
 */
export const failingTestsOf = (xml: string): readonly JunitFailure[] | undefined => {
  const text = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  let suites = false;
  let open: { readonly attributes: ReadonlyMap<string, string>; failed: boolean } | undefined;
  const failing: JunitFailure[] = [];
  for (const [, closing, name, attributes, empty] of text.matchAll(TAG)) {
    if (name === "testsuites" || name === "testsuite") suites = true;
    else if (name === "testcase" && closing === "") {
      if (open !== undefined) return undefined;
      if (empty === "") open = { attributes: attributesOf(attributes ?? ""), failed: false };
    } else if (name === "testcase") {
      if (open === undefined) return undefined;
      if (open.failed) {
        const file = open.attributes.get("file") ?? open.attributes.get("classname") ?? "";
        const test = open.attributes.get("name");
        failing.push(test === undefined || test === "" ? { file } : { file, test });
      }
      open = undefined;
    } else if ((name === "failure" || name === "error") && closing === "" && open !== undefined)
      open.failed = true;
  }
  return suites && open === undefined ? failing : undefined;
};
