// Child Worker that type-checks a project with @cloudflare/worker-bundler/typescript.
// Bundled ahead of time by scripts/build-typecheck-child.mjs and loaded with LOADER.get.
import { createTypescriptLanguageService } from "@cloudflare/worker-bundler/typescript";

class MemFs {
  constructor(entries) {
    this.m = new Map(entries);
  }
  read(p) {
    return this.m.get(p) ?? null;
  }
  write(p, c) {
    this.m.set(p, c);
  }
  delete(p) {
    this.m.delete(p);
  }
  list(prefix) {
    return [...this.m.keys()].filter((k) => !prefix || k.startsWith(prefix));
  }
  async flush() {}
}

function flatten(m) {
  if (typeof m === "string") return m;
  let s = m.messageText;
  for (const n of m.next ?? []) s += " " + flatten(n);
  return s;
}

export default {
  async fetch(request) {
    const { files, libs } = await request.json();
    // When the host supplies lib .d.ts files, skip the registry tarball fetch.
    // oxlint-disable-next-line no-underscore-dangle -- read by the wrapped installer (see build script)
    if (libs) globalThis.__KEEL_TS_LIBS = libs;
    const fs = new MemFs(Object.entries(files));
    const { languageService } = await createTypescriptLanguageService({ fileSystem: fs });
    const program = languageService.getProgram();
    const diags = [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];
    const roots = program.getRootFileNames().filter((f) => !f.includes("node_modules/")).length;
    return Response.json({
      roots,
      sourceFiles: program.getSourceFiles().length,
      errorCount: diags.length,
      diagnostics: diags.slice(0, 20).map((d) => ({
        file: d.file?.fileName,
        line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined,
        code: d.code,
        message: flatten(d.messageText).slice(0, 300),
      })),
    });
  },
};
