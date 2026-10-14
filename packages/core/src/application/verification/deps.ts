import { Effect, Schema } from "effect";
import type { ContentHash, NamespaceId } from "../../domain/kernel/index.ts";
import type { PlanStep, StepResult } from "../../domain/verification/index.ts";
import { DepsBuilder } from "../ports/index.ts";
import { readMarkers, type RunnerEvidence } from "./runner-output.ts";

/**
 * Deps bundles: a candidate's `node_modules`, built once for a namespace and
 * an install digest and fetched by every Tier 2 step that needs it. The
 * digest is the sha256 of every file of the candidate an install reads
 * (`installInputsOf`), so two candidates share a bundle only when all of
 * those are the same bytes. A deps box installs from the candidate's own
 * `pnpm-lock.yaml` with no lifecycle scripts, tars every `node_modules`
 * directory with its symlinks, and uploads the gzipped archive in parts, each
 * under its own sha256. The pointer (`keel.deps/1`) is written last, at the
 * namespace's `deps` key for the digest, and names the parts. A suite box is
 * handed the parts' signed URLs, checks each part against the hash its URL
 * names, and untars them before it runs.
 *
 * This file is the pure half: what a candidate needs, whether a pointer serves
 * it, what a step is handed, and how the deps box's report is read. The shell
 * both boxes run is the runner protocol's.
 */

/**
 * The toolchain a deps bundle is built with, as the deps box's image states
 * it: node, pnpm and the box's base, since a native module built against
 * another libc is another bundle. A pointer records it, and one built with
 * another is never reused.
 */
export const DEPS_TOOLCHAIN = "node v22.22.3 pnpm 11.18.0 ubuntu 24.04";

/** The size the gzipped archive is split at: every part but the last is exactly this long. */
export const DEPS_PART_BYTES = 32 * 1024 * 1024;

/** The most a deps bundle's parts may come to together. A larger one is refused `too-large`. */
export const DEPS_MAX_BYTES = 2 * 1024 ** 3;

/** How long the install may run. Past it the build is refused `install-timeout`. */
export const DEPS_INSTALL_SECONDS = 480;

/** The name of the deps box's in-band report, on a line of its own before its markers. */
export const DEPS_BUILD_PROTOCOL = "KEEL_DEPS_BUILD/1";

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/**
 * A candidate with a lockfile: its install inputs (`installInputsOf`), the
 * only files of it a deps box installs from, and their sha256, the install
 * digest that names its deps bundle.
 */
export const Locked = Schema.TaggedStruct("Locked", { install: Sha256Hex, inputs: Schema.String });
export type Locked = typeof Locked.Type;

/** A candidate no deps bundle can be built for, and why. */
export const Unlocked = Schema.TaggedStruct("Unlocked", { reason: Schema.String });
export type Unlocked = typeof Unlocked.Type;

/**
 * A candidate whose bundle could not be read, so what it needs is not known,
 * and why. No DepsBuilder answers it: `ensureDeps` keeps it as its first
 * step's value when the builder fails.
 */
export const NeedUnread = Schema.TaggedStruct("NeedUnread", { reason: Schema.String });
export type NeedUnread = typeof NeedUnread.Type;

/** What a candidate needs of a deps bundle. Plain data, so the durable step that reads it keeps it. */
export const DepsNeed = Schema.Union([Locked, Unlocked, NeedUnread]);
export type DepsNeed = typeof DepsNeed.Type;

const LOCKFILE = "pnpm-lock.yaml";
const WORKSPACE_FILE = "pnpm-workspace.yaml";
const NPMRC = ".npmrc";
const PACKAGE_FILE = "package.json";

/** The first line of the text an install digest is the sha256 of. */
export const INSTALL_INPUTS_FORMAT = "keel.install/1";

/**
 * The longest install inputs a deps box is handed, in bytes of UTF-8: about
 * 600 files. They travel to the box in one environment variable, which a
 * kernel caps at 128 KiB. A candidate with more is `Unlocked`.
 */
export const INSTALL_INPUTS_MAX = 64 * 1024;

/** One line of a bundle's manifest: `<sha256 hex>  <path>`. */
const MANIFEST_LINE = /^[0-9a-f]{64} {2}(.+)$/s;

const isPackageFile = (path: string): boolean =>
  path === PACKAGE_FILE || path.endsWith(`/${PACKAGE_FILE}`);

/**
 * Whether an install reads the file at `path`, a path from the candidate's
 * root, whatever any file says: the lockfile, the two settings files, and
 * every `package.json`. A file named as one of the first three deeper in the
 * tree is another file: `packages/x/pnpm-lock.yaml` is not the lockfile.
 */
const installReads = (path: string): boolean =>
  path === LOCKFILE || path === WORKSPACE_FILE || path === NPMRC || isPackageFile(path);

/**
 * The path `target` names from the directory `dir` (`""` for the root), as a
 * path from the root with no empty, `.` or `..` segment. pnpm joins a target
 * onto its package's directory and only then asks whether the result is still
 * inside it, and so does this: from `packages/x`, `../x/cli.js` climbs out
 * and comes back as `packages/x/cli.js`. Undefined when the result is outside
 * the directory, and when the target climbs above the root on its way, since
 * no path here holds the root's own name.
 *
 * Undefined too when the result is the directory itself. pnpm counts that as
 * inside, so to it a `directories.bin` of `.` makes every file of the package
 * a command. Following pnpm there would put a whole package in the key, and
 * every edit to its source would be another deps bundle.
 */
const pathWithin = (dir: string, target: string): string | undefined => {
  const segments: string[] = [];
  for (const segment of `${dir}/${target}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return undefined;
  }
  const at = segments.join("/");
  if (dir === "") return at === "" ? undefined : at;
  return at.startsWith(`${dir}/`) ? at : undefined;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** What a parsed JSON value holds under `name`. Only an object holds anything. */
const field = (of: unknown, name: string): unknown => (isRecord(of) ? of[name] : undefined);

/**
 * The commands the `package.json` at `path` declares, as paths from the root:
 * the files its `bin` names (one string, or each string of an object), and
 * the directory its `directories.bin` names, every file under which is a
 * command. A target that lands outside the package's own directory is no
 * command to pnpm and is left out (`pathWithin`), and a file that is not JSON
 * declares none.
 */
const commandsOf = (
  path: string,
  text: string,
): { readonly files: readonly string[]; readonly dirs: readonly string[] } => {
  const dir = path === PACKAGE_FILE ? "" : path.slice(0, -PACKAGE_FILE.length - 1);
  let json: unknown;
  try {
    json = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch {
    json = undefined;
  }
  const within = (targets: readonly unknown[]): string[] =>
    targets.flatMap((target) => {
      const at = typeof target === "string" ? pathWithin(dir, target) : undefined;
      return at === undefined ? [] : [at];
    });
  const bin = field(json, "bin");
  return {
    files: within(typeof bin === "object" && bin !== null ? Object.values(bin) : [bin]),
    dirs: within([field(field(json, "directories"), "bin")]),
  };
};

/**
 * Every file of a candidate an install reads, as its bundle's manifest lists
 * them: the `keel.install/1` line, then the manifest's own `<sha256>  <path>`
 * lines for those files, in the manifest's order. They are the root
 * `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `.npmrc`, every `package.json`,
 * and every file a `package.json` declares as a command (`bin`, and the files
 * under `directories.bin`), which pnpm reads to write the command's shim into
 * each dependent's `node_modules/.bin`. `read` answers the text of the
 * manifest's file at a path. Undefined for a candidate with no
 * `pnpm-lock.yaml` at its root.
 *
 * The sha256 of this text is the candidate's install digest. An edit to any
 * of these files, or one of them added or removed, is another digest and
 * another deps bundle beside the first; an edit to any other file is the same
 * digest. The deps box is handed this text and keeps these files and no
 * other before it installs (the runner protocol's `keel_deps_keep`), so an
 * install cannot read a file the digest does not cover, whatever this list
 * leaves out: a file it leaves out is one no candidate's install sees.
 */
export const installInputsOf = (
  manifest: string,
  read: (path: string) => string | undefined,
): string | undefined => {
  const listed = new Map<string, string>();
  for (const line of manifest.split("\n")) {
    const [, path] = MANIFEST_LINE.exec(line) ?? [];
    if (path !== undefined) listed.set(path, line);
  }
  if (!listed.has(LOCKFILE)) return undefined;
  const commands = new Set<string>();
  const commandDirs: string[] = [];
  for (const path of listed.keys()) {
    if (!isPackageFile(path)) continue;
    const declared = commandsOf(path, read(path) ?? "");
    for (const file of declared.files) commands.add(file);
    commandDirs.push(...declared.dirs);
  }
  const lines = [INSTALL_INPUTS_FORMAT];
  for (const [path, line] of listed)
    if (
      installReads(path) ||
      commands.has(path) ||
      commandDirs.some((dir) => path.startsWith(`${dir}/`))
    )
      lines.push(line);
  return `${lines.join("\n")}\n`;
};

/** How many bytes `text` is as UTF-8. Core holds no encoder. */
const utf8Bytes = (text: string): number => {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
};

/**
 * What a candidate needs, read from its bundle's manifest (`<sha256>  <path>`
 * lines, as the bundle carries them) and, through `read`, the text of the
 * `package.json` files it lists: `Locked` with its install inputs and their
 * digest, the sha256 of the inputs as `sha256` gives it in lowercase hex. A
 * candidate with no lockfile is `Unlocked`, since a deps box installs only
 * from a frozen lockfile, and so is one whose inputs are longer than
 * INSTALL_INPUTS_MAX. Every DepsBuilder answers `need` with this, so only the
 * reading and the hashing are an adapter's own.
 */
export const depsNeedFrom = <E, R>(
  manifest: string,
  read: (path: string) => string | undefined,
  sha256: (text: string) => Effect.Effect<string, E, R>,
): Effect.Effect<DepsNeed, E, R> => {
  const inputs = installInputsOf(manifest, read);
  if (inputs === undefined)
    return Effect.succeed({
      _tag: "Unlocked",
      reason: `no-lockfile: the candidate has no ${LOCKFILE} at its root`,
    });
  if (utf8Bytes(inputs) > INSTALL_INPUTS_MAX)
    return Effect.succeed({
      _tag: "Unlocked",
      reason: `install-inputs-too-large: an install of the candidate reads more files than a deps box is handed`,
    });
  return Effect.map(sha256(inputs), (install): DepsNeed => ({ _tag: "Locked", install, inputs }));
};

/** One part of a deps bundle's gzipped archive: its own sha256, which is its address, and its length. */
export const DepsPart = Schema.Struct({
  sha256: Sha256Hex,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type DepsPart = typeof DepsPart.Type;

/**
 * What is kept at a namespace's `deps` key for an install digest: the parts
 * of the bundle built for it, in order, and what it was built with. Written
 * once every part is stored, so a pointer never names a part that is not
 * there, and one that names no part is no pointer.
 */
export const DepsPointer = Schema.Struct({
  format: Schema.Literal("keel.deps/1"),
  install: Sha256Hex,
  toolchain: Schema.String,
  parts: Schema.Array(DepsPart).check(Schema.isMinLength(1)),
  /** How many regular files and symlinks the archive holds. */
  files: Schema.Int,
  installMs: Schema.Int,
});
export type DepsPointer = typeof DepsPointer.Type;

/**
 * Whether a stored pointer is the deps bundle `need` asks for: the same
 * install digest, built with this toolchain. Each digest has its own key, so
 * the pointer found there that does not serve is one built with another
 * toolchain: it is treated as missing, and the build that follows writes over
 * it. A pointer for another digest is at another key and is never written
 * over.
 */
export const pointerServes = (
  pointer: DepsPointer,
  need: Locked,
  toolchain: string = DEPS_TOOLCHAIN,
): boolean => pointer.install === need.install && pointer.toolchain === toolchain;

/** The deps bundle is there: its parts, in the order they are untarred. */
export const DepsReady = Schema.TaggedStruct("DepsReady", {
  install: Sha256Hex,
  parts: Schema.Array(DepsPart),
});
export type DepsReady = typeof DepsReady.Type;

/**
 * No deps bundle can be had for this candidate now, and why: a bundle or a
 * part that is not kept, a box that fell over, a registry that did not
 * answer, an install that failed with nothing to say whose fault it was. A
 * retry may change it, so every step that needs the bundle abstains with the
 * reason and the change parks.
 */
export const DepsUnavailable = Schema.TaggedStruct("DepsUnavailable", { reason: Schema.String });
export type DepsUnavailable = typeof DepsUnavailable.Type;

/**
 * No deps bundle can be built for this candidate until the candidate itself
 * changes, and why: no lockfile, a lockfile the installer refuses, an install
 * past its limits. No retry changes it, so every step that needs the bundle
 * fails with the reason and what to do about it (`depsStop`), and the verdict
 * bounces on the first round.
 */
export const DepsRefused = Schema.TaggedStruct("DepsRefused", { reason: Schema.String });
export type DepsRefused = typeof DepsRefused.Type;

/** The plan holds no step that needs dependencies, so none were looked for. */
export const DepsUnneeded = Schema.TaggedStruct("DepsUnneeded", {});
export type DepsUnneeded = typeof DepsUnneeded.Type;

/** What a Tier 2 step is handed with its job. Plain data, so the durable step that answers it keeps it. */
export const DepsAnswer = Schema.Union([DepsReady, DepsUnavailable, DepsRefused, DepsUnneeded]);
export type DepsAnswer = typeof DepsAnswer.Type;

/** Whether a plan needs a deps bundle at all: only a step that runs in a container does. */
export const needsDeps = (steps: readonly PlanStep[]): boolean =>
  steps.some((step) => step.tier.tier === 2);

/**
 * What the deps box reported. `built` is a bundle whose every part the box
 * uploaded; `refused` a build the box would not or could not make, with its
 * reason; `malformed` output that is not one well-formed report.
 */
export type DepsBuildOutput =
  | {
      readonly _tag: "built";
      readonly toolchain: string;
      readonly files: number;
      readonly installMs: number;
      readonly parts: readonly DepsPart[];
    }
  | { readonly _tag: "refused"; readonly reason: string }
  | { readonly _tag: "malformed"; readonly reason: string };

const malformed = (reason: string): DepsBuildOutput => ({ _tag: "malformed", reason });

/** A count as the box prints one: decimal digits and nothing else. */
const COUNT = /^(?:0|[1-9][0-9]*)$/;

/** One item of `KEEL_PARTS`: `<sha256 hex>:<bytes>`, the bytes a positive count. */
const PART = /^([0-9a-f]{64}):([1-9][0-9]*)$/;

/**
 * Reads the deps box's stdout. Its command always exits 0 and reports in-band,
 * as a Tier 2 runner does (`runner-output.ts`): between `KEEL_DEPS_BUILD/1`
 * and `KEEL_END`,
 *
 *   KEEL_TOOLCHAIN <text>                    the toolchain the box's image states
 *   KEEL_BUILD ok | refused <reason>         whether every part was built and uploaded
 *
 * and, only after `ok`:
 *
 *   KEEL_FILES <n>                           the regular files and symlinks packed
 *   KEEL_INSTALL_MS <n>
 *   KEEL_PARTS <sha256>:<bytes>,…            each part in order, by its own sha256
 *
 * Only a report that says `ok` and names at least one part, each with a hash
 * and a size a part can have, reads as `built`. Parts that come to more than
 * DEPS_MAX_BYTES together are refused `too-large`, whatever the box said.
 */
export const parseDepsBuild = (stdout: string): DepsBuildOutput => {
  const read = readMarkers(stdout, DEPS_BUILD_PROTOCOL, "deps build");
  if (read._tag === "malformed") return read;
  const { fields } = read;
  const build = fields.get("KEEL_BUILD");
  if (build === undefined) return malformed("no KEEL_BUILD");
  if (build.startsWith("refused ") && build.length > "refused ".length)
    return { _tag: "refused", reason: build.slice("refused ".length) };
  if (build !== "ok") return malformed("bad KEEL_BUILD");
  const toolchain = fields.get("KEEL_TOOLCHAIN");
  if (toolchain === undefined || toolchain.length === 0) return malformed("no KEEL_TOOLCHAIN");
  const files = fields.get("KEEL_FILES");
  if (files === undefined || !COUNT.test(files)) return malformed("bad KEEL_FILES");
  const installMs = fields.get("KEEL_INSTALL_MS");
  if (installMs === undefined || !COUNT.test(installMs)) return malformed("bad KEEL_INSTALL_MS");
  const parts: DepsPart[] = [];
  for (const item of (fields.get("KEEL_PARTS") ?? "").split(",")) {
    const [, sha256, size] = PART.exec(item) ?? [];
    const bytes = Number(size);
    if (sha256 === undefined || !Number.isSafeInteger(bytes) || bytes > DEPS_PART_BYTES)
      return malformed("bad KEEL_PARTS");
    parts.push({ sha256, bytes });
  }
  if (parts.reduce((total, part) => total + part.bytes, 0) > DEPS_MAX_BYTES)
    return { _tag: "refused", reason: "too-large" };
  return { _tag: "built", toolchain, files: Number(files), installMs: Number(installMs), parts };
};

/**
 * The installer's error codes that name a fault of the candidate's own
 * lockfile, as pnpm 11 prints them in the deps box's image: a lockfile behind
 * its `package.json`, one that is not YAML, one of a version this pnpm does
 * not read, one with no entry for a package it names, one made under other
 * settings, and a package or a version the registry answers 404 for. No retry
 * changes any of them.
 *
 * Every other code is left out on purpose, and so is an install that names
 * none. pnpm names a registry's 5xx, 429, 401 and 403 by its status, and
 * prints only a stack trace for a connection that was refused, reset, cut
 * short or never answered, and for a name that does not resolve. A tarball
 * whose hash is not the lockfile's is left out too, since a download cut
 * short can read the same. A registry's outage must never tell every change
 * in flight that its lockfile is wrong.
 */
export const INSTALL_FAULTS_OF_THE_LOCKFILE: readonly string[] = [
  "ERR_PNPM_OUTDATED_LOCKFILE",
  "ERR_PNPM_BROKEN_LOCKFILE",
  "ERR_PNPM_LOCKFILE_BREAKING_CHANGE",
  "ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY",
  "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH",
  "ERR_PNPM_FETCH_404",
];

/** An install that failed, as the deps box reports it with the installer's own code: `install-failed exit <n> <code>`. */
const INSTALL_FAILED = /^install-failed exit [0-9]+ (ERR_PNPM_[A-Z0-9_]+)$/;

/**
 * The deps box's refusals that only a change to the candidate ends, by their
 * first word, with what to do about each. `no-lockfile` and
 * `install-inputs-too-large` are also `depsNeedFrom`'s, before any box.
 */
const REFUSALS_OF_THE_CANDIDATE: Readonly<Record<string, string>> = {
  "no-lockfile": `commit a ${LOCKFILE} at the repository's root (run pnpm install): dependencies are installed only from a frozen lockfile`,
  "install-inputs-too-large": `an install of this repository reads more ${PACKAGE_FILE} and command files than one build is handed: keep fewer of them`,
  "local-directory": `the lockfile installs a directory of the repository's own (a file: or injected dependency), which is not installed: depend on it as a workspace package or from the registry`,
  "off-registry": `the lockfile names a package that is not from https://registry.npmjs.org/, the only registry installed from: depend on a registry package`,
  "install-timeout": `the install ran longer than ${DEPS_INSTALL_SECONDS} seconds: depend on less`,
  "toolchain-switched": `the repository made another pnpm run the install: name ${DEPS_TOOLCHAIN.replace(/^.*\bpnpm (\S+).*$/, "pnpm@$1")} as its packageManager, or none`,
  "too-large": `the installed dependencies come to more than ${DEPS_MAX_BYTES / 1024 ** 3} GiB gzipped: depend on less`,
  "no-node-modules": `the install made no node_modules: add the dependencies the suite and the typecheck run with, and commit the ${LOCKFILE}`,
};

/** The first word of a reason: up to its first space or colon. */
const firstWord = (reason: string): string => /^[^ :]*/.exec(reason)?.[0] ?? "";

/**
 * Whose a deps box's refusal is, by its reason. The candidate's own, which
 * only a change to it ends, is `DepsRefused`: the refusals above, and an
 * install that failed with one of INSTALL_FAULTS_OF_THE_LOCKFILE. Every other
 * is `DepsUnavailable`, whatever it says: Keel's own failures, a registry's,
 * and anything this cannot read. Parking a change that should have bounced
 * costs it a retry; bouncing one that should have parked tells an agent its
 * lockfile is wrong when it is not.
 */
export const depsRefusal = (reason: string): DepsRefused | DepsUnavailable => {
  const [, code] = INSTALL_FAILED.exec(reason) ?? [];
  const candidates =
    code === undefined
      ? Object.hasOwn(REFUSALS_OF_THE_CANDIDATE, firstWord(reason))
      : INSTALL_FAULTS_OF_THE_LOCKFILE.includes(code);
  return candidates ? { _tag: "DepsRefused", reason } : { _tag: "DepsUnavailable", reason };
};

/** What to do about a `DepsRefused`, by its reason. */
export const depsRemedy = (reason: string): string => {
  const [, code] = INSTALL_FAILED.exec(reason) ?? [];
  if (code === "ERR_PNPM_FETCH_404")
    return `the lockfile names a package or a version the registry does not have: correct it, run pnpm install and commit the ${LOCKFILE}`;
  if (code !== undefined)
    return `the installer refused the lockfile (${code}): run pnpm install and commit the ${LOCKFILE} it writes`;
  const word = firstWord(reason);
  // Only a word of the table's own: `constructor` is no refusal, and an object answers to it.
  const own = Object.hasOwn(REFUSALS_OF_THE_CANDIDATE, word)
    ? REFUSALS_OF_THE_CANDIDATE[word]
    : undefined;
  return own ?? `change what the candidate installs, then commit its ${LOCKFILE}`;
};

/** What a Tier 2 step stores when it was handed no deps bundle: for a refusal, the reason and what to do about it. */
export interface DepsStopEvidence extends RunnerEvidence {
  readonly deps?: { readonly refused: string; readonly remedy: string };
}

/**
 * What a Tier 2 step answers when it was handed no deps bundle, and the
 * evidence it stores: no runner is asked. `DepsRefused` fails the step with `deps-refused: <reason>` and what to do,
 * so the verdict bounces. `DepsUnavailable` abstains with
 * `deps-unavailable: <reason>`, and so does a step handed `DepsUnneeded`,
 * which no plan with a Tier 2 step is.
 */
export const depsStop = (
  step: PlanStep,
  deps: DepsUnavailable | DepsRefused | DepsUnneeded,
): { readonly report: StepResult; readonly evidence: DepsStopEvidence } => {
  const refused = deps._tag === "DepsRefused";
  const outcome = refused ? "fail" : "abstain";
  const reason = deps._tag === "DepsUnneeded" ? "no deps were ensured for this step" : deps.reason;
  return {
    report: {
      stepId: step.id,
      outcome,
      evidenceClass: step.evidenceCeiling,
      tier: step.tier,
      durationMs: 0,
    },
    evidence: {
      stepId: step.id,
      outcome,
      why: `${refused ? "deps-refused" : "deps-unavailable"}: ${reason}`,
      tail: "",
      ...(refused ? { deps: { refused: reason, remedy: depsRemedy(reason) } } : {}),
    },
  };
};

/**
 * The two durable steps of a Workflow that ensures deps, as `ensureDeps` uses
 * them. Each runs its effect once and keeps its value, so a replay answers the
 * kept value and the port is not asked again.
 */
export interface DepsSteps {
  /** The durable step `deps-need`. */
  readonly need: (run: Effect.Effect<DepsNeed>) => Effect.Effect<DepsNeed>;
  /** The durable step `deps:<install>`, named by the install digest. */
  readonly build: (install: string, run: Effect.Effect<DepsAnswer>) => Effect.Effect<DepsAnswer>;
}

const unread = (reason: string) => Effect.succeed<DepsNeed>({ _tag: "NeedUnread", reason });

/**
 * The deps a plan's Tier 2 steps are handed, before the first of them runs. A
 * plan with no Tier 2 step needs none, and neither step runs. Otherwise the
 * need is read from the candidate bundle in one step, since its install
 * digest names the second: the build, or the pointer already kept for that
 * digest. A candidate with no lockfile, or whose install inputs are longer
 * than a deps box is handed, is `DepsRefused` with the reason: only a change
 * to it ends that. One whose bundle is missing or unreadable is
 * `DepsUnavailable` with the reason. Neither builds anything.
 */
export const ensureDeps = (
  namespace: NamespaceId,
  bundle: ContentHash,
  planSteps: readonly PlanStep[],
  steps: DepsSteps,
): Effect.Effect<DepsAnswer, never, DepsBuilder> =>
  Effect.gen(function* () {
    if (!needsDeps(planSteps)) return { _tag: "DepsUnneeded" } satisfies DepsAnswer;
    const builder = yield* DepsBuilder;
    const need = yield* steps.need(
      builder.need(namespace, bundle).pipe(
        Effect.catchTag("BundleMissing", (e) =>
          unread(`bundle-missing: the candidate bundle ${e.hash} is not kept for ${namespace}`),
        ),
        Effect.catchTag("ManifestUnreadable", (e) => unread(`bundle-unreadable: ${e.reason}`)),
      ),
    );
    if (need._tag === "Unlocked")
      return { _tag: "DepsRefused", reason: need.reason } satisfies DepsAnswer;
    if (need._tag === "NeedUnread")
      return { _tag: "DepsUnavailable", reason: need.reason } satisfies DepsAnswer;
    return yield* steps.build(need.install, builder.build(namespace, need, bundle));
  });
