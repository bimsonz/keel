import { existsSync } from "node:fs";
import { join } from "node:path";
import { read, walk } from "../scan.ts";
import { importsOf, type ImportRef } from "./imports.ts";

export const TS_SOURCE = (path: string): boolean =>
  /\.(ts|tsx|mts)$/.test(path) && !path.endsWith(".d.ts");

/** Generated and test code are excluded unless a rule asks for them. */
export function isGenerated(path: string): boolean {
  return path.includes("/generated/") || path.endsWith(".gen.ts");
}

export function isTest(path: string): boolean {
  return /(^|\/)test\//.test(path) || /\.test\.tsx?$/.test(path);
}

/** TypeScript sources under each existing `dir` of `root`, repo-relative. */
export function sourcesUnder(
  root: string,
  dirs: readonly string[],
  keep: (path: string) => boolean = TS_SOURCE,
): string[] {
  return dirs.flatMap((dir) =>
    existsSync(join(root, dir)) ? walk(join(root, dir), { keep }).map((p) => `${dir}/${p}`) : [],
  );
}

export interface ScannedFile {
  readonly path: string;
  readonly code: string;
  readonly imports: readonly ImportRef[];
}

export function scanFiles(root: string, paths: readonly string[]): ScannedFile[] {
  return paths.map((path) => {
    const code = read(root, path);
    return { path, code, imports: importsOf(path, code) };
  });
}
