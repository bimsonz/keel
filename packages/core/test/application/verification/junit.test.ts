import { describe, expect, it } from "vitest";
import { failingTestsOf, testCountsOf } from "../../../src/application/verification/index.ts";

/** vitest's `--reporter=junit`: the file in `classname`, the describe chain in `name`, a failure per error. */
const VITEST = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="1" errors="0" time="0.5">
    <testsuite name="test/clock.test.ts" timestamp="2026-10-14T21:00:00.000Z" hostname="box" tests="3" failures="1" errors="0" skipped="1" time="0.4">
        <testcase classname="test/clock.test.ts" name="manual clock &gt; advances by the step" time="0.01">
            <failure message="expected 0 to be 5" type="AssertionError">
AssertionError: expected 0 to be 5 // Object.is equality
 ❯ test/clock.test.ts:12:21
            </failure>
        </testcase>
        <testcase classname="test/clock.test.ts" name="manual clock &gt; starts at zero" time="0.001">
        </testcase>
        <testcase classname="test/clock.test.ts" name="manual clock &gt; skipped one" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>`;

/** pytest's `--junitxml`: a dotted module in `classname`, the file (when asked for) in `file`. */
const PYTEST = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="1" skipped="0" tests="3" time="0.1"><testcase classname="tests.test_auth" name="test_revoked_cannot_delete" file="tests/test_auth.py" line="41" time="0.002"><failure message="assert 204 == 403">tests/test_auth.py:44: in test_revoked_cannot_delete
    assert r.status_code == 403
E   assert 204 == 403</failure></testcase><testcase classname="tests.test_auth" name="test_owner_can_delete" time="0.001" /><testcase classname="tests.test_db" name="test_fixture_setup" time="0.0"><error message="failed on setup with &quot;KeyError: &apos;url&apos;&quot;">KeyError</error></testcase></testsuite></testsuites>`;

/** go-junit-report: the package in `classname`, one testsuite per package, no testsuites root. */
const GO = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite tests="2" failures="1" time="0.010" name="example.com/forge/authz">
	<properties><property name="go.version" value="go1.25"></property></properties>
	<testcase classname="authz" name="TestRevocation/after_cache_warm" time="0.000"><failure message="Failed" type="">authz_test.go:30: got 204, want 403</failure></testcase>
	<testcase classname="authz" name="TestOwner" time="0.000"></testcase>
</testsuite>`;

/** cargo-nextest: the binary id in `classname`, a CDATA body that quotes markup. */
const NEXTEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="2" failures="1" errors="0">
<testsuite name="forge::authz" tests="2" disabled="0" errors="0" failures="1">
<testcase name="revoke::denies_delete" classname="forge::authz" timestamp="2026-10-14T21:00:00Z" time="0.003">
<failure type="test failure"><![CDATA[thread 'revoke::denies_delete' panicked: <testcase name="not a test"><failure/></testcase>]]></failure>
<system-out><![CDATA[<testcase name="nor this">]]></system-out>
</testcase>
<!-- <testcase name="commented out"><failure/></testcase> -->
<testcase name="revoke::owner_deletes" classname="forge::authz" time="0.001"/>
</testsuite>
</testsuites>`;

describe("reading a JUnit XML report", () => {
  it("[junit.vitest] vitest's report names the failing test by file and its describe chain; a pass or a skip is no failure", () => {
    expect(failingTestsOf(VITEST)).toEqual([
      { file: "test/clock.test.ts", test: "manual clock > advances by the step" },
    ]);
  });

  it("[junit.pytest] pytest's failures and errors both fail, by the file attribute when there is one, else the class", () => {
    expect(failingTestsOf(PYTEST)).toEqual([
      { file: "tests/test_auth.py", test: "test_revoked_cannot_delete" },
      { file: "tests.test_db", test: "test_fixture_setup" },
    ]);
  });

  it("[junit.go] go-junit-report's single testsuite root reads, by package", () => {
    expect(failingTestsOf(GO)).toEqual([
      { file: "authz", test: "TestRevocation/after_cache_warm" },
    ]);
  });

  it("[junit.nextest] markup quoted in CDATA or a comment is never read as a test", () => {
    expect(failingTestsOf(NEXTEST)).toEqual([
      { file: "forge::authz", test: "revoke::denies_delete" },
    ]);
  });

  it("[junit.entities] names decode XML's entities and character references, and keep what is not one", () => {
    const report = `<testsuite><testcase classname="a&amp;b" name="&lt;x&gt; &#65;&#x42; &#0; &bogus; &#x110000;"><failure/></testcase></testsuite>`;
    expect(failingTestsOf(report)).toEqual([
      { file: "a&b", test: "<x> AB &#0; &bogus; &#x110000;" },
    ]);
  });

  it("[junit.unnamed] a failing test with no name is cited by its file alone; one with no file or class by its name", () => {
    expect(
      failingTestsOf(
        `<testsuite><testcase classname="c"><error/></testcase><testcase name='n'><failure></failure></testcase></testsuite>`,
      ),
    ).toEqual([{ file: "c" }, { file: "", test: "n" }]);
  });

  it("[junit.all-pass] a report whose tests all pass, or that holds none, names none", () => {
    expect(
      failingTestsOf(`<testsuites><testsuite><testcase name="a"/></testsuite></testsuites>`),
    ).toEqual([]);
    expect(failingTestsOf(`<testsuites/>`)).toEqual([]);
  });

  it("[junit.malformed] text that is not a JUnit report reads as none at all", () => {
    for (const text of [
      "",
      "not xml",
      '{"testResults":[]}',
      `<testcase name="a"><failure/></testcase>`,
      `<testsuite><testcase name="a"><failure/></testsuite>`,
      `<testsuite><testcase name="a"><testcase name="b"></testcase></testcase></testsuite>`,
      `<testsuite><testcase name="a"><failure/><testcase name="b"></testcase></testsuite>`,
      `<testsuite></testcase></testsuite>`,
    ])
      expect({ text, read: failingTestsOf(text) }).toEqual({ text, read: undefined });
  });

  it("[junit.counts] a report's tests are counted, a failure as failed even when skipped too, a skip as neither passed nor failed, and markup in CDATA or a comment never", () => {
    expect(testCountsOf(VITEST)).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(testCountsOf(PYTEST)).toEqual({ total: 3, passed: 1, failed: 2, skipped: 0 });
    expect(testCountsOf(GO)).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(testCountsOf(NEXTEST)).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(
      testCountsOf(
        `<testsuite><testcase name="a"><skipped/><failure/></testcase><testcase name="b"/><testcase name="c"><skipped></skipped></testcase></testsuite>`,
      ),
    ).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(testCountsOf(`<testsuites/>`)).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
    for (const text of ["", "not xml", `<testsuite><testcase name="a"></testsuite>`])
      expect({ text, read: testCountsOf(text) }).toEqual({ text, read: undefined });
  });
});
