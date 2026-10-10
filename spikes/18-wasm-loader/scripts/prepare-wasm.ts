// Collects every wasm blob the spike needs into build/wasm/ (gitignored) and
// writes build/wasm/manifest.json with raw size, gzip size and sha256.
// Tool wasm comes from the pinned npm packages; padded/probe modules are generated.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { expectedProbe, memgrow, padded, tiny } from "./wasm-gen.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "wasm");
mkdirSync(out, { recursive: true });
// node_modules is flat for direct deps under pnpm; some packages do not export ./package.json.
const pkgDir = (name: string) => join(root, "node_modules", name);
const version = (name: string) =>
  (JSON.parse(readFileSync(join(pkgDir(name), "package.json"), "utf8")) as { version: string }).version;

type Entry = { file: string; source: string; bytes: number; gzipBytes: number; sha256: string };
const manifest: Record<string, Entry> = {};

function put(file: string, bytes: Uint8Array, source: string) {
  writeFileSync(join(out, file), bytes);
  manifest[file] = {
    file,
    source,
    bytes: bytes.length,
    gzipBytes: gzipSync(bytes, { level: 6 }).length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const copy = (file: string, pkg: string, rel: string, transform = (b: Buffer): Uint8Array => b) =>
  put(file, transform(readFileSync(join(pkgDir(pkg), rel))), `${pkg}@${version(pkg)}/${rel}`);

copy("ruff.wasm", "@astral-sh/ruff-wasm-web", "ruff_wasm_bg.wasm");
copy("clang-format.wasm", "@wasm-fmt/clang-format", "clang-format.wasm");
copy("hcl2json.wasm", "@cdktf/hcl2json", "main.wasm.gz", (b) => gunzipSync(b));
copy("tree-sitter.wasm", "web-tree-sitter", "web-tree-sitter.wasm");
// tree-sitter-wasms@0.1.13 ships the legacy "dylink" section, which web-tree-sitter 0.27 rejects;
// the grammar package's own prebuilt wasm carries "dylink.0".
copy("tree-sitter-typescript.wasm", "tree-sitter-typescript", "tree-sitter-typescript.wasm");

const MiB = 1024 * 1024;
// 10/30/60 are the spec sizes; 100/200 look for the ceiling once those pass.
const PAD_SIZES = [10, 30, 60, 100, 200];
for (const mb of PAD_SIZES) {
  put(`pad-${mb}-active.wasm`, padded(mb * MiB, "active"), `generated: ${mb} MiB, active data segment`);
  put(`pad-${mb}-passive.wasm`, padded(mb * MiB, "passive"), `generated: ${mb} MiB, passive data segment`);
}
put("memgrow.wasm", memgrow(), "generated: memory.grow probe");
put("tiny.wasm", tiny(), "generated: answer() -> 42");

// Sanity: every generated module validates and behaves in Node before it goes near the edge.
for (const mb of PAD_SIZES) {
  for (const mode of ["active", "passive"] as const) {
    const bytes = readFileSync(join(out, `pad-${mb}-${mode}.wasm`));
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    const got = (inst.exports.probe as () => number)();
    const want = mode === "active" ? expectedProbe(mb * MiB) : 42;
    if (got !== want) throw new Error(`pad-${mb}-${mode}: probe ${got} != ${want}`);
  }
}
{
  const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(out, "memgrow.wasm"))), {});
  const grow = inst.exports.grow as (n: number) => number;
  const touch = inst.exports.touch as (a: number, b: number) => void;
  if (grow(15) !== 1) throw new Error("memgrow: grow failed");
  touch(0, 16 * 65536);
  const inst2 = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(out, "tiny.wasm"))), {});
  if ((inst2.exports.answer as () => number)() !== 42) throw new Error("tiny: answer != 42");
}

const expected = Object.fromEntries(PAD_SIZES.map((mb) => [`pad-${mb}-active`, expectedProbe(mb * MiB)]));
writeFileSync(join(out, "manifest.json"), JSON.stringify({ files: manifest, expectedProbe: expected }, null, 2));
for (const e of Object.values(manifest)) {
  console.log(
    `${e.file.padEnd(30)} ${String(e.bytes).padStart(10)} B  gz ${String(e.gzipBytes).padStart(10)} B  ${e.source}`,
  );
}
