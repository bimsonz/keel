import { describe, expect, it } from "vitest";
import { type BundleFile, sha256Hex } from "../../src/bundle.ts";
import {
  depsNeed,
  GUARDS_ROOT,
  MountRefused,
  PROBE_ENTRY,
  probeWorkerFiles,
} from "../../src/tier1/probe-worker.ts";
import { fc } from "../support/fast-check.ts";

const enc = new TextEncoder();
const file = (path: string, text: string): BundleFile => ({ path, bytes: enc.encode(text) });

const PACKAGE_JSON = JSON.stringify({
  name: "forge-lite",
  type: "module",
  dependencies: { hono: "4.13.13" },
  devDependencies: { vitest: "5.0.3" },
  peerDependencies: { a: "1" },
  optionalDependencies: { b: "1" },
});

const world = [
  file("package.json", PACKAGE_JSON),
  file("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
  file("src/app.ts", "export const app = 1;"),
  file(".keel/flow.json", "{}"),
  file(".keel/guards/g1/probe.test.ts", "// the candidate's edit: always passes"),
  file("node_modules/hono/index.js", "// a world's own node_modules are never used"),
  file("pyproject.toml", "[project]\ndependencies = ['requests']\n"),
];
const probe = [file(".keel/guards/g1/probe.test.ts", "// the pinned probe")];
const deps = [
  file("node_modules/hono/package.json", '{"name":"hono"}'),
  file("node_modules/hono/index.js", "export const Hono = 1;"),
  file("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
];

const mountOrRefusal = (tree: readonly BundleFile[], files: readonly BundleFile[]) => {
  try {
    return probeWorkerFiles(tree, files, undefined);
  } catch (error) {
    if (error instanceof MountRefused) return error;
    throw error;
  }
};

describe("probeWorkerFiles", () => {
  it("[probe-worker.guard-pinned] runs the pinned probe, never the candidate's .keel/guards/ copy", () => {
    const mounted = probeWorkerFiles(world, probe, deps);
    expect(mounted.files[".keel/guards/g1/probe.test.ts"]).toBe("// the pinned probe");
    expect(mounted.probe).toBe(".keel/guards/g1/probe.test.ts");
  });

  it("[probe-worker.guards-never-from-world] keeps no world file under .keel/guards/, whatever the trees", () => {
    const segment = fc.constantFrom("a", "b", "g1", "src", "x.ts", "probe.test.ts");
    const path = fc.oneof(
      fc.array(segment, { minLength: 1, maxLength: 3 }).map((s) => s.join("/")),
      fc.array(segment, { minLength: 1, maxLength: 2 }).map((s) => `${GUARDS_ROOT}${s.join("/")}`),
    );
    fc.assert(
      fc.property(
        fc.uniqueArray(path, { maxLength: 8 }),
        fc.constantFrom(".keel/guards/g1/probe.test.ts", ".keel/p.test.ts"),
        (paths, probePath) => {
          const tree = paths
            .filter((p) => p !== PROBE_ENTRY && !p.startsWith(`${probePath}/`))
            .map((p) => file(p, `world:${p}`));
          const mounted = mountOrRefusal(tree, [file(probePath, "pinned")]);
          // Only a world file outside .keel/guards/ can collide with the probe.
          expect(mounted instanceof MountRefused && probePath.startsWith(GUARDS_ROOT)).toBe(false);
          const guards = mounted instanceof MountRefused ? [] : Object.entries(mounted.files);
          expect(
            guards.filter(
              ([p, text]) => p.startsWith(GUARDS_ROOT) && !(p === probePath && text === "pinned"),
            ),
          ).toEqual([]);
        },
      ),
    );
  });

  it("[probe-worker.deps-stripped] strips every dependency field, so worker-bundler has nothing to install", () => {
    const mounted = probeWorkerFiles(world, probe, deps);
    expect(JSON.parse(mounted.files["package.json"] ?? "")).toEqual({
      name: "forge-lite",
      type: "module",
    });
    expect(mounted.files["pyproject.toml"]).toBeUndefined();
  });

  it("takes node_modules from the deps bundle only", () => {
    const mounted = probeWorkerFiles(world, probe, deps);
    expect(mounted.files["node_modules/hono/index.js"]).toBe("export const Hono = 1;");
    expect(
      probeWorkerFiles(world, probe, undefined).files["node_modules/hono/index.js"],
    ).toBeUndefined();
  });

  it("writes an entry that runs the probe through Keel's vitest and reports its isolate", () => {
    const mounted = probeWorkerFiles(world, [file(".keel/p.test.ts", "")], undefined);
    expect(mounted.entry).toBe(PROBE_ENTRY);
    const entry = mounted.files[PROBE_ENTRY] ?? "";
    expect(entry).toContain(`import { __keel } from "vitest";`);
    expect(entry).toContain(`__keel.run(() => import("./.keel/p.test.ts"))`);
    expect(entry).toContain(`pathname === "/instance"`);
  });

  it("leaves out world files that are not UTF-8", () => {
    const binary: BundleFile = {
      path: "logo.png",
      bytes: new Uint8Array([0x89, 0x50, 0xff, 0xfe]),
    };
    expect(
      probeWorkerFiles([...world, binary], probe, undefined).files["logo.png"],
    ).toBeUndefined();
  });

  it.each([
    ["outside .keel/", [file("src/app.ts", "")], "src/app.ts is outside .keel/"],
    [
      "over a world file",
      [file(".keel/flow.json", ""), file(".keel/p.test.ts", "")],
      ".keel/flow.json is already in the world",
    ],
    [
      "with no test",
      [file(".keel/helper.ts", "")],
      "a probe has exactly one *.test.* file, this one has 0",
    ],
    [
      "with two tests",
      [file(".keel/a.test.ts", ""), file(".keel/b.test.ts", "")],
      "a probe has exactly one *.test.* file, this one has 2",
    ],
  ])("refuses a probe %s", (_name, files, reason) => {
    expect(() => probeWorkerFiles(world, files, undefined)).toThrow(new MountRefused(reason));
  });

  it("refuses a world whose package.json is not a JSON object", () => {
    expect(() => probeWorkerFiles([file("package.json", "[]")], probe, undefined)).toThrow(
      MountRefused,
    );
    expect(() => probeWorkerFiles([file("package.json", "{")], probe, undefined)).toThrow(
      MountRefused,
    );
  });

  it("refuses a world that already has the entry", () => {
    expect(() => probeWorkerFiles([file(PROBE_ENTRY, "")], probe, undefined)).toThrow(MountRefused);
  });
});

describe("depsNeed", () => {
  it("needs nothing when package.json declares no runtime dependency", async () => {
    expect(await depsNeed([file("package.json", '{"devDependencies":{"vitest":"5"}}')])).toEqual({
      _tag: "none",
    });
    expect(await depsNeed([file("src/a.ts", "")])).toEqual({ _tag: "none" });
  });

  it("names the deps bundle by the lockfile's sha256", async () => {
    expect(await depsNeed(world)).toEqual({
      _tag: "lockfile",
      sha256: await sha256Hex(enc.encode("lockfileVersion: '9.0'\n")),
    });
  });

  it("cannot name one for dependencies without a lockfile", async () => {
    expect(await depsNeed([file("package.json", PACKAGE_JSON)])).toEqual({
      _tag: "unkeyed",
      reason: "dependencies declared with no pnpm-lock.yaml",
    });
  });
});
