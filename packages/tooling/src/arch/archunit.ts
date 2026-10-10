import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectFiles } from "archunit";
import type { Violation } from "../guard.ts";

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const found: unknown = Reflect.get(value, key);
  return found;
}

function describe(violation: unknown): { file: string; message: string } {
  const cycle = field(violation, "cycle");
  if (Array.isArray(cycle)) {
    const steps = cycle.map((edge: unknown) => field(edge, "sourceLabel")).filter((s): s is string => typeof s === "string");
    return { file: steps[0] ?? ".", message: [...steps, steps[0] ?? ""].join(" → ") };
  }
  const dependency = field(violation, "dependency");
  const source = field(dependency, "sourceLabel");
  const target = field(dependency, "targetLabel");
  if (typeof source === "string") return { file: source, message: `depends on ${typeof target === "string" ? target : "?"}` };
  return { file: ".", message: JSON.stringify(violation).slice(0, 300) };
}

function baseOf(tsconfig: string): string {
  return tsconfig.slice(0, tsconfig.lastIndexOf("/") + 1);
}

/**
 * How many files ArchUnitTS itself matches in `folder`. A rule compares this
 * with what its own scan read, so ArchUnitTS cannot pass by matching nothing.
 * (Its EmptyTestViolation also fires when nothing imports the *target*
 * folder, a false positive for "nobody may import X", so rules count instead.)
 */
export async function archFileCount(root: string, tsconfig: string, folder: string): Promise<number> {
  const path = join(root, tsconfig);
  if (!existsSync(path)) return 0;
  let seen = 0;
  await projectFiles(path)
    .inFolder(folder)
    .should()
    .adhereTo(() => {
      seen += 1;
      return true;
    }, "counted")
    .check({ allowEmptyTests: true, clearCache: true });
  return seen;
}

/** ArchUnitTS: no file in `from` depends on a file in `to`. Folders are relative to the tsconfig's directory. */
export async function forbidDependency(rule: string, root: string, tsconfig: string, from: string, to: string): Promise<Violation[]> {
  const path = join(root, tsconfig);
  if (!existsSync(path)) return [];
  const found = await projectFiles(path).inFolder(from).shouldNot().dependOnFiles().inFolder(to).check({ allowEmptyTests: true, clearCache: true });
  return found.map((violation) => {
    const { file, message } = describe(violation);
    return { rule, file: `${baseOf(tsconfig)}${file}`, message: `[archunit] ${message}` };
  });
}

/** ArchUnitTS: the files of `folder` have no import cycles. */
export async function forbidCycles(rule: string, root: string, tsconfig: string, folder: string): Promise<Violation[]> {
  const path = join(root, tsconfig);
  if (!existsSync(path)) return [];
  const found = await projectFiles(path).inFolder(folder).should().haveNoCycles().check({ allowEmptyTests: true, clearCache: true });
  return found.map((violation) => {
    const { file, message } = describe(violation);
    return { rule, file: `${baseOf(tsconfig)}${file}`, message: `[archunit] cycle: ${message}` };
  });
}
