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

/** The virtual host a sandbox fetches bundles from; KeelSandbox's outbound handler answers it from R2. */
export const BUNDLE_HOST = "bundles.keel.internal";

/** Where a sandbox fetches the bundle `sha256:<hex>`: no public URL and no token, ever. */
export const bundleUrl = (hash: string): string => {
  const digest = /^sha256:([0-9a-f]{64})$/.exec(hash)?.[1];
  if (digest === undefined) throw new BundleRefused(`not a bundle hash: ${hash}`);
  return `https://${BUNDLE_HOST}/${digest}`;
};

/**
 * A POSIX sh function, `keel_verify_bundle`, that checks the working directory
 * against the bundle's manifest: every listed file present with its hash, and
 * no file the manifest does not list. It prints nothing and returns 0 on a
 * match; otherwise it prints one reason (`no-manifest`, `hash-mismatch` or
 * `count-<found>-of-<listed>`) and returns 1. Runners call it before running
 * anything, so a partial extraction never runs a subset of the tests.
 */
export const VERIFY_BUNDLE_SH = [
  "keel_verify_bundle() {",
  `  [ -f ${BUNDLE_MANIFEST} ] || { echo no-manifest; return 1; }`,
  `  sha256sum --quiet --strict -c ${BUNDLE_MANIFEST} >/dev/null 2>&1 || { echo hash-mismatch; return 1; }`,
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
  "  r=$s/refetch; rm -rf $r; mkdir -p $r/tree",
  `  http=$(curl --connect-timeout 10 --max-time 60 --silent --show-error -o $r/bundle.tgz -w '%{http_code}' "$url" 2>$r/curl.err); rc=$?`,
  `  echo "refetch curl $rc http $http bytes $(wc -c < $r/bundle.tgz 2>/dev/null | tr -d ' ') sha256 $(sha256sum $r/bundle.tgz 2>/dev/null | cut -c1-64) want \${url##*/}"`,
  `  if [ -s $r/curl.err ]; then echo "refetch curl says $(head -c 300 $r/curl.err | tr '\\n' ' ')"; fi`,
  '  if gzip -t $r/bundle.tgz 2>/dev/null; then echo "refetch gzip ok"; else echo "refetch gzip bad"; fi',
  `  if tar -xzf $r/bundle.tgz --strip-components=1 -C $r/tree 2>$r/tar.err; then echo "refetch tar ok"; else echo "refetch tar failed $(head -c 300 $r/tar.err | tr '\\n' ' ')"; fi`,
  '  if v=$(cd $r/tree && keel_verify_bundle); then echo "refetch verifies ok"; else echo "refetch verifies no: $v"; fi',
  "  diff -rq $r/tree . 2>&1 | head -20 | sed 's/^/vs-refetch /'",
  "}",
].join("\n");
