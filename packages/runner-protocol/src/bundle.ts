import { signedUrl, urlSigned } from "./signed-url.ts";

/**
 * Candidate bundles: the one format in which source reaches a runner. A bundle
 * is a gzipped ustar archive with a single top directory (the sandbox's archive
 * checkout strips it with `--strip-components=1`), content-addressed by the
 * sha256 of its bytes. It holds no `.git`, and nothing in it is a credential.
 *
 * Every bundle carries a manifest at its root, `.keel-bundle.sha256`, listing
 * every other file in `sha256sum` format. The archive checkout never checks its
 * own exit code, so a runner verifies the extracted tree against the manifest
 * (hashes and file count) before it runs anything: a partial extraction must
 * never run a subset of the tests and pass.
 */

/** The manifest at a bundle's root: one `<sha256 hex>  <path>` line per other file, sorted by path. */
export const BUNDLE_MANIFEST = ".keel-bundle.sha256";

/** The single top directory every entry sits under. */
export const BUNDLE_ROOT = "candidate";

/** A file as a bundle holds it. Only regular files: symlinks and submodules are refused. */
export interface BundleFile {
  /** Repo-relative, `/`-separated, with no empty, `.` or `..` segment. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable?: boolean;
}

/** Why a set of files cannot be bundled. */
export class BundleRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`bundle refused: ${reason}`);
    this.name = "BundleRefused";
    this.reason = reason;
  }
}

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The sha256 of some bytes, as lowercase hex. Bytes over an ArrayBuffer are
 * hashed where they lie; only a view of a SharedArrayBuffer is copied first.
 */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  hex(
    await crypto.subtle.digest(
      "SHA-256",
      bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : bytes.slice(),
    ),
  );

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

/**
 * The manifest's text for these files: `sha256sum` lines in bytewise path
 * order. The files are hashed one at a time: a digest copies what it is
 * given, so hashing them all at once would hold a second copy of the tree.
 */
export const manifestOf = async (files: readonly BundleFile[]): Promise<string> => {
  const lines: { path: string; line: string }[] = [];
  for (const f of files)
    // oxlint-disable-next-line no-await-in-loop -- one file at a time, so one digest's copy at most
    lines.push({ path: f.path, line: `${await sha256Hex(f.bytes)}  ${f.path}\n` });
  return lines
    .toSorted((a, b) => compareBytes(a.path, b.path))
    .map((l) => l.line)
    .join("");
};

// ------------------------------------------------------------------ ustar

const BLOCK = 512;

/** The most bytes a gzip stream is handed at once, writing a bundle or reading one. */
const PIECE = 64 * 1024;

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

/** How many zero bytes follow `size` bytes of an entry, up to the next block. */
const paddingOf = (size: number): number => Math.ceil(size / BLOCK) * BLOCK - size;

/** A PAX record `"<len> path=<path>\n"`, whose length counts its own digits. */
const paxPath = (path: string): Uint8Array => {
  const body = encoder.encode(` path=${path}\n`).length;
  let length = body + String(body).length;
  while (String(length).length + body !== length) length = String(length).length + body;
  return encoder.encode(`${length} path=${path}\n`);
};

/** A part of an archive as the writer makes it: bytes, or a run of that many zero bytes. */
type Part = Uint8Array | number;

function* entry(name: string, bytes: Uint8Array, mode: number): Generator<Part> {
  let shortName = name;
  if (encoder.encode(name).length > 100) {
    const pax = paxPath(name);
    yield header("././@PaxHeader", pax.length, 0o644, "x");
    yield pax;
    yield paddingOf(pax.length);
    shortName = name.slice(0, 99);
  }
  yield header(shortName, bytes.length, mode, "0");
  yield bytes;
  yield paddingOf(bytes.length);
}

/**
 * The uncompressed ustar archive of these files under `BUNDLE_ROOT/`, its
 * manifest first and then the files in bytewise path order, as its parts in
 * order: the archive itself is never built.
 */
function* tarOf(manifest: Uint8Array, files: readonly BundleFile[]): Generator<Part> {
  yield* entry(`${BUNDLE_ROOT}/${BUNDLE_MANIFEST}`, manifest, 0o644);
  for (const f of files.toSorted((a, b) => compareBytes(a.path, b.path)))
    yield* entry(`${BUNDLE_ROOT}/${f.path}`, f.bytes, f.executable ? 0o755 : 0o644);
  yield BLOCK * 2;
}

/**
 * `parts` copied into pieces of PIECE bytes (the last may be shorter), each a
 * fresh buffer that nothing else holds. A stream may keep or detach a chunk it
 * is handed, and a file's bytes may be a view into a buffer its caller shares,
 * so no caller's bytes are ever handed to a stream themselves.
 */
function* piecesOf(parts: Iterable<Part>): Generator<Uint8Array<ArrayBuffer>> {
  let piece = new Uint8Array(PIECE);
  let used = 0;
  for (const part of parts) {
    const length = typeof part === "number" ? part : part.byteLength;
    for (let done = 0; done < length;) {
      const n = Math.min(length - done, PIECE - used);
      // A fresh piece is zeros already: a run of zeros only moves along it.
      if (typeof part !== "number") piece.set(part.subarray(done, done + n), used);
      used += n;
      done += n;
      if (used === PIECE) {
        yield piece;
        piece = new Uint8Array(PIECE);
        used = 0;
      }
    }
  }
  if (used > 0) yield piece.subarray(0, used);
}

/** Chunks end to end, in one buffer of their own. */
const joined = (chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

/**
 * Writes `pieces` into a gzip stream and hands each chunk it gives back to
 * `take` as it comes. Writing and reading run together, so a write waits only
 * for the stream to take its piece. A failure on either side reaches the
 * other: a failed write aborts the stream, and a failed read (or `take`)
 * cancels it, so a write still pending rejects rather than waits. Rejects
 * with what the reading side saw.
 */
const through = async (
  stream: CompressionStream | DecompressionStream,
  pieces: Iterable<Uint8Array<ArrayBuffer>>,
  take: (chunk: Uint8Array) => void,
): Promise<void> => {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writing = (async () => {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the next piece is made once the stream has taken this one
      for (const piece of pieces) await writer.write(piece);
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      throw error;
    }
  })();
  // Handled from the start: a write may fail while the reader waits, and the
  // stream carries its error to the reader.
  writing.catch(() => {});
  try {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk after another
    for (let next = await reader.read(); !next.done; next = await reader.read()) take(next.value);
    await writing;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    await writing.catch(() => {});
    throw error;
  }
};

/**
 * A candidate bundle: the gzipped ustar archive of these files and their
 * manifest. Its address is `sha256:` + `sha256Hex` of these bytes. The
 * archive is streamed into gzip in pieces of PIECE bytes as it is made, so
 * the writer holds the files and the gzipped bytes, and never the archive.
 */
export const writeBundle = async (files: readonly BundleFile[]): Promise<Uint8Array> => {
  const seen = new Set<string>();
  for (const f of files) {
    checkPath(f.path);
    if (seen.has(f.path)) throw new BundleRefused(`duplicate path ${f.path}`);
    seen.add(f.path);
  }
  const manifest = encoder.encode(await manifestOf(files));
  const gzipped: Uint8Array[] = [];
  await through(new CompressionStream("gzip"), piecesOf(tarOf(manifest, files)), (chunk) => {
    gzipped.push(chunk);
  });
  return joined(gzipped);
};

// ------------------------------------------------------------------ reading

/** Why a bundle cannot be read back: not gzip, not the ustar `writeBundle` writes, or not what its manifest lists. */
export class BundleUnreadable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`bundle unreadable: ${reason}`);
    this.name = "BundleUnreadable";
    this.reason = reason;
  }
}

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

/** A regular file as the reader takes it out of an archive, under the name its PAX header or its own header gives. */
interface Entry {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

/**
 * An entry whose bytes are arriving: its header's fields, and its bytes so
 * far, each part copied out of the chunk it came in.
 */
interface Receiving {
  readonly at: "data";
  readonly name: string;
  readonly mode: number;
  readonly type: string;
  readonly size: number;
  readonly parts: Uint8Array[];
  left: number;
}

/**
 * Where a reader is in an archive: in a header, in the block after a zero
 * block, in an entry's bytes or its padding, or done.
 */
type Phase =
  | { readonly at: "header" | "marker" | "end" }
  | Receiving
  | { readonly at: "padding"; left: number };

/**
 * An uncompressed ustar archive read as it arrives, a chunk at a time:
 * regular files only, ending in its two zero blocks. Each entry's bytes are
 * copied out of the chunks into a buffer of their own, and nothing else of a
 * chunk is kept, so the archive is never held whole. A fault in the archive
 * does not throw from `take`: the first is kept, and from there on, as after
 * the end marker, chunks are discarded, so the stream they come from is still
 * read to its end. `end` gives the entries, or throws that fault, or that the
 * archive stopped short.
 */
const untar = () => {
  const entries: Entry[] = [];
  /** The header, or the block after a zero block, being filled. */
  const block = new Uint8Array(BLOCK);
  let filled = 0;
  /** Where the header being filled starts in the archive. */
  let offset = 0;
  let pax: string | undefined;
  let phase: Phase = { at: "header" };
  let fault: BundleUnreadable | undefined;

  const entryRead = (e: Receiving): Phase => {
    const [only, ...more] = e.parts;
    const bytes = only !== undefined && more.length === 0 ? only : joined(e.parts);
    if (e.type === "x") pax = paxPathOf(bytes);
    else if (e.type !== "0" && e.type !== "\0")
      throw new BundleUnreadable(`an entry of type ${JSON.stringify(e.type)}: only regular files`);
    else {
      entries.push({ name: pax ?? e.name, bytes, mode: e.mode });
      pax = undefined;
    }
    const padding = paddingOf(e.size);
    return padding === 0 ? { at: "header" } : { at: "padding", left: padding };
  };

  const headerRead = (): Phase => {
    if (block.every((b) => b === 0)) return { at: "marker" };
    const stored = octalField(block, 148, 8);
    const summed = block.reduce((t, b, i) => t + (i >= 148 && i < 156 ? 32 : b), 0);
    if (stored !== summed)
      throw new BundleUnreadable(`a header's checksum is wrong at byte ${offset}`);
    if (field(block, 257, 6) !== "ustar") throw new BundleUnreadable("not a ustar archive");
    const size = octalField(block, 124, 12);
    const mode = octalField(block, 100, 8);
    const type = String.fromCharCode(block[156] ?? 0);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    const data: Receiving = {
      at: "data",
      name: field(block, 0, 100),
      mode,
      type,
      size,
      parts: [],
      left: size,
    };
    return size === 0 ? entryRead(data) : data;
  };

  const markerRead = (): Phase => {
    if (!block.every((b) => b === 0))
      throw new BundleUnreadable("the archive ends before its end marker");
    return { at: "end" };
  };

  const take = (chunk: Uint8Array): void => {
    try {
      for (let at = 0; at < chunk.byteLength && phase.at !== "end";) {
        if (phase.at === "header" || phase.at === "marker") {
          const n = Math.min(BLOCK - filled, chunk.byteLength - at);
          block.set(chunk.subarray(at, at + n), filled);
          filled += n;
          at += n;
          if (filled < BLOCK) continue;
          filled = 0;
          phase = phase.at === "header" ? headerRead() : markerRead();
        } else if (phase.at === "data") {
          const n = Math.min(phase.left, chunk.byteLength - at);
          phase.parts.push(chunk.slice(at, at + n));
          phase.left -= n;
          at += n;
          if (phase.left === 0) phase = entryRead(phase);
        } else if (phase.at === "padding") {
          const n = Math.min(phase.left, chunk.byteLength - at);
          phase.left -= n;
          at += n;
          if (phase.left === 0) phase = { at: "header" };
        }
      }
    } catch (error) {
      if (!(error instanceof BundleUnreadable)) throw error;
      fault = error;
      phase = { at: "end" };
    }
  };

  const end = (): Entry[] => {
    if (fault !== undefined) throw fault;
    if (phase.at === "data") throw new BundleUnreadable("an entry is cut short");
    if (phase.at !== "end") throw new BundleUnreadable("the archive ends before its end marker");
    return entries;
  };

  return { take, end };
};

/**
 * Reads a bundle back into its files, as a runner that is not a shell reads
 * it (a VerifierDO building a world). It must be the gzipped ustar
 * `writeBundle` writes: every entry a regular file under `BUNDLE_ROOT/`, at a
 * safe path, once, and the manifest listing exactly the other files with
 * their sha256. Anything else is `BundleUnreadable`, so a truncated, altered
 * or foreign archive is never read as a smaller or different tree.
 *
 * The bundle is unpacked in pieces of PIECE bytes and its archive read as it
 * comes, so the reader holds the bundle and the files it returns, and never
 * the archive. The gzip is always read to its end: a bundle that does not
 * unpack whole is "not gzip, or cut short" whatever the archive said before
 * the stream failed, and a fault in the archive is the answer only once the
 * gzip has proved whole.
 */
export const readBundle = async (bytes: Uint8Array): Promise<BundleFile[]> => {
  const archive = untar();
  try {
    await through(new DecompressionStream("gzip"), piecesOf([bytes]), archive.take);
  } catch {
    throw new BundleUnreadable("not gzip, or cut short");
  }
  let manifest: string | undefined;
  const files: BundleFile[] = [];
  const seen = new Set<string>();
  for (const e of archive.end()) {
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

/** The virtual host a sandbox fetches bundles from; KeelSandbox's outbound handler answers it from R2. */
export const BUNDLE_HOST = "bundles.keel.internal";

/**
 * Where a sandbox fetches a namespace's bundle `sha256:<hex>`:
 * `<namespace id>/<hex>` on the bundle host, the hex last, since a hydration
 * checks what it fetched against the URL's last segment. No public URL and no
 * token, ever.
 */
const bundleUrl = (namespace: string, hash: string): string => {
  if (!/^[A-Za-z0-9_]+$/.test(namespace))
    throw new BundleRefused(`not a namespace id: ${namespace}`);
  const digest = /^sha256:([0-9a-f]{64})$/.exec(hash)?.[1];
  if (digest === undefined) throw new BundleRefused(`not a bundle hash: ${hash}`);
  return `https://${BUNDLE_HOST}/${namespace}/${digest}`;
};

/**
 * How long a signed bundle URL is good for. A Tier 2 step runs five minutes
 * and is retried once on the URL it was first given, so thirty covers a
 * step's whole life with room.
 */
export const BUNDLE_URL_TTL_SECONDS = 30 * 60;

/** What a bundle URL's signature covers: whose bundle, which bundle, and when the URL stops being good. */
const signedText = (namespace: string, sha256: string, expires: number): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`${namespace}|${sha256}|${expires}`).slice();

/**
 * Where a sandbox fetches a namespace's bundle, signed by Keel: `bundleUrl`
 * with `?exp=<unix seconds>&sig=<Ed25519 over "<namespace>|<sha256>|<exp>">`.
 * Only keel holds the signing key (PKCS#8), so only a job keel started for a
 * namespace is ever handed a URL the bundle host answers: knowing another
 * namespace's id and a bundle's hash fetches nothing.
 */
export const signedBundleUrl = async (
  signingKey: string,
  namespace: string,
  hash: string,
  expires: number,
): Promise<string> => {
  const url = bundleUrl(namespace, hash);
  return signedUrl(
    signingKey,
    url,
    expires,
    signedText(namespace, url.slice(url.lastIndexOf("/") + 1), expires),
  );
};

/**
 * Whether a bundle URL's query carries Keel's signature for this namespace's
 * bundle, still in date at `now` (unix seconds). The bundle host asks before
 * it reads anything: no signature, one past its `exp`, or one made for
 * another namespace, bundle or expiry is refused alike. It needs only the
 * public key (SPKI), which signs nothing.
 */
export const bundleUrlSigned = (
  publicKey: string,
  namespace: string,
  sha256: string,
  query: URLSearchParams,
  now: number,
): Promise<boolean> =>
  urlSigned(publicKey, query, now, (expires) => signedText(namespace, sha256, expires));

/**
 * A POSIX sh function, `keel_verify_bundle`, that checks the working directory
 * against the bundle's manifest: every listed file present with its hash, and
 * no file the manifest does not list. It prints nothing and returns 0 on a
 * match; otherwise it prints one reason (`no-manifest`, `hash-mismatch` or
 * `count-<found>-of-<listed>`) and returns 1. Runners call it before running
 * anything, so a partial extraction never runs a subset of the tests.
 *
 * Each listed path is hashed with `./` before it: `sha256sum -c` reads a
 * listed `-` as its standard input, and a candidate may hold a file named so.
 * The manifest so rewritten goes to a temporary file outside the tree, whole
 * before any of it is checked, and is removed again: a `sed` that stopped
 * part way is a `hash-mismatch`, where one piped to the check would leave the
 * lines after it unchecked. So is a temporary file that could not be made.
 */
export const VERIFY_BUNDLE_SH = [
  "keel_verify_bundle() {",
  `  [ -f ${BUNDLE_MANIFEST} ] || { echo no-manifest; return 1; }`,
  `  sums=$(mktemp 2>/dev/null) && LC_ALL=C sed 's/  /  .\\//' ${BUNDLE_MANIFEST} >"$sums" 2>/dev/null && sha256sum --quiet --strict -c "$sums" >/dev/null 2>&1 || { rm -f "$sums"; echo hash-mismatch; return 1; }`,
  '  rm -f "$sums"',
  `  found=$(find . -type f ! -path ./${BUNDLE_MANIFEST} | wc -l | tr -d ' ')`,
  `  listed=$(wc -l < ${BUNDLE_MANIFEST} | tr -d ' ')`,
  '  [ "$found" -eq "$listed" ] || { echo "count-$found-of-$listed"; return 1; }',
  "}",
].join("\n");

/**
 * A POSIX sh function, `keel_bundle_diff <scratch> [url]`, that a runner calls
 * when `keel_verify_bundle` refuses its working directory, to say what went
 * wrong (it needs `keel_verify_bundle` defined). It prints, one fact a line:
 * - each bad manifest entry (at most 20) with its 1-based position and whether
 *   it is `missing` or `differs`, then how many of how many were bad. Entries
 *   are in archive order, so a short download shows as a run of missing ones
 *   at the end;
 * - the working directory's file count and bytes;
 * - with a URL, a second fetch of the bundle into `<scratch>/refetch`: curl's
 *   exit and HTTP status, the bytes and sha256 fetched against the hash the URL
 *   names, `gzip -t`, tar's exit, whether that tree verifies, and how it differs
 *   from the working directory.
 *
 * A clean second fetch beside a bad tree puts the fault in the first fetch or
 * its extract, not in the bundle.
 */
export const DIAGNOSE_BUNDLE_SH = [
  "keel_bundle_diff() {",
  `  s=$1; url=\${2:-}; m=${BUNDLE_MANIFEST}`,
  "  if [ -f $m ]; then",
  "    n=0; bad=0",
  "    while read -r h p; do",
  "      n=$((n + 1))",
  '      if [ ! -f "$p" ]; then why=missing',
  `      elif [ "$(sha256sum "$p" | cut -c1-64)" != "$h" ]; then why="differs $(wc -c < "$p" | tr -d ' ')B"`,
  "      else continue; fi",
  "      bad=$((bad + 1))",
  '      if [ $bad -le 20 ]; then echo "entry $n $p $why"; fi',
  "    done < $m",
  '    echo "entries $bad of $n bad"',
  '  else echo "no manifest"; fi',
  `  echo "workspace files $(find . -type f | wc -l | tr -d ' ') bytes $(find . -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')"`,
  '  [ -n "$url" ] || { echo "refetch skipped: no url"; return 0; }',
  // The content address is the path's last segment: a signed URL's query is no part of it, and is never printed.
  "  addr=${url%%\\?*}",
  "  r=$s/refetch; rm -rf $r; mkdir -p $r/tree",
  `  http=$(curl --connect-timeout 10 --max-time 60 --silent --show-error -o $r/bundle.tgz -w '%{http_code}' "$url" 2>$r/curl.err); rc=$?`,
  `  echo "refetch curl $rc http $http bytes $(wc -c < $r/bundle.tgz 2>/dev/null | tr -d ' ') sha256 $(sha256sum $r/bundle.tgz 2>/dev/null | cut -c1-64) want \${addr##*/}"`,
  `  if [ -s $r/curl.err ]; then echo "refetch curl says $(head -c 300 $r/curl.err | tr '\\n' ' ')"; fi`,
  '  if gzip -t $r/bundle.tgz 2>/dev/null; then echo "refetch gzip ok"; else echo "refetch gzip bad"; fi',
  `  if tar -xzf $r/bundle.tgz --strip-components=1 -C $r/tree 2>$r/tar.err; then echo "refetch tar ok"; else echo "refetch tar failed $(head -c 300 $r/tar.err | tr '\\n' ' ')"; fi`,
  '  if v=$(cd $r/tree && keel_verify_bundle); then echo "refetch verifies ok"; else echo "refetch verifies no: $v"; fi',
  "  diff -rq $r/tree . 2>&1 | head -20 | sed 's/^/vs-refetch /'",
  "}",
].join("\n");

/**
 * A POSIX sh function, `keel_rehydrate_bundle <scratch> <url> <dir>`: one
 * verified refetch. It downloads the bundle from `url` into `<scratch>`, and
 * only if the archive's sha256 is the hash the URL names (its content address:
 * the last segment of its path, whatever signature its query carries)
 * does it clear `dir` and extract into it. Otherwise it leaves `dir` alone,
 * prints one reason (`no-url`, `fetch-failed`, `archive-hash-mismatch`,
 * `clear-failed` or `extract-failed`) and returns 1.
 */
export const REHYDRATE_BUNDLE_SH = [
  "keel_rehydrate_bundle() {",
  "  r=$1/rehydrate; url=$2; dir=$3",
  "  rm -rf $r; mkdir -p $r",
  '  [ -n "$url" ] || { echo no-url; return 1; }',
  '  curl --connect-timeout 10 --max-time 120 --fail --silent --show-error -o $r/bundle.tgz "$url" 2>/dev/null || { echo fetch-failed; return 1; }',
  "  addr=${url%%\\?*}",
  '  [ "$(sha256sum $r/bundle.tgz | cut -c1-64)" = "${addr##*/}" ] || { echo archive-hash-mismatch; return 1; }',
  '  find "$dir" -mindepth 1 -delete || { echo clear-failed; return 1; }',
  '  tar -xzf $r/bundle.tgz --strip-components=1 -C "$dir" || { echo extract-failed; return 1; }',
  "}",
].join("\n");

/**
 * A POSIX sh function, `keel_hydrate <scratch> [url]`, run in the working
 * directory a runner extracted the bundle into. It prints the suite protocol's
 * hydration lines and returns 0 when the tree is the bundle's:
 * - `KEEL_HYDRATION ok` when the tree verifies as extracted;
 * - otherwise, after diagnosing the tree (DIAGNOSE_BUNDLE_SH), one verified
 *   refetch (REHYDRATE_BUNDLE_SH). If the refetched tree verifies, it prints
 *   `KEEL_HYDRATION_RETRIED <first reason>`, then `KEEL_HYDRATION_DIFF`, then
 *   `KEEL_HYDRATION ok`. The retry line comes first, so it stays inside the
 *   head of the output that the Workflows API returns;
 * - if not, `KEEL_HYDRATION_DIFF` and `KEEL_HYDRATION failed <first reason>`,
 *   returning 1. There is never a second refetch.
 */
export const HYDRATE_SH = [
  VERIFY_BUNDLE_SH,
  DIAGNOSE_BUNDLE_SH,
  REHYDRATE_BUNDLE_SH,
  "keel_hydrate() {",
  "  if reason=$(keel_verify_bundle); then echo 'KEEL_HYDRATION ok'; return 0; fi",
  `  diag=$(keel_bundle_diff "$1" "\${2:-}" 2>&1 | head -c 8192 | base64 | tr -d '\\n')`,
  '  if (keel_rehydrate_bundle "$1" "${2:-}" "$(pwd)" >/dev/null) && keel_verify_bundle >/dev/null; then',
  '    echo "KEEL_HYDRATION_RETRIED $reason"; echo "KEEL_HYDRATION_DIFF $diag"; echo "KEEL_HYDRATION ok"; return 0',
  "  fi",
  '  echo "KEEL_HYDRATION_DIFF $diag"; echo "KEEL_HYDRATION failed $reason"; return 1',
  "}",
].join("\n");
