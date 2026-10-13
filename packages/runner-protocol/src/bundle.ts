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

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A key as Terraform gives it: PEM, or the bare base64 of its DER. */
const derOf = (key: string): Uint8Array<ArrayBuffer> =>
  fromBase64(key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""));

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
  const key = await crypto.subtle.importKey(
    "pkcs8",
    derOf(signingKey),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key,
    signedText(namespace, url.slice(url.lastIndexOf("/") + 1), expires),
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${url}?exp=${expires}&sig=${sig}`;
};

/**
 * Whether a bundle URL's query carries Keel's signature for this namespace's
 * bundle, still in date at `now` (unix seconds). The bundle host asks before
 * it reads anything: no signature, one past its `exp`, or one made for
 * another namespace, bundle or expiry is refused alike. It needs only the
 * public key (SPKI), which signs nothing.
 */
export const bundleUrlSigned = async (
  publicKey: string,
  namespace: string,
  sha256: string,
  query: URLSearchParams,
  now: number,
): Promise<boolean> => {
  const [exp, sig] = [query.get("exp"), query.get("sig")];
  if (exp === null || !/^[0-9]{1,12}$/.test(exp)) return false;
  if (sig === null || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return false;
  const expires = Number(exp);
  if (expires < now) return false;
  const key = await crypto.subtle.importKey("spki", derOf(publicKey), { name: "Ed25519" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify(
    "Ed25519",
    key,
    fromBase64(sig.replace(/-/g, "+").replace(/_/g, "/")),
    signedText(namespace, sha256, expires),
  );
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
