/**
 * The bundle writer and reader as they were before streaming: the whole tar
 * built in memory, then gzipped in one piece; the whole gzip unpacked, then
 * the tar parsed. Copied verbatim but for imports, and kept to prove that the
 * streaming writer's bytes, and the streaming reader's answers, are unchanged.
 */
import {
  BUNDLE_MANIFEST,
  BUNDLE_ROOT,
  type BundleFile,
  BundleRefused,
  BundleUnreadable,
} from "../../src/bundle.ts";

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The sha256 of some bytes, as lowercase hex. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", bytes.slice()));

const checkPath = (path: string): void => {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    segments.some((s) => s === "" || s === "." || s === "..") ||
    path.includes("\0") ||
    path.includes("\n")
  )
    throw new BundleRefused(`unsafe path ${JSON.stringify(path)}`);
  if (path === BUNDLE_MANIFEST) throw new BundleRefused(`${BUNDLE_MANIFEST} is reserved`);
};

const compareBytes = (a: string, b: string): number => {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
};

/** The manifest's text for these files: `sha256sum` lines in bytewise path order. */
export const manifestOf = async (files: readonly BundleFile[]): Promise<string> => {
  const lines = await Promise.all(
    files.map(async (f) => ({ path: f.path, line: `${await sha256Hex(f.bytes)}  ${f.path}\n` })),
  );
  return lines
    .toSorted((a, b) => compareBytes(a.path, b.path))
    .map((l) => l.line)
    .join("");
};

// ------------------------------------------------------------------ ustar

const BLOCK = 512;

const octal = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, "0")}\0`;

const header = (name: string, size: number, mode: number, type: "0" | "x"): Uint8Array => {
  const block = new Uint8Array(BLOCK);
  const put = (offset: number, text: string) => block.set(encoder.encode(text), offset);
  put(0, name);
  put(100, octal(mode, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(0, 12));
  put(148, "        ");
  put(156, type);
  put(257, "ustar\0");
  put(263, "00");
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
};

const padded = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
  out.set(bytes);
  return out;
};

/** A PAX record `"<len> path=<path>\n"`, whose length counts its own digits. */
const paxPath = (path: string): Uint8Array => {
  const body = encoder.encode(` path=${path}\n`).length;
  let length = body + String(body).length;
  while (String(length).length + body !== length) length = String(length).length + body;
  return encoder.encode(`${length} path=${path}\n`);
};

const entry = (name: string, bytes: Uint8Array, mode: number): Uint8Array[] => {
  const blocks: Uint8Array[] = [];
  let shortName = name;
  if (encoder.encode(name).length > 100) {
    const pax = paxPath(name);
    blocks.push(header("././@PaxHeader", pax.length, 0o644, "x"), padded(pax));
    shortName = name.slice(0, 99);
  }
  blocks.push(header(shortName, bytes.length, mode, "0"), padded(bytes));
  return blocks;
};

/** An uncompressed ustar archive of these files, under `BUNDLE_ROOT/`, plus the manifest. */
export const tarOf = async (files: readonly BundleFile[]): Promise<Uint8Array> => {
  const seen = new Set<string>();
  for (const f of files) {
    checkPath(f.path);
    if (seen.has(f.path)) throw new BundleRefused(`duplicate path ${f.path}`);
    seen.add(f.path);
  }
  const manifest = encoder.encode(await manifestOf(files));
  const blocks = [
    ...entry(`${BUNDLE_ROOT}/${BUNDLE_MANIFEST}`, manifest, 0o644),
    ...files
      .toSorted((a, b) => compareBytes(a.path, b.path))
      .flatMap((f) => entry(`${BUNDLE_ROOT}/${f.path}`, f.bytes, f.executable ? 0o755 : 0o644)),
    new Uint8Array(BLOCK * 2),
  ];
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of blocks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
};

/** A candidate bundle: the gzipped archive of `tarOf(files)`. Its address is `sha256:` + `sha256Hex` of these bytes. */
export const writeBundle = async (files: readonly BundleFile[]): Promise<Uint8Array> => {
  const tar = await tarOf(files);
  const gzipped = new Blob([tar.slice()]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(gzipped).arrayBuffer());
};

// ------------------------------------------------------------------ reading

const decoder = new TextDecoder();

/** A NUL-terminated header field as text. */
const field = (block: Uint8Array, offset: number, length: number): string => {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
};

const octalField = (block: Uint8Array, offset: number, length: number): number => {
  const text = field(block, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new BundleUnreadable(`bad octal field ${JSON.stringify(text)}`);
  return Number.parseInt(text, 8);
};

/** The `path` a PAX extended header sets for the entry after it. */
const paxPathOf = (records: Uint8Array): string => {
  const text = decoder.decode(records);
  for (const record of text.split("\n")) {
    const at = record.indexOf(" path=");
    if (at !== -1) return record.slice(at + " path=".length);
  }
  throw new BundleUnreadable("a PAX header with no path");
};

/** The entries of an uncompressed ustar archive: regular files only, ending in its two zero blocks. */
const entriesOf = (tar: Uint8Array): { name: string; bytes: Uint8Array; mode: number }[] => {
  const entries: { name: string; bytes: Uint8Array; mode: number }[] = [];
  let offset = 0;
  let pax: string | undefined;
  for (;;) {
    if (offset + BLOCK > tar.length)
      throw new BundleUnreadable("the archive ends before its end marker");
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) {
      const next = tar.subarray(offset + BLOCK, offset + 2 * BLOCK);
      if (next.length !== BLOCK || !next.every((b) => b === 0))
        throw new BundleUnreadable("the archive ends before its end marker");
      return entries;
    }
    const stored = octalField(block, 148, 8);
    const summed = block.reduce((t, b, i) => t + (i >= 148 && i < 156 ? 32 : b), 0);
    if (stored !== summed)
      throw new BundleUnreadable(`a header's checksum is wrong at byte ${offset}`);
    if (field(block, 257, 6) !== "ustar") throw new BundleUnreadable("not a ustar archive");
    const size = octalField(block, 124, 12);
    const mode = octalField(block, 100, 8);
    const type = String.fromCharCode(block[156] ?? 0);
    const start = offset + BLOCK;
    if (start + size > tar.length) throw new BundleUnreadable("an entry is cut short");
    const bytes = tar.slice(start, start + size);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      pax = paxPathOf(bytes);
      continue;
    }
    if (type !== "0" && type !== "\0")
      throw new BundleUnreadable(`an entry of type ${JSON.stringify(type)}: only regular files`);
    entries.push({ name: pax ?? field(block, 0, 100), bytes, mode });
    pax = undefined;
  }
};

/**
 * Reads a bundle back into its files, as a runner that is not a shell reads
 * it (a VerifierDO building a world). It must be the gzipped ustar
 * `writeBundle` writes: every entry a regular file under `BUNDLE_ROOT/`, at a
 * safe path, once, and the manifest listing exactly the other files with
 * their sha256. Anything else is `BundleUnreadable`, so a truncated, altered
 * or foreign archive is never read as a smaller or different tree.
 */
export const readBundle = async (bytes: Uint8Array): Promise<BundleFile[]> => {
  let tar: Uint8Array;
  try {
    const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("gzip"));
    tar = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new BundleUnreadable("not gzip, or cut short");
  }
  let manifest: string | undefined;
  const files: BundleFile[] = [];
  const seen = new Set<string>();
  for (const e of entriesOf(tar)) {
    if (!e.name.startsWith(`${BUNDLE_ROOT}/`))
      throw new BundleUnreadable(`an entry outside ${BUNDLE_ROOT}/: ${JSON.stringify(e.name)}`);
    const path = e.name.slice(BUNDLE_ROOT.length + 1);
    if (path === BUNDLE_MANIFEST) {
      if (manifest !== undefined) throw new BundleUnreadable("two manifests");
      manifest = decoder.decode(e.bytes);
      continue;
    }
    try {
      checkPath(path);
    } catch (error) {
      throw new BundleUnreadable(error instanceof BundleRefused ? error.reason : String(error));
    }
    if (seen.has(path)) throw new BundleUnreadable(`duplicate path ${path}`);
    seen.add(path);
    files.push({ path, bytes: e.bytes, ...((e.mode & 0o111) === 0 ? {} : { executable: true }) });
  }
  if (manifest === undefined) throw new BundleUnreadable(`no ${BUNDLE_MANIFEST}`);
  if (manifest !== (await manifestOf(files)))
    throw new BundleUnreadable("the files are not the ones the manifest lists");
  return files;
};
