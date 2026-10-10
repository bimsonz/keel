import { posix } from "node:path";
import { parseSync } from "oxc-parser";

export interface ImportRef {
  /** The module specifier exactly as written. */
  readonly specifier: string;
  /** Imported binding names; `*` for a namespace import, `default` for a default import. */
  readonly names: readonly string[];
  readonly typeOnly: boolean;
  readonly kind: "import" | "re-export" | "dynamic";
  readonly line: number;
}

/** oxc's name kinds are const enums of strings; read them as strings. */
function bindingName(kind: string, name: string | null): string {
  if (kind === "Name") return name ?? "";
  if (kind === "Default") return "default";
  return "*";
}

function lineAt(code: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i += 1) if (code.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Every module specifier a file names, read from oxc's module record: static
 * imports, re-exports and literal dynamic imports. Never a regex.
 */
export function importsOf(file: string, code: string): ImportRef[] {
  const parsed = parseSync(file, code, { sourceType: "module" });
  const refs: ImportRef[] = [];
  for (const entry of parsed.module.staticImports) {
    const names = entry.entries.map((e) => bindingName(e.importName.kind, e.importName.name));
    refs.push({
      specifier: entry.moduleRequest.value,
      names,
      typeOnly: entry.entries.length > 0 && entry.entries.every((e) => e.isType),
      kind: "import",
      line: lineAt(code, entry.start),
    });
  }
  for (const entry of parsed.module.staticExports) {
    for (const e of entry.entries) {
      if (e.moduleRequest === null) continue;
      refs.push({
        specifier: e.moduleRequest.value,
        names: [bindingName(e.importName.kind, e.importName.name)],
        typeOnly: e.isType,
        kind: "re-export",
        line: lineAt(code, entry.start),
      });
    }
  }
  for (const entry of parsed.module.dynamicImports) {
    const raw = code.slice(entry.moduleRequest.start, entry.moduleRequest.end).trim();
    const literal = /^(["'`])([^"'`]*)\1$/.exec(raw);
    refs.push({
      specifier: literal?.[2] ?? raw,
      names: ["*"],
      typeOnly: false,
      kind: "dynamic",
      line: lineAt(code, entry.start),
    });
  }
  return refs;
}

/** A relative specifier resolved against the importing file, both repo-relative. Packages resolve to null. */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return posix.normalize(posix.join(posix.dirname(fromFile), specifier));
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`; `node:fs` and `cloudflare:workers` unchanged. */
export function packageOf(specifier: string): string {
  if (specifier.includes(":") && !specifier.startsWith("@")) return specifier;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}
