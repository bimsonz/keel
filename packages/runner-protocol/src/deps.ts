import { manifestOf, readBundle, VERIFY_BUNDLE_SH } from "./bundle.ts";
import { signedUrl, urlSigned } from "./signed-url.ts";

/**
 * Deps bundles, as the two boxes handle them: a candidate's `node_modules`,
 * built once in a deps box and fetched by every suite box that needs it. The
 * archive is one gzipped tar of every `node_modules` directory, symlinks kept,
 * split into parts that are each stored under their own sha256. A deps box
 * packs and uploads the parts (`DEPS_BUILD_COMMAND`); a suite box is handed
 * their signed URLs, checks every part against the hash its URL names, and
 * only then untars them (`DEPS_FETCH_SH`).
 *
 * What a candidate needs, the pointer that names a bundle's parts and the
 * reading of the deps box's report are core's (`verification/deps.ts`).
 */

/** Why something is not a deps part Keel signs for, or not a deps box it writes a command for. */
export class DepsRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`deps refused: ${reason}`);
    this.name = "DepsRefused";
    this.reason = reason;
  }
}

/** The virtual host a suite box fetches deps parts from, and a deps box puts them to. */
export const DEPS_HOST = "deps.keel.internal";

/**
 * What a part URL's signature covers: the family, then whose part, which part,
 * and when the URL stops being good. The family comes first, so a part's
 * signature is never a bundle's for the same namespace, hash and expiry, nor
 * a bundle's a part's.
 */
const signedText = (namespace: string, sha256: string, expires: number): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`deps-parts|${namespace}|${sha256}|${expires}`).slice();

/**
 * Where a suite box fetches one part of a namespace's deps bundle, signed by
 * Keel: `<namespace id>/<sha256>` on the deps host, the hex last, since the
 * fetch checks what it got against the URL's last segment, with
 * `?exp=<unix seconds>&sig=<Ed25519 over "deps-parts|<namespace>|<sha256>|<exp>">`.
 * It is signed with the key that signs bundle URLs, over a text no bundle
 * URL's is.
 */
export const signedDepsPartUrl = async (
  signingKey: string,
  namespace: string,
  sha256: string,
  expires: number,
): Promise<string> => {
  if (!/^[A-Za-z0-9_]+$/.test(namespace)) throw new DepsRefused(`not a namespace id: ${namespace}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new DepsRefused(`not a part's sha256: ${sha256}`);
  return signedUrl(
    signingKey,
    `https://${DEPS_HOST}/${namespace}/${sha256}`,
    expires,
    signedText(namespace, sha256, expires),
  );
};

/**
 * Whether a part URL's query carries Keel's signature for this namespace's
 * part, still in date at `now` (unix seconds). The deps host asks before it
 * reads anything: no signature, one past its `exp`, one made for another
 * namespace, part or expiry, or a bundle URL's, is refused alike.
 */
export const depsPartUrlSigned = (
  publicKey: string,
  namespace: string,
  sha256: string,
  query: URLSearchParams,
  now: number,
): Promise<boolean> =>
  urlSigned(publicKey, query, now, (expires) => signedText(namespace, sha256, expires));

/**
 * A bundle as core's `depsNeedFrom` reads one: the text of its manifest
 * (`<sha256>  <path>` lines), made from the bundle's own files with
 * `readBundle`, so it is the manifest of exactly the files the bundle holds,
 * and `read`, the text of the file it holds at a path. The lockfile, the
 * install settings and the commands a deps bundle is built for are read from
 * these.
 */
export const bundleTexts = async (
  bytes: Uint8Array,
): Promise<{ readonly manifest: string; readonly read: (path: string) => string | undefined }> => {
  const files = await readBundle(bytes);
  const held = new Map(files.map((file) => [file.path, file.bytes]));
  const decoder = new TextDecoder();
  return {
    manifest: await manifestOf(files),
    read: (path) => {
      const text = held.get(path);
      return text === undefined ? undefined : decoder.decode(text);
    },
  };
};

/** How a part's file is named in the directory it is packed into: `part-0000`, `part-0001`, …, so name order is part order. */
const PART_NAME = "part-";

/**
 * A POSIX sh function, `keel_deps_pack <dir> <out> <part bytes>`. It packs
 * every `node_modules` directory under `<dir>` that is not inside another, in
 * bytewise path order, into one gzipped tar with symlinks kept as symlinks,
 * and splits it into parts of `<part bytes>` in `<out>`, which it clears
 * first. On success it prints `files <n>` (the regular files and symlinks
 * packed), then one `part <sha256> <bytes>` line per part in order, and
 * returns 0. Otherwise it prints one reason (`no-node-modules` or
 * `pack-failed`) and returns 1.
 *
 * `sh` has no `pipefail`, so tar's and gzip's exit codes are kept in status
 * files beside the parts: a tar that failed half way never leaves parts that
 * look whole. gzip runs at its fastest level, since a build is timed and its
 * parts are stored once, and writes no name or timestamp.
 */
export const DEPS_PACK_SH = [
  "keel_deps_pack() {",
  "  d=$1; o=$2; n=$3",
  '  rm -rf "$o"; mkdir -p "$o" && o=$(cd "$o" && pwd) || { echo pack-failed; return 1; }',
  '  (cd "$d" && find . -name node_modules -type d -prune -print0 | LC_ALL=C sort -z >"$o/.list") || { echo pack-failed; return 1; }',
  '  [ -s "$o/.list" ] || { echo no-node-modules; return 1; }',
  `  (cd "$d" && { tar --null -T "$o/.list" -cf - 2>/dev/null; echo $? >"$o/.tar"; } | { gzip -n -1; echo $? >"$o/.gzip"; } | split -b "$n" -a 4 -d - "$o/${PART_NAME}") || { echo pack-failed; return 1; }`,
  '  [ "$(cat "$o/.tar")" = 0 ] && [ "$(cat "$o/.gzip")" = 0 ] || { echo pack-failed; return 1; }',
  `  files=$(cd "$d" && find . -path '*/node_modules/*' \\( -type f -o -type l \\) -print0 | tr -dc '\\000' | wc -c | tr -d ' ')`,
  '  rm -f "$o/.list" "$o/.tar" "$o/.gzip"',
  '  echo "files $files" >"$o/.report"',
  '  for p in $(ls "$o" | LC_ALL=C sort); do',
  '    h=$(sha256sum "$o/$p" | cut -c1-64); [ ${#h} -eq 64 ] || { echo pack-failed; return 1; }',
  `    echo "part $h $(wc -c <"$o/$p" | tr -d ' ')" >>"$o/.report"`,
  "  done",
  `  [ "$(wc -l <"$o/.report" | tr -d ' ')" -gt 1 ] || { echo pack-failed; return 1; }`,
  '  cat "$o/.report"; rm -f "$o/.report"',
  "}",
].join("\n");

/**
 * A POSIX sh function, `keel_deps_fetch <scratch> <dir> <url>…`, that puts a
 * deps bundle into `<dir>` from its parts' URLs, in order. It fetches every
 * part into `<scratch>/deps`, then checks every part's sha256 against the
 * hash its URL names (the last segment of its path, whatever signature its
 * query carries), and only when all of them match does it untar them, as one
 * stream, into `<dir>`. A part that is not the one its URL names extracts
 * nothing. It prints nothing and returns 0, or prints one reason (`no-parts`,
 * `fetch-failed`, `part-hash-mismatch` or `extract-failed`) and returns 1. A
 * URL's query is never printed.
 *
 * A signed URL holds a `?`, so a caller expands its list of URLs unquoted
 * under `set -f`. Nothing in here relies on a glob.
 */
export const DEPS_FETCH_SH = [
  "keel_deps_fetch() {",
  "  s=$1/deps; dir=$2; shift 2",
  '  rm -rf "$s"; mkdir -p "$s" || { echo fetch-failed; return 1; }',
  "  [ $# -gt 0 ] || { echo no-parts; return 1; }",
  '  i=0; for url in "$@"; do i=$((i + 1)); curl --connect-timeout 10 --max-time 300 --fail --silent --show-error -o "$s/$(printf %04d $i)" "$url" 2>/dev/null || { echo fetch-failed; return 1; }; done',
  '  i=0; for url in "$@"; do i=$((i + 1)); addr=${url%%\\?*}; [ "$(sha256sum "$s/$(printf %04d $i)" | cut -c1-64)" = "${addr##*/}" ] || { echo part-hash-mismatch; return 1; }; done',
  '  { i=0; for url in "$@"; do i=$((i + 1)); cat "$s/$(printf %04d $i)"; done; } | tar -xzf - -C "$dir" 2>/dev/null || { echo extract-failed; return 1; }',
  '  rm -rf "$s"',
  "}",
].join("\n");

/**
 * A POSIX sh function, `keel_deps_drop <dir>`, that removes every
 * `node_modules` directory under `<dir>` that is not inside another: what
 * `keel_deps_fetch` put there. A suite box calls it once its run is over. The
 * CI engine snapshots `/workspace` after a runner exits 0, and fetched deps
 * must not be in the snapshot: they are the deps bundle's to keep, not each
 * run's.
 */
export const DEPS_DROP_SH = [
  "keel_deps_drop() {",
  '  find "$1" -name node_modules -type d -prune -exec rm -rf {} +',
  "}",
].join("\n");

/**
 * A POSIX sh function, `keel_deps_keep <inputs> <sha256> <out>`, that a deps
 * box calls in the candidate's extracted tree before any install. `<inputs>`
 * is a file holding the install inputs the build was asked for (core's
 * `installInputsOf`): the line `keel.install/1`, then one
 * `<sha256>  <path>` line per file an install reads. The file must hash to
 * `<sha256>`, the install digest the build is named by. Every line of its
 * list must be 64 hex characters, two spaces and a path from the tree's root
 * with no `..` segment, and the last must end in a newline as the others do:
 * a list that names no file, a line of any other shape, or a path that leaves
 * the tree is refused before any file is opened. And every file it lists must
 * be in the tree with the hash listed. Each of these is `install-mismatch`.
 * Those files, and no other, are then moved to `<out>` at their own paths
 * (`keep-failed`). It prints nothing and returns 0, or prints the one reason
 * and returns 1.
 *
 * A listed path is the candidate's to choose, so it is never a tool's to
 * read as anything but a file of the tree. The lines are judged as bytes
 * (`LC_ALL=C`), in no locale's letters, and a `grep` that could not judge
 * them refuses them. Each path is hashed with `./` before it, since
 * `sha256sum -c` reads a listed `-` as its standard input, and moved after
 * `--`, since `mv` reads a leading dash as an option. The list so rewritten
 * is a file beside the inputs, written whole before any of it is checked: a
 * `sed` that stopped part way refuses the list, where one piped to the check
 * would leave the lines after it unchecked and their files moved all the
 * same. And nothing the tools say reaches stderr: what they say names the
 * candidate's paths.
 *
 * The install runs on the files in `<out>`. So nothing a candidate holds
 * outside the digest is there for an install to read, and a deps bundle is
 * what its digest's files install to, for every candidate that shares it.
 */
export const DEPS_KEEP_SH = [
  "keel_deps_keep() {",
  "  i=$1; o=$3",
  '  [ -f "$i" ] && [ "$(sha256sum "$i" 2>/dev/null | cut -c1-64)" = "$2" ] || { echo install-mismatch; return 1; }',
  '  [ "$(head -n 1 "$i")" = keel.install/1 ] || { echo install-mismatch; return 1; }',
  `  tail -n +2 "$i" >"$i.lines"; [ "$(tail -c 1 "$i.lines" | wc -l | tr -d ' ')" = 1 ] || { echo install-mismatch; return 1; }`,
  `  LC_ALL=C grep -qvE '^[0-9a-f]{64}  [^/]' "$i.lines" 2>/dev/null; [ $? -eq 1 ] || { echo install-mismatch; return 1; }`,
  `  LC_ALL=C grep -qE '^[0-9a-f]{64}  (.*/)?\\.\\.(/|$)' "$i.lines" 2>/dev/null; [ $? -eq 1 ] || { echo install-mismatch; return 1; }`,
  `  LC_ALL=C sed 's/  /  .\\//' "$i.lines" >"$i.sums" 2>/dev/null || { echo install-mismatch; return 1; }`,
  '  sha256sum --quiet --strict -c "$i.sums" >/dev/null 2>&1 || { echo install-mismatch; return 1; }',
  '  rm -rf "$o" 2>/dev/null; mkdir -p "$o" 2>/dev/null || { echo keep-failed; return 1; }',
  "  while IFS= read -r line; do",
  "    p=${line#*  }",
  '    case $p in */*) mkdir -p "$o/${p%/*}" 2>/dev/null || { echo keep-failed; return 1; } ;; esac',
  '    mv -- "$p" "$o/$p" 2>/dev/null || { echo keep-failed; return 1; }',
  '  done <"$i.lines"',
  "}",
].join("\n");

/**
 * A POSIX sh function, `keel_deps_lock <lockfile>`, that a deps box calls
 * before any install. There must be a lockfile (`no-lockfile`). No
 * `resolution:` in it may be a directory of the candidate's own
 * (`type: directory`, a `file:` dependency on a directory or an injected
 * workspace package): pnpm copies such a directory into `node_modules` and
 * the lockfile holds no hash for it, so it is refused as `local-directory`.
 * And every other must be the public registry's: one naming a `tarball:`
 * anywhere but `https://registry.npmjs.org/`, a `repo:`, or `type: git` is
 * refused as `off-registry <host>`, the host alone and never the URL, which
 * may hold a credential. It prints nothing and returns 0, or prints the one
 * reason and returns 1.
 *
 * It reads a lockfile as pnpm writes one, each resolution a `{…}` on its own
 * line. A resolution written any other way is refused too
 * (`off-registry unknown`), since it cannot be read here. The box's egress is
 * what holds a lockfile to the registry; this check names the reason before
 * an install fails on it.
 */
export const DEPS_LOCK_SH = [
  "keel_deps_lock() {",
  '  [ -f "$1" ] || { echo no-lockfile; return 1; }',
  `  if grep -E "^[[:space:]]*[\\"']?resolution[\\"']?[[:space:]]*:" "$1" | tr -d "\\"'" | grep -qE 'type: *directory|directory: *[^,} ]'; then echo local-directory; return 1; fi`,
  `  off=$(grep -E "^[[:space:]]*[\\"']?resolution[\\"']?[[:space:]]*:" "$1" | tr -d "\\"'" | sed 's|tarball: *https://registry\\.npmjs\\.org/[^,} ]*||g' | grep -E '(tarball|repo): *[^,} ]|type: *git|resolution:[^{]*$|[^}[:space:]][[:space:]]*$' | head -n 1)`,
  '  [ -n "$off" ] || return 0',
  `  host=$(printf '%s\\n' "$off" | sed -E -n 's/.*(tarball|repo): *([^,} ]+).*/\\2/p' | sed -E 's|^[A-Za-z0-9+.-]+://||; s|^[^/@]*@||; s|[/:?#].*$||' | tr -cd 'A-Za-z0-9.-' | cut -c1-100)`,
  '  echo "off-registry ${host:-unknown}"; return 1',
  "}",
].join("\n");

/**
 * What the deps box's command and the reading of its report must agree on.
 * Core holds the same four (`DEPS_BUILD_PROTOCOL`, `DEPS_PART_BYTES`,
 * `DEPS_MAX_BYTES`, `DEPS_INSTALL_SECONDS`): this package imports nothing of
 * core, so they are parameters here, and a test holds `DEPS_BUILD_TERMS` to
 * core's.
 */
export interface DepsBuildTerms {
  /** The report's name, on a line of its own before its markers. */
  readonly protocol: string;
  /** The size the archive is split at. */
  readonly partBytes: number;
  /** The most the parts may come to together. */
  readonly maxBytes: number;
  /** How long the install may run. */
  readonly installSeconds: number;
}

export const DEPS_BUILD_TERMS: DepsBuildTerms = {
  protocol: "KEEL_DEPS_BUILD/1",
  partBytes: 32 * 1024 * 1024,
  maxBytes: 2 * 1024 ** 3,
  installSeconds: 480,
};

/** Where a deps box keeps things. */
export interface DepsBoxPaths {
  /**
   * Where the candidate is extracted and installed: the path a suite box runs
   * a candidate at, so whatever an install writes with an absolute path still
   * points at it there. It is emptied and never removed, since a runtime may
   * mount it.
   */
  readonly workspace: string;
  /**
   * The box's own scratch: the fetched bundle until its tree is verified, the
   * install inputs, pnpm's store, the install's output and the parts.
   */
  readonly scratch: string;
  /** The file the image states its toolchain in, on one line. */
  readonly toolchainFile: string;
}

export const DEPS_BOX_PATHS: DepsBoxPaths = {
  workspace: "/workspace",
  scratch: "/tmp/keel-deps",
  toolchainFile: "/etc/keel-toolchain",
};

const count = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new DepsRefused(`${name} is not a count`);
  return value;
};

const path = (name: string, value: string): string => {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(value))
    throw new DepsRefused(`${name} is not a path a command can hold unquoted`);
  return value;
};

/**
 * The deps box's whole command, as POSIX sh. It always exits 0 and reports
 * in-band, as a Tier 2 runner does: `terms.protocol` on a line of its own,
 * `KEEL_TOOLCHAIN <the image's toolchain>`, then either
 * `KEEL_BUILD refused <reason>` or, once every part is uploaded,
 * `KEEL_FILES <n>`, `KEEL_INSTALL_MS <n>`,
 * `KEEL_PARTS <sha256>:<bytes>,…` and `KEEL_BUILD ok`; then `KEEL_END`.
 * Nothing a candidate holds runs, and none of its output reaches stdout, so
 * no candidate can forge a marker.
 *
 * Its environment: `KEEL_BUNDLE_URL`, the candidate bundle's signed URL,
 * fetched with its scheme rewritten to `http://` (the box has no HTTPS, and
 * the signature does not cover the scheme); `KEEL_INSTALL`, the install digest
 * the build is for, and `KEEL_INSTALL_INPUTS_B64`, the inputs it is the sha256
 * of, as `depsInputsEncoded` writes them; `KEEL_DEPS_UPLOAD`, the base URL each part is PUT under, by
 * its sha256; and `KEEL_REGISTRY` (the public registry over plain HTTP when
 * unset).
 *
 * The steps, each refusing with its reason:
 * 1. fetch the bundle (`bundle-unfetched`), check it against the hash its URL
 *    names (`bundle-hash-mismatch`), extract it into the emptied workspace
 *    and verify the tree against its manifest (`bundle-unverified`), then
 *    delete the fetched archive;
 * 2. `keel_deps_keep` (`install-mismatch`, `keep-failed`), then the workspace
 *    is emptied, the kept files are copied back into it with their modes, and
 *    it must hold exactly the files the install inputs list (`keep-failed`):
 *    what could not be removed is never installed beside. So nothing else of
 *    the candidate is left in the box, in its workspace or in its scratch,
 *    when the install runs. Then `keel_deps_lock` (`no-lockfile`,
 *    `local-directory`, `off-registry <host>`), before any install;
 * 3. `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile
 *    --pm-on-fail=ignore`, within `terms.installSeconds` (`install-timeout`,
 *    `install-failed exit <n>`). A failed install is reported with its exit
 *    status, then the installer's own code for the failure when its output
 *    names one: the first `[ERR_PNPM_…]` that starts a line. The status and
 *    that code, capitals, digits and underscores, are all of the installer's
 *    output that leaves the box, and core reads whose fault it was from them
 *    (`depsRefusal`). It checks every package against the lockfile's
 *    integrity hash. It runs no lifecycle script and loads no pnpmfile, the
 *    candidate's root `.pnpmfile.cjs` or one its settings name: pnpm would
 *    run either as it starts, before it checks anything. And it is the
 *    image's pnpm that installs, whatever `packageManager` the candidate
 *    names: pnpm would otherwise fetch that version and hand the install to
 *    it. The install's last line says which pnpm ran, and one that is not
 *    the toolchain's is refused (`toolchain-switched`), so a pnpm that stops
 *    honouring the setting is seen here and never kept;
 * 4. `keel_deps_pack` (`no-node-modules`, `pack-failed`), refusing parts that
 *    come to more than `terms.maxBytes` (`too-large`);
 * 5. PUT each part (`upload-failed`).
 *
 * The install's time is measured in whole seconds, which `date` gives
 * everywhere.
 */
export const depsBuildCommand = (
  terms: DepsBuildTerms,
  paths: DepsBoxPaths = DEPS_BOX_PATHS,
): string => {
  if (!/^[A-Z_]+\/[0-9]+$/.test(terms.protocol))
    throw new DepsRefused(`${terms.protocol} is not a protocol's name`);
  const partBytes = count("partBytes", terms.partBytes);
  const maxBytes = count("maxBytes", terms.maxBytes);
  const installSeconds = count("installSeconds", terms.installSeconds);
  const build = [
    "set -u",
    VERIFY_BUNDLE_SH,
    DEPS_PACK_SH,
    DEPS_KEEP_SH,
    DEPS_LOCK_SH,
    `K=${path("scratch", paths.scratch)}; W=${path("workspace", paths.workspace)}`,
    `echo ${terms.protocol}`,
    'refuse() { echo "KEEL_BUILD refused $1"; echo KEEL_END; exit 0; }',
    `toolchain=$(cat ${path("toolchainFile", paths.toolchainFile)} 2>/dev/null); echo "KEEL_TOOLCHAIN $toolchain"`,
    // The pnpm the toolchain names, read by its word: the line goes on to name the base.
    "pnpm_named=${toolchain#* pnpm }; pnpm_named=${pnpm_named%% *}",
    'rm -rf "$K"; mkdir -p "$K" "$W" && cd "$W" || refuse no-workspace',
    'find "$W" -mindepth 1 -delete 2>/dev/null',
    'case "${KEEL_BUNDLE_URL:-}" in https://*) url=http://${KEEL_BUNDLE_URL#https://} ;; *) url=${KEEL_BUNDLE_URL:-} ;; esac',
    'curl --connect-timeout 10 --max-time 120 --fail --silent --show-error -o "$K/bundle.tgz" "$url" 2>/dev/null || refuse bundle-unfetched',
    "addr=${url%%\\?*}",
    '[ "$(sha256sum "$K/bundle.tgz" | cut -c1-64)" = "${addr##*/}" ] || refuse bundle-hash-mismatch',
    'tar -xzf "$K/bundle.tgz" --strip-components=1 -C "$W" 2>/dev/null && keel_verify_bundle >/dev/null || refuse bundle-unverified',
    'rm -f "$K/bundle.tgz"',
    'printf %s "${KEEL_INSTALL_INPUTS:-}" >"$K/inputs"',
    'why=$(keel_deps_keep "$K/inputs" "${KEEL_INSTALL:-}" "$K/kept") || refuse "$why"',
    'find "$W" -mindepth 1 -delete 2>/dev/null; cp -Rp "$K/kept/." "$W" 2>/dev/null || refuse keep-failed',
    `rm -rf "$K/kept"; [ "$(cd "$W" && find . ! -type d 2>/dev/null | LC_ALL=C sort)" = "$(tail -n +2 "$K/inputs" | LC_ALL=C sed 's|^.\\{66\\}|./|' | LC_ALL=C sort)" ] || refuse keep-failed`,
    'why=$(keel_deps_lock pnpm-lock.yaml) || refuse "$why"',
    "start=$(date +%s)",
    `CI=1 timeout ${installSeconds} pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --pm-on-fail=ignore --registry="\${KEEL_REGISTRY:-http://registry.npmjs.org/}" --store-dir "$K/store" >"$K/install.log" 2>&1`,
    "code=$?; ms=$(( ($(date +%s) - start) * 1000 ))",
    "[ $code -ne 124 ] || refuse install-timeout",
    `err=$(LC_ALL=C sed -n 's/^\\[\\(ERR_PNPM_[A-Z0-9_]*\\)\\].*/\\1/p' "$K/install.log" 2>/dev/null | head -n 1 | cut -c1-80)`,
    '[ $code -eq 0 ] || refuse "install-failed exit $code${err:+ $err}"',
    `[ "$(sed -n 's/^.* using pnpm v//p' "$K/install.log" | tail -n 1)" = "$pnpm_named" ] || refuse toolchain-switched`,
    `keel_deps_pack "$W" "$K/parts" ${partBytes} >"$K/packed" || refuse "$(head -n 1 "$K/packed")"`,
    "files=0; total=0; list=",
    "while read -r kind a b; do",
    "  case $kind in",
    "    files) files=$a ;;",
    '    part) total=$((total + b)); list="$list${list:+,}$a:$b" ;;',
    "  esac",
    'done <"$K/packed"',
    `[ "$total" -le ${maxBytes} ] || refuse too-large`,
    "n=0",
    "while read -r kind a b; do",
    '  [ "$kind" = part ] || continue',
    `  curl --connect-timeout 10 --max-time 300 --fail --silent --show-error -T "$K/parts/${PART_NAME}$(printf %04d $n)" "\${KEEL_DEPS_UPLOAD:-}/$a" </dev/null >/dev/null 2>&1 || refuse upload-failed`,
    "  n=$((n + 1))",
    'done <"$K/packed"',
    'echo "KEEL_FILES $files"; echo "KEEL_INSTALL_MS $ms"; echo "KEEL_PARTS $list"; echo "KEEL_BUILD ok"; echo KEEL_END',
  ].join("\n");
  // A sandbox session runs a command in its own long-lived shell, so the build is a subshell: `refuse`'s exit
  // ends it alone. A session hands over a value of several lines with every line after the first indented, so
  // the inputs come as one line of base64 (`depsInputsEncoded`) and are read back here, their last newline kept.
  return [
    "(",
    'KEEL_INSTALL_INPUTS=$(printf %s "${KEEL_INSTALL_INPUTS_B64:-}" | base64 -d 2>/dev/null; printf x)',
    "KEEL_INSTALL_INPUTS=${KEEL_INSTALL_INPUTS%x}",
    build,
    ")",
  ].join("\n");
};

/**
 * The install inputs as the box hands them to its command, in
 * `KEEL_INSTALL_INPUTS_B64`: the base64 of their UTF-8 bytes, on one line.
 */
export const depsInputsEncoded = (inputs: string): string => {
  let bytes = "";
  for (const byte of new TextEncoder().encode(inputs)) bytes += String.fromCharCode(byte);
  return btoa(bytes);
};

/** The deps box's command as keel-verify runs it: core's terms, in the image's own paths. */
export const DEPS_BUILD_COMMAND = depsBuildCommand(DEPS_BUILD_TERMS);
