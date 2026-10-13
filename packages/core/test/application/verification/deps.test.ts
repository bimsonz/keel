import { createHash } from "node:crypto";
import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DEPS_BUILD_PROTOCOL,
  DEPS_MAX_BYTES,
  DEPS_PART_BYTES,
  DEPS_TOOLCHAIN,
  DepsAnswer,
  DepsNeed,
  type DepsPart,
  DepsPointer,
  depsNeedFrom,
  depsRefusal,
  depsRemedy,
  depsStop,
  INSTALL_FAULTS_OF_THE_LOCKFILE,
  INSTALL_INPUTS_MAX,
  installInputsOf,
  JS_TS_SUITE_PACK,
  type Locked,
  needsDeps,
  parseDepsBuild,
  pointerServes,
  WORKER_APP_PACK,
} from "../../../src/application/verification/index.ts";
import { CommitSha } from "../../../src/domain/kernel/index.ts";
import {
  compile,
  type FlowDefaults,
  type PlanStep,
} from "../../../src/domain/verification/index.ts";
import { fc } from "../../support/fast-check.ts";

const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const LOCK = hex("a1");

/** node's own sha256 of a text, in lowercase hex: the hasher an adapter hands `depsNeedFrom`. */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The sha256 these manifests give the file at `path`, and another once it is `edited`. */
const shaAt = (path: string, edited = false): string =>
  sha256(`${edited ? "an edit to " : ""}the file at ${path}`);

/**
 * A bundle manifest's text listing these paths in this order: `<sha256>  <path>`
 * lines, as a bundle carries them. The files named in `edited` hold other bytes.
 */
const listing = (paths: readonly string[], edited: readonly string[] = []): string =>
  paths.map((path) => `${shaAt(path, edited.includes(path))}  ${path}\n`).join("");

/** The install inputs that hold these paths' lines of `listing` and no other, in this order. */
const inputsOf = (paths: readonly string[], edited: readonly string[] = []): string =>
  `keel.install/1\n${listing(paths, edited)}`;

type Read = (path: string) => string | undefined;

/** A candidate none of whose files can be read: no `package.json` of it declares a command. */
const unread: Read = () => undefined;

/** Reads these files (path to text) and no other. */
const reading =
  (texts: Readonly<Record<string, string>>): Read =>
  (path) =>
    Object.hasOwn(texts, path) ? texts[path] : undefined;

/** What `depsNeedFrom` answers for a manifest, hashed as an adapter hashes. */
const needOf = (manifest: string, read: Read = unread): DepsNeed =>
  Effect.runSync(depsNeedFrom(manifest, read, (text) => Effect.succeed(sha256(text))));

const NO_LOCKFILE: DepsNeed = {
  _tag: "Unlocked",
  reason: "no-lockfile: the candidate has no pnpm-lock.yaml at its root",
};

const TOO_LARGE: DepsNeed = {
  _tag: "Unlocked",
  reason:
    "install-inputs-too-large: an install of the candidate reads more files than a deps box is handed",
};

describe("the files an install reads", () => {
  it("[deps.inputs.text] is the keel.install/1 line, then the manifest's own lines for those files in the manifest's order, each line ended", () => {
    // Not in path order: the inputs follow the manifest, they do not sort it.
    const manifest = [
      "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5  src/index.ts",
      "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1  pnpm-lock.yaml",
      "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4  package.json",
      "f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6  README.md",
      "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3  .npmrc",
      "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2  pnpm-workspace.yaml",
      "0707070707070707070707070707070707070707070707070707070707070707  apps/web/package.json",
      "",
    ].join("\n");
    const inputs =
      "keel.install/1\n" +
      "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1  pnpm-lock.yaml\n" +
      "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4  package.json\n" +
      "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3  .npmrc\n" +
      "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2  pnpm-workspace.yaml\n" +
      "0707070707070707070707070707070707070707070707070707070707070707  apps/web/package.json\n";
    expect(installInputsOf(manifest, unread)).toBe(inputs);
    // A manifest whose last line is not ended lists the same files.
    expect(installInputsOf(manifest.slice(0, -1), unread)).toBe(inputs);
    // The least a candidate has: its lockfile.
    expect(
      installInputsOf(
        "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1  pnpm-lock.yaml\n",
        unread,
      ),
    ).toBe(
      "keel.install/1\na1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1  pnpm-lock.yaml\n",
    );
  });

  it("[deps.inputs.reads] holds the root's lockfile and two settings files and a package.json at any depth, and no other file whatever it is named", () => {
    const read = [
      ".npmrc",
      "apps/web/package.json",
      "package.json",
      "packages/x/package.json",
      "packages/x/y/z/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ];
    const others = [
      "package.json.bak",
      "packages/x/.npmrc",
      "packages/x/package.json/index.ts",
      "packages/x/pnpm-lock.yaml",
      "packages/x/pnpm-workspace.yaml",
      "src/index.ts",
      "xpackage.json",
    ];
    expect(installInputsOf(listing([...read, ...others].toSorted()), unread)).toBe(inputsOf(read));
    // Each on its own beside the lockfile: none of the others is ever an input.
    for (const path of others)
      expect({ path, inputs: installInputsOf(listing(["pnpm-lock.yaml", path]), unread) }).toEqual({
        path,
        inputs: inputsOf(["pnpm-lock.yaml"]),
      });
  });

  it("[deps.inputs.lines] reads a manifest line as 64 hex digits, two spaces and a path that is the rest of the line, and no other line", () => {
    const lock = `${LOCK}  pnpm-lock.yaml\n`;
    for (const line of [
      "pnpm-lock.yaml",
      `${LOCK} pnpm-lock.yaml`,
      `${LOCK}   pnpm-lock.yaml`,
      `${LOCK}\tpnpm-lock.yaml`,
      `${LOCK.slice(1)}  pnpm-lock.yaml`,
      `${LOCK}0  pnpm-lock.yaml`,
      `${LOCK.toUpperCase()}  pnpm-lock.yaml`,
      ` ${LOCK}  pnpm-lock.yaml`,
      `sha256:${LOCK}  pnpm-lock.yaml`,
    ])
      expect({ line, inputs: installInputsOf(`${line}\n`, unread) }).toEqual({
        line,
        inputs: undefined,
      });
    // Beside the lockfile's line such a line lists nothing, and neither does an empty one.
    expect(
      installInputsOf(`\n${LOCK.slice(1)}  package.json\n\n${lock}package.json\n`, unread),
    ).toBe(`keel.install/1\n${lock}`);
    // The path is everything after the two spaces: spaces, and the marks some readers end a line at.
    for (const path of [
      "my app/package.json",
      "a  b/package.json",
      "a\rb/package.json",
      "a\u2028b/package.json",
      "a\u2029b/package.json",
    ]) {
      const line = `${hex("d4")}  ${path}\n`;
      expect({ path, inputs: installInputsOf(`${lock}${line}`, unread) }).toEqual({
        path,
        inputs: `keel.install/1\n${lock}${line}`,
      });
    }
  });
});

describe("the commands a package.json declares", () => {
  it("[deps.inputs.bin-string] a bin that is one string makes the file it names an input, however the path to it is spelled", () => {
    const paths = ["a/x.js", "cli.js", "package.json", "pnpm-lock.yaml", "x.js"];
    const declaring = (bin: string) =>
      installInputsOf(
        listing(paths),
        reading({ "package.json": JSON.stringify({ name: "candidate", bin }) }),
      );
    // pnpm joins a bin onto the package's directory, so a leading slash is from there too.
    for (const bin of ["x.js", "./x.js", "a/../x.js", ".//a/./..//x.js", "/x.js"])
      expect({ bin, inputs: declaring(bin) }).toEqual({
        bin,
        inputs: inputsOf(["package.json", "pnpm-lock.yaml", "x.js"]),
      });
    expect(declaring("a/x.js")).toBe(inputsOf(["a/x.js", "package.json", "pnpm-lock.yaml"]));
    // With no bin, none of them is an input.
    expect(
      installInputsOf(listing(paths), reading({ "package.json": '{"name":"candidate"}\n' })),
    ).toBe(inputsOf(["package.json", "pnpm-lock.yaml"]));
  });

  it("[deps.inputs.bin-object] a bin that is an object names a file with each of its strings, and with no other value", () => {
    const paths = ["7", "a.js", "b.js", "c.js", "d.js", "package.json", "pnpm-lock.yaml"];
    const declaring = (bin: unknown) =>
      installInputsOf(listing(paths), reading({ "package.json": JSON.stringify({ bin }) }));
    expect(declaring({ a: "a.js", b: "./b.js" })).toBe(
      inputsOf(["a.js", "b.js", "package.json", "pnpm-lock.yaml"]),
    );
    // A number is no path, though a file is named as it prints; nor is anything else that is not a string.
    expect(declaring({ n: 7, a: "a.js", o: { c: "c.js" }, z: null, t: true, l: ["d.js"] })).toBe(
      inputsOf(["a.js", "package.json", "pnpm-lock.yaml"]),
    );
    for (const bin of [{}, 7, true])
      expect({ bin, inputs: declaring(bin) }).toEqual({
        bin,
        inputs: inputsOf(["package.json", "pnpm-lock.yaml"]),
      });
    // A list is an object too: pnpm names each command by its place in it.
    expect(declaring(["c.js", 7, "d.js"])).toBe(
      inputsOf(["c.js", "d.js", "package.json", "pnpm-lock.yaml"]),
    );
  });

  it("[deps.inputs.bin-nested] a nested package's bin is a path from that package's own directory", () => {
    const paths = [
      "bin/x.js",
      "cli.js",
      "package.json",
      "packages/x/bin/x.js",
      "packages/x/cli.js",
      "packages/x/package.json",
      "pnpm-lock.yaml",
    ];
    expect(
      installInputsOf(
        listing(paths),
        reading({
          "package.json": '{"name":"root"}',
          "packages/x/package.json": JSON.stringify({
            name: "x",
            bin: { x: "./bin/x.js", cli: "cli.js" },
          }),
        }),
      ),
    ).toBe(
      inputsOf([
        "package.json",
        "packages/x/bin/x.js",
        "packages/x/cli.js",
        "packages/x/package.json",
        "pnpm-lock.yaml",
      ]),
    );
    // Spelled alike in two package.json files, a bin is two files: each speaks for its own directory.
    expect(
      installInputsOf(
        listing(paths),
        reading({
          "package.json": '{"bin":"cli.js"}',
          "packages/x/package.json": '{"bin":"bin/x.js"}',
        }),
      ),
    ).toBe(
      inputsOf([
        "cli.js",
        "package.json",
        "packages/x/bin/x.js",
        "packages/x/package.json",
        "pnpm-lock.yaml",
      ]),
    );
  });

  it("[deps.inputs.bin-back] a bin or a directories.bin that climbs out of its package's directory and comes back into it is a command: the target is joined onto the directory before it is asked where it lands", () => {
    // Beside the file each target lands on, the ones another reading of its climb would name are listed too.
    const paths = [
      "cli.js",
      "package.json",
      "packages/cli.js",
      "packages/x/bin/a",
      "packages/x/bin/deep/b.js",
      "packages/x/cli.js",
      "packages/x/other/cli.js",
      "packages/x/package.json",
      "packages/x/x/bin/a",
      "packages/x/x/cli.js",
      "pnpm-lock.yaml",
      "x/bin/a",
      "x/cli.js",
    ];
    const declaring = (json: unknown) =>
      installInputsOf(listing(paths), reading({ "packages/x/package.json": JSON.stringify(json) }));
    // Out by one directory or by two, and back by the names that lead to the package.
    for (const bin of [
      "../x/cli.js",
      "../../packages/x/cli.js",
      "./../x/./cli.js",
      "..//x/cli.js",
      "other/../../x/cli.js",
      "../x/../x/cli.js",
    ])
      expect({ bin, inputs: declaring({ bin }) }).toEqual({
        bin,
        inputs: inputsOf([
          "package.json",
          "packages/x/cli.js",
          "packages/x/package.json",
          "pnpm-lock.yaml",
        ]),
      });
    expect(declaring({ bin: { a: "../x/other/cli.js", b: "../x/x/cli.js" } })).toBe(
      inputsOf([
        "package.json",
        "packages/x/other/cli.js",
        "packages/x/package.json",
        "packages/x/x/cli.js",
        "pnpm-lock.yaml",
      ]),
    );
    // A directory of commands reached the same way: every file under it, and none of the package's others.
    for (const bin of ["../x/bin", "../x/bin/", "../../packages/x/bin", "bin/../../x/bin"])
      expect({ bin, inputs: declaring({ directories: { bin } }) }).toEqual({
        bin,
        inputs: inputsOf([
          "package.json",
          "packages/x/bin/a",
          "packages/x/bin/deep/b.js",
          "packages/x/package.json",
          "pnpm-lock.yaml",
        ]),
      });
  });

  it("[deps.inputs.bin-outside] a bin or a directories.bin that lands outside its package's directory is no command, though the candidate holds what it lands on", () => {
    // Both readings of each climb are listed: the file it lands on in the candidate, and the one a climb that is dropped would name.
    const paths = [
      "cli.js",
      "package.json",
      "packages/cli.js",
      "packages/other/cli.js",
      "packages/x/cli.js",
      "packages/x/other/cli.js",
      "packages/x/package.json",
      "packages/x/x2/cli.js",
      "packages/x2/cli.js",
      "pnpm-lock.yaml",
    ];
    const none = inputsOf(["package.json", "packages/x/package.json", "pnpm-lock.yaml"]);
    const declaring = (path: string, json: unknown) =>
      installInputsOf(listing(paths), reading({ [path]: JSON.stringify(json) }));
    // From a nested package: on its sibling, on the root, down before up, and back in before out again.
    for (const bin of [
      "../other/cli.js",
      "../../cli.js",
      "other/../../other/cli.js",
      "../x/../cli.js",
      "../x/../../cli.js",
      "..",
      "../..",
    ])
      expect({ bin, inputs: declaring("packages/x/package.json", { bin }) }).toEqual({
        bin,
        inputs: none,
      });
    // A sibling whose name only starts as the package's does is another directory.
    expect(declaring("packages/x/package.json", { bin: "../x2/cli.js" })).toBe(none);
    // Above the candidate's root no path leads back: the root's own name is on none of them.
    for (const bin of ["../../../cli.js", "../../../packages/x/cli.js", "../../../x/cli.js"])
      expect({ bin, inputs: declaring("packages/x/package.json", { bin }) }).toEqual({
        bin,
        inputs: none,
      });
    for (const bin of ["../other", "../x2", "..", "../..", "../../..", "../../../packages"])
      expect({
        bin,
        inputs: declaring("packages/x/package.json", { directories: { bin } }),
      }).toEqual({ bin, inputs: none });
    // From the root package there is nowhere to climb to.
    for (const bin of ["../cli.js", "..", "packages/../../cli.js"])
      expect({ bin, inputs: declaring("package.json", { bin }) }).toEqual({ bin, inputs: none });
    for (const bin of ["..", "../packages", "packages/../.."])
      expect({ bin, inputs: declaring("package.json", { directories: { bin } }) }).toEqual({
        bin,
        inputs: none,
      });
  });

  it("[deps.inputs.bin-unlisted] a command the bundle does not hold adds nothing: only the package.json that names it is an input", () => {
    // A command built later, as most are, is not a file of the candidate.
    expect(
      installInputsOf(
        listing(["package.json", "pnpm-lock.yaml", "src/cli.ts"]),
        reading({
          "package.json": JSON.stringify({
            bin: { cli: "dist/cli.js" },
            directories: { bin: "dist/bin" },
          }),
        }),
      ),
    ).toBe(inputsOf(["package.json", "pnpm-lock.yaml"]));
  });

  it("[deps.inputs.bin-directory] directories.bin makes every file under that directory an input, and no file beside it", () => {
    const paths = [
      "bin/a",
      "bin/deep/b.js",
      "bin2/c",
      "binary",
      "package.json",
      "packages/x/bin/a",
      "packages/x/cli.js",
      "packages/x/package.json",
      "pnpm-lock.yaml",
      "src/bin/d",
    ];
    const none = inputsOf(["package.json", "packages/x/package.json", "pnpm-lock.yaml"]);
    const root = (directories: unknown) =>
      installInputsOf(listing(paths), reading({ "package.json": JSON.stringify({ directories }) }));
    const nested = (directories: unknown) =>
      installInputsOf(
        listing(paths),
        reading({ "packages/x/package.json": JSON.stringify({ directories }) }),
      );
    // Every file under it at any depth, and not bin2 or binary, whose names only start as it does.
    for (const bin of ["bin", "./bin", "bin/", "src/../bin"])
      expect({ bin, inputs: root({ bin }) }).toEqual({
        bin,
        inputs: inputsOf([
          "bin/a",
          "bin/deep/b.js",
          "package.json",
          "packages/x/package.json",
          "pnpm-lock.yaml",
        ]),
      });
    expect(root({ bin: "bin/deep" })).toBe(
      inputsOf(["bin/deep/b.js", "package.json", "packages/x/package.json", "pnpm-lock.yaml"]),
    );
    // A nested package's is a directory of that package.
    expect(nested({ bin: "bin" })).toBe(
      inputsOf(["package.json", "packages/x/bin/a", "packages/x/package.json", "pnpm-lock.yaml"]),
    );
    // A file is no directory, and a value that is not a string names none.
    for (const bin of ["binary", "bin/a", "missing", 7, ["bin"], { a: "bin" }, null])
      expect({ bin, inputs: root({ bin }) }).toEqual({ bin, inputs: none });
    for (const directories of ["bin", ["bin"], 7, null])
      expect({ directories, inputs: root(directories) }).toEqual({ directories, inputs: none });
    // `.` is the package's own directory, not a directory of commands: nothing of the package is taken.
    for (const bin of [".", "./", "bin/.."]) {
      expect({ bin, inputs: nested({ bin }) }).toEqual({ bin, inputs: none });
      expect({ bin, inputs: root({ bin }) }).toEqual({ bin, inputs: none });
    }
    // Nor is it one when a nested package comes to its own directory from above.
    for (const bin of ["../x", "../x/", "../../packages/x", "bin/../../x", "../x/bin/.."])
      expect({ bin, inputs: nested({ bin }) }).toEqual({ bin, inputs: none });
  });

  it("[deps.inputs.bin-unparsed] a package.json that is not JSON, or not a JSON object, declares no command and is still an input itself", () => {
    const paths = ["cli.js", "package.json", "pnpm-lock.yaml"];
    const saying = (text: string) =>
      installInputsOf(listing(paths), reading({ "package.json": text }));
    for (const text of [
      "",
      "not json",
      '{"bin":"cli.js"',
      '{"bin":"cli.js"}}',
      "{bin:'cli.js'}",
      "null",
      '"cli.js"',
      '["cli.js"]',
      "7",
      '{"bin":null}',
      '{"directories":null}',
      '{"directories":{"bin":null}}',
    ])
      expect({ text, inputs: saying(text) }).toEqual({
        text,
        inputs: inputsOf(["package.json", "pnpm-lock.yaml"]),
      });
    // As an editor writes one, and with a byte-order mark before it: the mark is no part of the JSON.
    for (const text of ['{\n  "bin": "cli.js"\n}\n', '\ufeff{"bin":"cli.js"}'])
      expect({ text, inputs: saying(text) }).toEqual({
        text,
        inputs: inputsOf(["cli.js", "package.json", "pnpm-lock.yaml"]),
      });
  });

  it("[deps.inputs.bin-unread] only a package.json is read for commands, each for its own, and one that cannot be read declares none", () => {
    const paths = [
      "cli.js",
      "other.json",
      "package.json",
      "packages/x/cli.js",
      "packages/x/package.json",
      "pnpm-lock.yaml",
    ];
    const texts = reading({
      "other.json": '{"bin":"packages/x/cli.js"}',
      "package.json": '{"bin":"cli.js"}',
      "pnpm-lock.yaml": '{"bin":"packages/x/cli.js"}',
    });
    const asked: string[] = [];
    expect(
      installInputsOf(listing(paths), (path) => {
        asked.push(path);
        return texts(path);
      }),
    ).toBe(inputsOf(["cli.js", "package.json", "packages/x/package.json", "pnpm-lock.yaml"]));
    expect(asked.toSorted()).toEqual(["package.json", "packages/x/package.json"]);
  });

  it("[deps.inputs.bin-once] a file reached more than one way is listed once, where the manifest lists it", () => {
    // The deps box moves each listed file once. Not in path order, and the command before the files that name it.
    const paths = ["tools/cli.js", "pnpm-lock.yaml", "packages/x/package.json", "package.json"];
    expect(
      installInputsOf(
        listing(paths),
        reading({
          // One file by two spellings of a bin and by directories.bin.
          "package.json": JSON.stringify({
            bin: { a: "tools/cli.js", b: "./tools/cli.js" },
            directories: { bin: "tools" },
          }),
          // A package.json named as its own command.
          "packages/x/package.json": JSON.stringify({ bin: "package.json" }),
        }),
      ),
    ).toBe(inputsOf(paths));
  });
});

/** The bytes of UTF-8 a text is, by node's own encoder. */
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * The manifest of a candidate whose install reads every file it holds: the
 * lockfile, 768 `package.json` files under names five bytes long, and one
 * more under `under`. Its install inputs are the 15 bytes of the format line,
 * 81 of the lockfile's line, 768 lines of 85 and a last line of 80 and the
 * bytes of `under`: 65,456 and those.
 */
const sized = (under: string): string =>
  listing([
    "pnpm-lock.yaml",
    ...Array.from({ length: 768 }, (_, i) => `p${String(i).padStart(4, "0")}/package.json`),
    `${under}/package.json`,
  ]);

describe("what a candidate needs of a deps bundle", () => {
  it("[deps.need.locked] a candidate with a root lockfile is locked: its install inputs, and their sha256 as the adapter's hasher gives it", () => {
    const manifest =
      `${hex("c3")}  .npmrc\n` +
      `${hex("0b")}  cli.js\n` +
      `${hex("d4")}  package.json\n` +
      `${hex("f6")}  packages/x/package.json\n` +
      `${LOCK}  pnpm-lock.yaml\n` +
      `${hex("b2")}  pnpm-workspace.yaml\n` +
      `${hex("e5")}  src/index.ts\n`;
    const inputs =
      "keel.install/1\n" +
      `${hex("c3")}  .npmrc\n` +
      `${hex("0b")}  cli.js\n` +
      `${hex("d4")}  package.json\n` +
      `${hex("f6")}  packages/x/package.json\n` +
      `${LOCK}  pnpm-lock.yaml\n` +
      `${hex("b2")}  pnpm-workspace.yaml\n`;
    const read = reading({ "package.json": '{"name":"candidate","bin":"cli.js"}\n' });
    const hashed: string[] = [];
    expect(
      Effect.runSync(
        depsNeedFrom(manifest, read, (text) =>
          Effect.sync(() => {
            hashed.push(text);
            return sha256(text);
          }),
        ),
      ),
    ).toEqual({
      _tag: "Locked",
      // The sha256 of the inputs above, written out.
      install: "ccfe7a6aee9c8f39db26fca7c7ff1584f9f812cd0c20ccd5075192526263b004",
      inputs,
    });
    // The inputs are what is hashed, once, and nothing else is.
    expect(hashed).toEqual([inputs]);
    expect(needOf(`${LOCK}  pnpm-lock.yaml\n`)).toEqual({
      _tag: "Locked",
      install: "ee5cd4f24fb0685ae8d5adc469627ef2ea0523d4e7e7c563fd22fa85c6a6368c",
      inputs: `keel.install/1\n${LOCK}  pnpm-lock.yaml\n`,
    });
    // The digest is the hasher's answer, and a hasher that fails fails the need: no digest is made up.
    expect(Effect.runSync(depsNeedFrom(manifest, read, () => Effect.succeed(hex("9a"))))).toEqual({
      _tag: "Locked",
      install: hex("9a"),
      inputs,
    });
    expect(
      Effect.runSync(Effect.flip(depsNeedFrom(manifest, read, () => Effect.fail("no hasher")))),
    ).toBe("no hasher");
  });

  it("[deps.need.unlocked] a candidate with no lockfile has no install inputs and is unlocked, saying so", () => {
    for (const manifest of [
      "",
      listing(["package.json", "src/index.ts"]),
      listing([".npmrc", "package.json", "pnpm-workspace.yaml"]),
    ]) {
      expect(installInputsOf(manifest, unread)).toBeUndefined();
      expect(needOf(manifest)).toEqual(NO_LOCKFILE);
    }
  });

  it("[deps.need.root-only] a lockfile deeper in the tree is not the candidate's lockfile", () => {
    for (const path of [
      "packages/x/pnpm-lock.yaml",
      "vendor/pnpm-lock.yaml",
      "x-pnpm-lock.yaml",
      "pnpm-lock.yaml/readme",
      "pnpm-lock.yaml.bak",
    ]) {
      const manifest = listing(["package.json", path]);
      expect({ path, inputs: installInputsOf(manifest, unread) }).toEqual({
        path,
        inputs: undefined,
      });
      expect({ path, need: needOf(manifest) }).toEqual({ path, need: NO_LOCKFILE });
    }
    // Beside the root's, a nested one is no input: the need is the root's alone.
    expect(needOf(listing(["packages/x/pnpm-lock.yaml", "pnpm-lock.yaml"]))).toEqual({
      _tag: "Locked",
      install: sha256(inputsOf(["pnpm-lock.yaml"])),
      inputs: inputsOf(["pnpm-lock.yaml"]),
    });
  });

  it("[deps.need.digest] an edit to a file an install reads, or one of them gone, is another digest; an edit to any other file, or one come or gone, is the same", () => {
    const read = [
      ".npmrc",
      "bin/tool",
      "cli.js",
      "package.json",
      "packages/x/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ];
    const others = ["README.md", "packages/x/src/index.ts", "src/index.ts"];
    const paths = [...read, ...others].toSorted();
    const texts = reading({
      "package.json": JSON.stringify({ bin: "cli.js", directories: { bin: "bin" } }),
    });
    const base = needOf(listing(paths), texts);
    expect(base).toEqual({
      _tag: "Locked",
      install: sha256(inputsOf(read)),
      inputs: inputsOf(read),
    });
    const installs = new Set([sha256(inputsOf(read))]);
    for (const path of read) {
      const edited = inputsOf(read, [path]);
      expect({ path, need: needOf(listing(paths, [path]), texts) }).toEqual({
        path,
        need: { _tag: "Locked", install: sha256(edited), inputs: edited },
      });
      installs.add(sha256(edited));
    }
    // Gone, each takes its own line with it, and the root's package.json the two commands it declared.
    for (const [gone, left] of [
      [".npmrc", read.filter((path) => path !== ".npmrc")],
      ["bin/tool", read.filter((path) => path !== "bin/tool")],
      ["cli.js", read.filter((path) => path !== "cli.js")],
      [
        "package.json",
        [".npmrc", "packages/x/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"],
      ],
      ["packages/x/package.json", read.filter((path) => path !== "packages/x/package.json")],
      ["pnpm-workspace.yaml", read.filter((path) => path !== "pnpm-workspace.yaml")],
    ] as const) {
      expect({
        gone,
        need: needOf(listing(paths.filter((path) => path !== gone)), texts),
      }).toEqual({
        gone,
        need: { _tag: "Locked", install: sha256(inputsOf(left)), inputs: inputsOf(left) },
      });
      installs.add(sha256(inputsOf(left)));
    }
    // Every one of those is a digest of its own.
    expect(installs.size).toBe(1 + read.length + 6);
    for (const path of others) {
      expect({ path, need: needOf(listing(paths, [path]), texts) }).toEqual({ path, need: base });
      expect({
        path,
        need: needOf(listing(paths.filter((other) => other !== path)), texts),
      }).toEqual({ path, need: base });
    }
    expect(needOf(listing([...paths, "test/index.test.ts"]), texts)).toEqual(base);
  });

  it("[deps.need.property] over any tree of nested paths in any manifest order, the inputs are the lines of the files an install reads, and an edit or a removal moves the digest exactly when it is of one of them", () => {
    // A directory at any depth below the root: up to three names, some of them the names of files an install reads.
    const below = fc.array(
      fc.oneof(
        fc.constantFrom("apps", "packages", "x", "bin", "src", "pnpm-lock.yaml", "package.json"),
        fc.stringMatching(/^[a-z]{1,3}$/),
      ),
      { minLength: 1, maxLength: 3 },
    );
    // The files a directory may hold, as paths from it. Below the root a directory may hold a file named as the lockfile too.
    const NAMES = [
      ".npmrc",
      "bin/a.js",
      "bin/deep/b.js",
      "bin2/c.js",
      "cli.js",
      "index.ts",
      "package.json",
      "package.json.bak",
      "pnpm-workspace.yaml",
      "xpackage.json",
    ];
    // What a package.json may say, and beside it the files and the directories that makes commands, as paths from its own directory: written out, not worked out.
    interface Said {
      readonly text: string | undefined;
      readonly files: readonly string[];
      readonly dirs: readonly string[];
    }
    const ANYWHERE: readonly Said[] = [
      { text: '{"name":"p"}', files: [], dirs: [] },
      { text: '{"bin":"./cli.js"}', files: ["cli.js"], dirs: [] },
      { text: '{"bin":{"a":"bin/a.js","n":7,"up":"../cli.js"}}', files: ["bin/a.js"], dirs: [] },
      { text: '{"directories":{"bin":"bin"}}', files: [], dirs: ["bin"] },
      {
        text: '{"bin":{"c":"./bin2/../bin2/c.js"},"directories":{"bin":"./bin/"}}',
        files: ["bin2/c.js"],
        dirs: ["bin"],
      },
      { text: '{"bin":"../../cli.js","directories":{"bin":"."}}', files: [], dirs: [] },
      { text: "not json", files: [], dirs: [] },
      { text: undefined, files: [], dirs: [] },
    ];
    // What only a nested one may say, `@` standing for the name of its own directory: out of the package and back, into it and then onto it.
    const NESTED: readonly Said[] = [
      {
        text: '{"bin":"../@/cli.js","directories":{"bin":"../@/bin"}}',
        files: ["cli.js"],
        dirs: ["bin"],
      },
      { text: '{"bin":"../@/../cli.js","directories":{"bin":"../@"}}', files: [], dirs: [] },
    ];
    const holding = (
      dir: fc.Arbitrary<readonly string[]>,
      names: string[],
      says: fc.Arbitrary<Said>,
    ) => fc.record({ dir, names: fc.subarray(names), says });
    /** A file of a drawn tree, labelled as it is drawn, by its directory and its name there. */
    interface Drawn {
      readonly path: string;
      /** Whether an install reads it whatever any file says. */
      readonly read: boolean;
      /** What it says, when it is a package.json that can be read. */
      readonly text: string | undefined;
      /** The files and the directories it makes commands, as paths from the root. */
      readonly files: readonly string[];
      readonly dirs: readonly string[];
    }
    // The root and up to four directories below it, in three trees of four a lockfile at the root, and their files in any order.
    const tree = fc
      .tuple(
        holding(fc.constant([]), NAMES, fc.constantFrom(...ANYWHERE)),
        fc.uniqueArray(
          holding(
            below,
            [...NAMES, "pnpm-lock.yaml"],
            fc.oneof(
              { weight: 2, arbitrary: fc.constantFrom(...ANYWHERE) },
              { weight: 1, arbitrary: fc.constantFrom(...NESTED) },
            ),
          ),
          { maxLength: 4, selector: (held) => held.dir.join("/") },
        ),
        fc.option(fc.constant("pnpm-lock.yaml"), { freq: 4 }),
      )
      .map(([root, nested, lockfile]) => {
        const drawn = new Map<string, Drawn>();
        const held = [
          { ...root, names: [...root.names, ...(lockfile === null ? [] : [lockfile])] },
          ...nested,
        ];
        for (const { dir, names, says } of held) {
          const from = (name: string) => [...dir, name].join("/");
          for (const name of names) {
            // A path two directories both come to is one file, and never a package.json: no name with a slash ends as one.
            if (drawn.has(from(name))) continue;
            const declares = name === "package.json";
            drawn.set(from(name), {
              path: from(name),
              read:
                declares ||
                (dir.length === 0 &&
                  [".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(name)),
              text: declares ? says.text?.replaceAll("@", dir.at(-1) ?? "") : undefined,
              files: declares ? says.files.map(from) : [],
              dirs: declares ? says.dirs.map(from) : [],
            });
          }
        }
        return [...drawn.values()];
      })
      .chain((files) => fc.shuffledSubarray(files, { minLength: files.length }));
    // Few enough hashes that two files often hold the same bytes.
    const content = fc.constantFrom(hex("01"), hex("02"), hex("03"));
    const seen = { unlocked: 0, moved: 0, held: 0, lockfileBelow: 0, packageBelow: 0, command: 0 };
    fc.assert(
      fc.property(
        tree,
        fc.array(content, { minLength: 1, maxLength: 8 }),
        fc.nat(),
        (drawn, contents, pick) => {
          // Each file's bytes by its place in the manifest, and once it is edited bytes no file was drawn.
          const files = drawn.map((file, at) => ({
            ...file,
            sha: contents[at % contents.length],
          }));
          type File = (typeof files)[number];
          const manifest = (of: readonly File[], edited?: File) =>
            of.map((file) => `${file === edited ? hex("ee") : file.sha}  ${file.path}\n`).join("");
          const texts: Read = (path) => files.find((file) => file.path === path)?.text;
          /** The files of a tree an install reads, by the labels above. */
          const readOf = (of: readonly File[]) => {
            const commands = new Set(of.flatMap((file) => file.files));
            const dirs = of.flatMap((file) => file.dirs);
            return of.filter(
              (file) =>
                file.read ||
                commands.has(file.path) ||
                dirs.some((dir) => file.path.startsWith(`${dir}/`)),
            );
          };
          /** What a tree needs, by the labels above, with one of its files edited or none. */
          const expected = (of: readonly File[], edited?: File): DepsNeed => {
            if (!of.some((file) => file.path === "pnpm-lock.yaml")) return NO_LOCKFILE;
            const inputs = `keel.install/1\n${manifest(readOf(of), edited)}`;
            return { _tag: "Locked", install: sha256(inputs), inputs };
          };
          const need = expected(files);
          expect(installInputsOf(manifest(files), texts)).toBe(
            need._tag === "Locked" ? need.inputs : undefined,
          );
          const before = needOf(manifest(files), texts);
          expect(before).toEqual(need);
          // One file of the tree, edited and then gone.
          const chosen = files[pick % Math.max(files.length, 1)];
          const without = files.filter((file) => file !== chosen);
          const edited = needOf(manifest(files, chosen), texts);
          const removed = needOf(manifest(without), texts);
          expect(edited).toEqual(expected(files, chosen));
          expect(removed).toEqual(expected(without));
          const read =
            need._tag === "Locked" && chosen !== undefined && readOf(files).includes(chosen);
          seen[need._tag === "Unlocked" ? "unlocked" : read ? "moved" : "held"] += 1;
          const same = (after: DepsNeed) => JSON.stringify(after) === JSON.stringify(before);
          expect({ edited: same(edited), removed: same(removed) }).toEqual({
            edited: !read,
            removed: !read,
          });
          // What a locked tree held: below its root a file named as the lockfile that no install reads, and a package.json; anywhere a file read only as a command.
          if (need._tag === "Unlocked") return;
          const reads = readOf(files);
          if (files.some((file) => file.path.endsWith("/pnpm-lock.yaml") && !reads.includes(file)))
            seen.lockfileBelow += 1;
          if (files.some((file) => file.path.endsWith("/package.json"))) seen.packageBelow += 1;
          if (reads.some((file) => !file.read)) seen.command += 1;
        },
      ),
    );
    // Every case was drawn: the property is about none of them alone.
    expect(Math.min(...Object.values(seen))).toBeGreaterThan(10);
  });

  it("[deps.need.too-large] install inputs of exactly the most a deps box is handed are locked, and one byte more is unlocked, saying so", () => {
    const most = sized("f".repeat(80));
    const inputs = `keel.install/1\n${most}`;
    expect(bytesOf(inputs)).toBe(65_536);
    expect(INSTALL_INPUTS_MAX).toBe(65_536);
    expect(needOf(most)).toEqual({ _tag: "Locked", install: sha256(inputs), inputs });
    const over = sized("f".repeat(81));
    expect(bytesOf(`keel.install/1\n${over}`)).toBe(65_537);
    expect(needOf(over)).toEqual(TOO_LARGE);
    // Only the inputs are measured: files no install reads, however many, are not handed to the box.
    const sources = listing(Array.from({ length: 2000 }, (_, i) => `src/${i}.ts`));
    expect(needOf(`${sources}${most}`)).toEqual({
      _tag: "Locked",
      install: sha256(inputs),
      inputs,
    });
  });

  it("[deps.need.utf8] the inputs are measured in bytes of UTF-8, not in the string's length", () => {
    // One character at each edge of each width UTF-8 has, with the bytes it is.
    for (const [char, bytes] of [
      ["\u007f", 1],
      ["\u0080", 2],
      ["\u00e9", 2],
      ["\u07ff", 2],
      ["\u0800", 3],
      ["\u20ac", 3],
      ["\uffff", 3],
      ["\u{10000}", 4],
      ["\u{1f600}", 4],
      ["\u{10ffff}", 4],
    ] as const) {
      const most = sized(`${char}${"f".repeat(80 - bytes)}`);
      const inputs = `keel.install/1\n${most}`;
      expect({ char, bytes: bytesOf(inputs) }).toEqual({ char, bytes: 65_536 });
      expect({ char, need: needOf(most) }).toEqual({
        char,
        need: { _tag: "Locked", install: sha256(inputs), inputs },
      });
      const over = sized(`${char}${"f".repeat(81 - bytes)}`);
      expect({ char, bytes: bytesOf(`keel.install/1\n${over}`) }).toEqual({ char, bytes: 65_537 });
      expect({ char, need: needOf(over) }).toEqual({ char, need: TOO_LARGE });
    }
  });

  it("[deps.need.data] a need is plain data: it survives the JSON a durable step keeps it as", () => {
    const decode = Schema.decodeUnknownResult(DepsNeed);
    for (const need of [
      needOf(listing([".npmrc", "package.json", "pnpm-lock.yaml"])),
      needOf(""),
      needOf(sized("f".repeat(81))),
    ])
      expect(Result.getOrThrow(decode(JSON.parse(JSON.stringify(need))))).toEqual(need);
    // A locked need names its bundle by a sha256, and by nothing else.
    for (const install of ["", "not a sha256", LOCK.slice(1), LOCK.toUpperCase(), `sha256:${LOCK}`])
      expect(
        Result.isFailure(decode({ _tag: "Locked", install, inputs: "keel.install/1\n" })),
      ).toBe(true);
  });
});

const INSTALL = hex("d1");

const need: Locked = {
  _tag: "Locked",
  install: INSTALL,
  inputs: `keel.install/1\n${LOCK}  pnpm-lock.yaml\n`,
};

const pointer = (over: Partial<DepsPointer> = {}): DepsPointer => ({
  format: "keel.deps/1",
  install: INSTALL,
  toolchain: DEPS_TOOLCHAIN,
  parts: [{ sha256: hex("07"), bytes: 1024 }],
  files: 12,
  installMs: 4000,
  ...over,
});

describe("whether a stored pointer serves a need", () => {
  it("[deps.pointer.serves] serves the install digest it was built for, with this toolchain, whatever else it records", () => {
    expect(pointerServes(pointer(), need)).toBe(true);
    // Its parts and its counts say what was built, and none of them decides.
    expect(
      pointerServes(
        pointer({
          parts: [
            { sha256: hex("07"), bytes: DEPS_PART_BYTES },
            { sha256: hex("18"), bytes: 1 },
          ],
          files: 0,
          installMs: 0,
        }),
        need,
      ),
    ).toBe(true);
    // The toolchain is the caller's to name: a pointer built with it serves.
    expect(pointerServes(pointer({ toolchain: "node v24.0.0 pnpm 12.0.0" }), need)).toBe(false);
    expect(
      pointerServes(
        pointer({ toolchain: "node v24.0.0 pnpm 12.0.0" }),
        need,
        "node v24.0.0 pnpm 12.0.0",
      ),
    ).toBe(true);
  });

  it("[deps.pointer.toolchain] never serves a bundle built with another toolchain", () => {
    for (const toolchain of ["node v22.22.3 pnpm 11.17.0", "node v24.0.0 pnpm 11.18.0", ""])
      expect(pointerServes(pointer({ toolchain }), need)).toBe(false);
    expect(pointerServes(pointer(), need, "node v24.0.0 pnpm 11.18.0")).toBe(false);
  });

  it("[deps.pointer.install] never serves another install digest", () => {
    expect(pointerServes(pointer({ install: hex("9a") }), need)).toBe(false);
    expect(pointerServes(pointer(), { ...need, install: hex("9a") })).toBe(false);
    expect(pointerServes(pointer({ install: hex("9a") }), { ...need, install: hex("9a") })).toBe(
      true,
    );
  });

  it("[deps.pointer.format] is keel.deps/1 for an install digest with at least one whole part, and nothing else decodes as one", () => {
    const decode = Schema.decodeUnknownResult(DepsPointer);
    const kept = JSON.parse(JSON.stringify(pointer()));
    expect(Result.getOrThrow(decode(kept))).toEqual(pointer());
    for (const broken of [
      { ...kept, format: "keel.deps/2" },
      { ...kept, install: "not a sha256" },
      // One that names no install digest, whatever else it holds.
      Object.fromEntries(Object.entries(kept).filter(([key]) => key !== "install")),
      // One that names no part is no pointer: there is nothing of it to hand a step.
      { ...kept, parts: [] },
      { ...kept, parts: [{ sha256: hex("07"), bytes: 0 }] },
      { ...kept, parts: [{ sha256: "07", bytes: 1024 }] },
    ])
      expect({ broken, failed: Result.isFailure(decode(broken)) }).toEqual({
        broken,
        failed: true,
      });
  });
});

const stepsOf = (pack: FlowDefaults): readonly PlanStep[] =>
  Result.getOrThrow(
    compile(
      undefined,
      { baseCommit: CommitSha.make("a".repeat(40)), touchedPaths: [], subjects: [], facts: {} },
      pack,
    ),
  ).steps;

describe("whether a plan needs deps", () => {
  it("[deps.needs] only a plan with a step that runs in a container does", () => {
    const suite = stepsOf(JS_TS_SUITE_PACK);
    expect(suite.map((s) => s.tier.tier)).toEqual([2]);
    expect(needsDeps(suite)).toBe(true);
    expect(needsDeps(stepsOf(WORKER_APP_PACK))).toBe(true);
    const at = (tier: 0 | 1 | 2): PlanStep[] =>
      suite.map((s) => ({ ...s, tier: { tier, reason: "the test's" } }));
    expect(needsDeps([])).toBe(false);
    expect(needsDeps(at(0))).toBe(false);
    // An isolate fetches no deps bundle: Tier 1 alone needs none.
    expect(needsDeps(at(1))).toBe(false);
    expect(needsDeps([...at(0), ...at(1)])).toBe(false);
    expect(needsDeps([...at(0), ...at(1), ...at(2)])).toBe(true);
  });
});

const PARTS: readonly DepsPart[] = [
  { sha256: hex("07"), bytes: DEPS_PART_BYTES },
  { sha256: hex("18"), bytes: 4321 },
];
const listed = (parts: readonly DepsPart[]) => parts.map((p) => `${p.sha256}:${p.bytes}`).join(",");

/** The deps box's stdout, built the way its command prints it. */
const stdout = (fields: Record<string, string>, extra: readonly string[] = []) =>
  [
    DEPS_BUILD_PROTOCOL,
    ...Object.entries(fields).map(([k, v]) => `${k} ${v}`),
    ...extra,
    "KEEL_END",
    "",
  ].join("\n");

const ok = (over: Record<string, string> = {}): Record<string, string> => ({
  KEEL_TOOLCHAIN: DEPS_TOOLCHAIN,
  KEEL_FILES: "1735",
  KEEL_INSTALL_MS: "4900",
  KEEL_PARTS: listed(PARTS),
  KEEL_BUILD: "ok",
  ...over,
});

const without = (fields: Record<string, string>, name: string) =>
  Object.fromEntries(Object.entries(fields).filter(([k]) => k !== name));

describe("the deps box's report", () => {
  it("[deps.build-output.built] reads a build: the toolchain, the counts and every part in order", () => {
    expect(parseDepsBuild(stdout(ok()))).toEqual({
      _tag: "built",
      toolchain: DEPS_TOOLCHAIN,
      files: 1735,
      installMs: 4900,
      parts: PARTS,
    });
    // What the box prints around its markers is not read.
    expect(
      parseDepsBuild(`pnpm: progress\n${stdout(ok(), ["Done in 4.9s", "KEELISH not a marker"])}`),
    ).toMatchObject({ _tag: "built", parts: PARTS });
  });

  it("[deps.build-output.refused] reads each refusal with its reason, whatever else was printed", () => {
    for (const reason of [
      "no-workspace",
      "bundle-unfetched",
      "bundle-hash-mismatch",
      "bundle-unverified",
      "install-mismatch",
      "keep-failed",
      "no-lockfile",
      "local-directory",
      "off-registry codeload.github.com",
      "install-timeout",
      "install-failed",
      "toolchain-switched",
      "no-node-modules",
      "pack-failed",
      "too-large",
      "upload-failed",
    ])
      expect(
        parseDepsBuild(stdout({ KEEL_TOOLCHAIN: DEPS_TOOLCHAIN, KEEL_BUILD: `refused ${reason}` })),
      ).toEqual({ _tag: "refused", reason });
    // A refusal is a refusal even beside the markers of a build.
    expect(parseDepsBuild(stdout(ok({ KEEL_BUILD: "refused upload-failed" })))).toEqual({
      _tag: "refused",
      reason: "upload-failed",
    });
  });

  it("[deps.build-output.malformed] calls anything else malformed: no report, a missing marker, a value that is not what it should be", () => {
    for (const [text, reason] of [
      ["", "no deps build report"],
      ["KEEL_BUILD ok\n", "no deps build report"],
      [stdout(ok()).replace(DEPS_BUILD_PROTOCOL, "KEEL_SUITE/1"), "no deps build report"],
      [stdout(ok()).replace("KEEL_END\n", ""), "no deps build report"],
      [`${stdout(ok())}${stdout(ok())}`, "KEEL_END appears twice"],
      [`${stdout(ok())}${DEPS_BUILD_PROTOCOL}\n`, "more than one deps build report"],
      [stdout(without(ok(), "KEEL_BUILD")), "no KEEL_BUILD"],
      [stdout(ok({ KEEL_BUILD: "maybe" })), "bad KEEL_BUILD"],
      [stdout(ok({ KEEL_BUILD: "refused " })), "bad KEEL_BUILD"],
      [stdout(ok({ KEEL_BUILD: "refused" })), "bad KEEL_BUILD"],
      [stdout(without(ok(), "KEEL_TOOLCHAIN")), "no KEEL_TOOLCHAIN"],
      [stdout(ok({ KEEL_TOOLCHAIN: "" })), "no KEEL_TOOLCHAIN"],
      [stdout(without(ok(), "KEEL_FILES")), "bad KEEL_FILES"],
      [stdout(ok({ KEEL_FILES: "" })), "bad KEEL_FILES"],
      [stdout(ok({ KEEL_FILES: "-1" })), "bad KEEL_FILES"],
      [stdout(ok({ KEEL_FILES: "1e3" })), "bad KEEL_FILES"],
      [stdout(without(ok(), "KEEL_INSTALL_MS")), "bad KEEL_INSTALL_MS"],
      [stdout(ok({ KEEL_INSTALL_MS: "4.9" })), "bad KEEL_INSTALL_MS"],
    ] as const)
      expect(parseDepsBuild(text)).toEqual({ _tag: "malformed", reason });
  });

  it("[deps.build-output.twice] a marker printed twice is malformed, whichever it is and whatever it says", () => {
    for (const again of [
      "KEEL_BUILD ok",
      "KEEL_BUILD refused install-failed",
      `KEEL_PARTS ${listed(PARTS)}`,
      "KEEL_FILES 1735",
      `KEEL_TOOLCHAIN ${DEPS_TOOLCHAIN}`,
    ]) {
      const name = again.split(" ")[0];
      expect(parseDepsBuild(stdout(ok(), [again]))).toEqual({
        _tag: "malformed",
        reason: `${name} appears twice`,
      });
    }
    // A refusal forged after a build, or a build after a refusal, decides nothing.
    expect(
      parseDepsBuild(
        stdout({ KEEL_TOOLCHAIN: DEPS_TOOLCHAIN, KEEL_BUILD: "refused install-mismatch" }, [
          "KEEL_BUILD ok",
        ]),
      )._tag,
    ).toBe("malformed");
  });

  it("[deps.build-output.parts] never reads as built without parts, or with a part that has no real hash or size", () => {
    const one = PARTS[1];
    if (one === undefined) throw new Error("no part");
    for (const parts of [
      undefined,
      "",
      ",",
      `${listed(PARTS)},`,
      `,${listed(PARTS)}`,
      one.sha256,
      `${one.sha256}:`,
      `${one.sha256}:0`,
      `${one.sha256}:-5`,
      `${one.sha256}:1.5`,
      `${one.sha256}:1e3`,
      `${one.sha256}:012`,
      `${one.sha256}: 12`,
      `${"AB".repeat(32)}:12`,
      `${one.sha256.slice(1)}:12`,
      `${one.sha256}0:12`,
      `sha256:${one.sha256}:12`,
      `${one.sha256}:12 ${one.sha256}:12`,
      `${one.sha256}:${DEPS_PART_BYTES + 1}`,
      `${one.sha256}:99999999999999999999999`,
    ]) {
      const fields = parts === undefined ? without(ok(), "KEEL_PARTS") : ok({ KEEL_PARTS: parts });
      expect({ parts, read: parseDepsBuild(stdout(fields)) }).toEqual({
        parts,
        read: { _tag: "malformed", reason: "bad KEEL_PARTS" },
      });
    }
    // One part, as large as a part may be, is a build.
    expect(
      parseDepsBuild(stdout(ok({ KEEL_PARTS: `${one.sha256}:${DEPS_PART_BYTES}` }))),
    ).toMatchObject({ _tag: "built", parts: [{ sha256: one.sha256, bytes: DEPS_PART_BYTES }] });
  });

  it("[deps.build-output.too-large] refuses parts that come to more than the most a bundle may be, and takes exactly that much", () => {
    const whole = DEPS_MAX_BYTES / DEPS_PART_BYTES;
    expect(Number.isInteger(whole)).toBe(true);
    const full = Array.from({ length: whole }, (_, i) => ({
      sha256: i.toString(16).padStart(64, "0"),
      bytes: DEPS_PART_BYTES,
    }));
    expect(parseDepsBuild(stdout(ok({ KEEL_PARTS: listed(full) })))).toMatchObject({
      _tag: "built",
      parts: full,
    });
    expect(
      parseDepsBuild(
        stdout(ok({ KEEL_PARTS: listed([...full, { sha256: hex("ff"), bytes: 1 }]) })),
      ),
    ).toEqual({ _tag: "refused", reason: "too-large" });
  });
});

/** A refusal only a change to the candidate ends: the verdict bounces. */
const bounced = (reason: string): DepsAnswer => ({ _tag: "DepsRefused", reason });

/** A stop that a retry may end: the change parks. */
const parked = (reason: string): DepsAnswer => ({ _tag: "DepsUnavailable", reason });

/** The first words of the refusals a deps box, or the need before it, reads from the candidate's own tree. */
const CANDIDATE_WORDS = [
  "no-lockfile",
  "install-inputs-too-large",
  "local-directory",
  "off-registry",
  "install-timeout",
  "toolchain-switched",
  "too-large",
  "no-node-modules",
];

/** The installer's codes that name a fault of the lockfile, or of what it names. */
const LOCKFILE_CODES = [
  "ERR_PNPM_OUTDATED_LOCKFILE",
  "ERR_PNPM_BROKEN_LOCKFILE",
  "ERR_PNPM_LOCKFILE_BREAKING_CHANGE",
  "ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY",
  "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH",
  "ERR_PNPM_FETCH_404",
];

describe("whose a deps box's refusal is", () => {
  it("[deps.refusal.candidate] a refusal read from the candidate's own tree bounces by its first word, alone or before a space or a colon", () => {
    for (const word of CANDIDATE_WORDS)
      for (const reason of [word, `${word} codeload.github.com`, `${word}: the candidate's own`])
        expect(depsRefusal(reason)).toEqual(bounced(reason));
  });

  it("[deps.refusal.lockfile] a failed install bounces with a code that names the lockfile's own fault, whatever its exit status", () => {
    for (const code of LOCKFILE_CODES)
      for (const exit of [1, 2, 127]) {
        const reason = `install-failed exit ${exit} ${code}`;
        expect(depsRefusal(reason)).toEqual(bounced(reason));
      }
    expect(INSTALL_FAULTS_OF_THE_LOCKFILE.toSorted()).toEqual(LOCKFILE_CODES.toSorted());
  });

  it("[deps.refusal.parks] a registry's fault, a failed install with no code or with one out of its place, Keel's own stops and anything unread park", () => {
    for (const reason of [
      // A registry's own trouble, which pnpm names by its status.
      "install-failed exit 1 ERR_PNPM_FETCH_500",
      "install-failed exit 1 ERR_PNPM_FETCH_502",
      "install-failed exit 1 ERR_PNPM_FETCH_503",
      "install-failed exit 1 ERR_PNPM_FETCH_429",
      "install-failed exit 1 ERR_PNPM_FETCH_401",
      "install-failed exit 1 ERR_PNPM_FETCH_403",
      // A download cut short reads the same as a wrong hash.
      "install-failed exit 1 ERR_PNPM_TARBALL_INTEGRITY",
      // A code that is not listed, though it begins or ends as a listed one does.
      "install-failed exit 1 ERR_PNPM_NO_MATCHING_VERSION",
      "install-failed exit 1 ERR_PNPM_FETCH_4040",
      "install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE_X",
      "install-failed exit 1 ERR_PNPM_X_OUTDATED_LOCKFILE",
      // No code: a connection refused, reset or cut short prints only a stack trace.
      "install-failed exit 1",
      "install-failed exit 7",
      "install-failed",
      // A listed code that is not the whole of what follows the exit status.
      "install-failed exit 1 see ERR_PNPM_OUTDATED_LOCKFILE",
      "install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE and more",
      "install-failed exit 1  ERR_PNPM_OUTDATED_LOCKFILE",
      "install-failed exit x ERR_PNPM_OUTDATED_LOCKFILE",
      "install-failed ERR_PNPM_OUTDATED_LOCKFILE",
      "it said install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE",
      "ERR_PNPM_OUTDATED_LOCKFILE",
      // Keel's own stops, as the box names them.
      "no-workspace",
      "bundle-unfetched",
      "bundle-hash-mismatch",
      "bundle-unverified",
      "keep-failed",
      "upload-failed",
      // A listed word that is not the first, or only begins the first.
      "the box said too-large",
      " too-large",
      "too-largeish",
      "no-lockfiles",
      "TOO-LARGE",
      // Nothing an object answers to by inheritance is a refusal.
      "constructor",
      "toString: of the candidate",
      "__proto__",
      "",
    ])
      expect(depsRefusal(reason)).toEqual(parked(reason));
  });
});

describe("what to do about refused deps", () => {
  it("[deps.remedy.candidate] each refusal of the candidate's own says what to change, by its first word", () => {
    const remedies: Readonly<Record<string, string>> = {
      "no-lockfile":
        "commit a pnpm-lock.yaml at the repository's root (run pnpm install): dependencies are installed only from a frozen lockfile",
      "install-inputs-too-large":
        "an install of this repository reads more package.json and command files than one build is handed: keep fewer of them",
      "local-directory":
        "the lockfile installs a directory of the repository's own (a file: or injected dependency), which is not installed: depend on it as a workspace package or from the registry",
      "off-registry":
        "the lockfile names a package that is not from https://registry.npmjs.org/, the only registry installed from: depend on a registry package",
      "install-timeout": "the install ran longer than 480 seconds: depend on less",
      "toolchain-switched":
        "the repository made another pnpm run the install: name pnpm@11.18.0 as its packageManager, or none",
      "too-large": "the installed dependencies come to more than 2 GiB gzipped: depend on less",
      "no-node-modules":
        "the install made no node_modules: add the dependencies the suite and the typecheck run with, and commit the pnpm-lock.yaml",
    };
    expect(Object.keys(remedies).toSorted()).toEqual(CANDIDATE_WORDS.toSorted());
    for (const [word, remedy] of Object.entries(remedies)) {
      expect(depsRemedy(word)).toBe(remedy);
      expect(depsRemedy(`${word} codeload.github.com`)).toBe(remedy);
      expect(depsRemedy(`${word}: the candidate's own`)).toBe(remedy);
    }
  });

  it("[deps.remedy.install] a failed install's remedy names the installer's code, and a package the registry does not have says to correct it", () => {
    expect(depsRemedy("install-failed exit 1 ERR_PNPM_FETCH_404")).toBe(
      "the lockfile names a package or a version the registry does not have: correct it, run pnpm install and commit the pnpm-lock.yaml",
    );
    for (const code of LOCKFILE_CODES.filter((c) => c !== "ERR_PNPM_FETCH_404"))
      expect(depsRemedy(`install-failed exit 1 ${code}`)).toBe(
        `the installer refused the lockfile (${code}): run pnpm install and commit the pnpm-lock.yaml it writes`,
      );
  });

  it("[deps.remedy.other] a reason it cannot read still says what a candidate can change, and never another refusal's remedy", () => {
    for (const reason of ["", "constructor", "the box said too-large", "install-failed exit 1"])
      expect(depsRemedy(reason)).toBe(
        "change what the candidate installs, then commit its pnpm-lock.yaml",
      );
  });
});

describe("a Tier 2 step handed no deps bundle", () => {
  const [step] = stepsOf(JS_TS_SUITE_PACK);
  if (step === undefined) throw new Error("the suite pack compiles to no step");
  const report = { stepId: step.id, evidenceClass: "proof", tier: step.tier, durationMs: 0 };

  it("[deps.stop.refused] refused deps fail the step at its ceiling in no time, storing the reason and what to do", () => {
    expect(step.evidenceCeiling).toBe("proof");
    const reason = "install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE";
    expect(depsStop(step, { _tag: "DepsRefused", reason })).toStrictEqual({
      report: { ...report, outcome: "fail" },
      evidence: {
        stepId: step.id,
        outcome: "fail",
        why: "deps-refused: install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE",
        tail: "",
        deps: {
          refused: reason,
          remedy:
            "the installer refused the lockfile (ERR_PNPM_OUTDATED_LOCKFILE): run pnpm install and commit the pnpm-lock.yaml it writes",
        },
      },
    });
  });

  it("[deps.stop.unavailable] unavailable deps abstain with the reason and no remedy, and so does a step that was handed none at all", () => {
    expect(depsStop(step, { _tag: "DepsUnavailable", reason: "upload-failed" })).toStrictEqual({
      report: { ...report, outcome: "abstain" },
      evidence: {
        stepId: step.id,
        outcome: "abstain",
        why: "deps-unavailable: upload-failed",
        tail: "",
      },
    });
    expect(depsStop(step, { _tag: "DepsUnneeded" })).toStrictEqual({
      report: { ...report, outcome: "abstain" },
      evidence: {
        stepId: step.id,
        outcome: "abstain",
        why: "deps-unavailable: no deps were ensured for this step",
        tail: "",
      },
    });
  });
});

describe("what a Tier 2 step is handed", () => {
  it("[deps.answer.data] every answer is plain data: it survives the JSON a durable step keeps it as", () => {
    const decode = Schema.decodeUnknownResult(DepsAnswer);
    for (const answer of [
      { _tag: "DepsReady", install: INSTALL, parts: PARTS },
      { _tag: "DepsUnavailable", reason: "upload-failed" },
      { _tag: "DepsRefused", reason: "off-registry codeload.github.com" },
      { _tag: "DepsUnneeded" },
    ] satisfies DepsAnswer[])
      expect(Result.getOrThrow(decode(JSON.parse(JSON.stringify(answer))))).toEqual(answer);
    // Deps that are ready are an install digest's: a sha256, and nothing else.
    expect(
      Result.isFailure(decode({ _tag: "DepsReady", install: "not a sha256", parts: PARTS })),
    ).toBe(true);
  });
});
