import { gitRemote } from "./remote.ts";
import { projectRepos } from "@keeltown/core/application/integration";
import {
  GUARD_FILE,
  guardFileText,
  type ProbeFile,
  readGuardFile,
} from "@keeltown/core/application/verification";
import { CommitSha } from "@keeltown/core/kernel";
import type { AdmittedGuard } from "@keeltown/core/domain/verification";
import {
  AdmittedGuards,
  CodeHost,
  type GuardRefused,
  GuardsUnreadable,
  type RepoRef,
} from "@keeltown/core/ports";
import {
  encodeCommit,
  encodeTree,
  type GitObject,
  hashObject,
  MODE_FILE,
  MODE_TREE,
  type PushOutcome,
  type RefUpdate,
  receivePack,
  type TreeEntry,
  writePack,
  ZERO_OID,
} from "@keeltown/gitcore";
import { Clock, Effect, Layer, Option, Result, Schema } from "effect";

const MAIN = "refs/heads/main";
const SYMLINK = "120000";
const utf8 = new TextDecoder("utf-8");
const encoder = new TextEncoder();
const toCommitSha = Schema.decodeUnknownSync(CommitSha);

/** A guard repo token lives for the one push it is minted for. */
const TOKEN_TTL_SECONDS = 600;

/** How many times an admission reads the guard repo's head again after a push that lost a race or met a busy repo. */
const PUSH_RETRIES = 4;

/** Where a guard's probe files live in its directory, beside guard.json. */
export const PROBE_DIR = "probe";

/**
 * How an admission's commit reaches the guard repo: one ref update and the
 * objects it adds. The deployed push is smart-HTTP receive-pack; a test may
 * write into its own host instead.
 */
export type GuardPush = (
  repo: RepoRef,
  update: RefUpdate,
  objects: readonly GitObject[],
) => Effect.Effect<PushOutcome, never, CodeHost>;

/** receive-pack over the repo's remote, with a write token minted for this push and never logged. */
export const pushOverSmartHttp: GuardPush = (repo, update, objects) =>
  Effect.gen(function* () {
    const host = yield* CodeHost;
    const info = yield* host.info(repo);
    const token = yield* host.mintToken(repo, "write", TOKEN_TTL_SECONDS);
    const pack = yield* Effect.promise(() => writePack(objects));
    return yield* Effect.promise(() =>
      receivePack(gitRemote(info.remote, token.token), [update], pack),
    );
  }).pipe(Effect.catchTag("RepoNotFound", Effect.die));

interface Node {
  readonly files: Map<string, Uint8Array>;
  readonly dirs: Map<string, Node>;
}

/** Writes `files` (paths `/`-separated) as blobs and nested trees: the tree's id, and every object it needs. */
async function writeTree(files: ReadonlyMap<string, Uint8Array>): Promise<{
  readonly tree: string;
  readonly objects: readonly GitObject[];
}> {
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, bytes] of files) {
    const parts = path.split("/");
    const name = parts.pop() ?? "";
    let node = root;
    for (const part of parts) {
      const next = node.dirs.get(part) ?? { files: new Map(), dirs: new Map() };
      node.dirs.set(part, next);
      node = next;
    }
    node.files.set(name, bytes);
  }
  const objects: GitObject[] = [];
  const write = async (node: Node): Promise<string> => {
    const entries: TreeEntry[] = [];
    for (const [name, body] of node.files) {
      objects.push({ type: "blob", body });
      entries.push({ name, mode: MODE_FILE, oid: await hashObject("blob", body) });
    }
    for (const [name, dir] of node.dirs)
      entries.push({ name, mode: MODE_TREE, oid: await write(dir) });
    const body = encodeTree(entries);
    objects.push({ type: "tree", body });
    return hashObject("tree", body);
  };
  return { tree: await write(root), objects };
}

/**
 * AdmittedGuards over CodeHost: the project's guard repo at the head of
 * `main`, one directory per guard. `list` reads each directory through its
 * `guard.json` (a plain file; a symlink is not followed): a repo or branch
 * that does not exist yet means admission has written nothing, so no guards,
 * and a directory whose guard.json is missing or cannot be admitted is
 * refused with its reason, never skipped. `admit` commits
 * `<guardId>/guard.json` and the probe's files under `<guardId>/probe/` onto
 * main, creating the repo on the first admission, with Keel as author and
 * committer; a guard already there as written answers the head, and one
 * there as anything else is a defect, since a guard is admitted once. A push
 * that lost a race to another admission reads the head again.
 */
export const AdmittedGuardsCodeHost = (push: GuardPush = pushOverSmartHttp) =>
  Layer.effect(
    AdmittedGuards,
    Effect.gen(function* () {
      const host = yield* CodeHost;
      const headOf = (repo: RepoRef) =>
        host.head(repo, MAIN).pipe(
          Effect.map(Option.some),
          Effect.catchTag("RefNotFound", () => Effect.succeed(Option.none<CommitSha>())),
        );
      return AdmittedGuards.of({
        list: (projectId) => {
          const repo = projectRepos(projectId).guards;
          return Effect.gen(function* () {
            const head = yield* headOf(repo).pipe(
              Effect.catchTag("RepoNotFound", () => Effect.succeed(Option.none<CommitSha>())),
            );
            if (Option.isNone(head)) return { admitted: [], refused: [] };
            const entries = yield* host.readTree(repo, head.value);
            const admitted: AdmittedGuard[] = [];
            const refused: GuardRefused[] = [];
            for (const dir of entries.filter((e) => e.type === "tree" && !e.path.includes("/"))) {
              const path = `${dir.path}/${GUARD_FILE}`;
              const file = entries.find((e) => e.path === path);
              if (file === undefined || file.type !== "blob" || file.mode === SYMLINK) {
                refused.push({
                  guardId: dir.path,
                  reason: `${path} is ${file === undefined ? "missing" : "not a plain file"}`,
                });
                continue;
              }
              const read = readGuardFile(
                dir.path,
                utf8.decode(yield* host.readBlob(repo, file.oid)),
              );
              if (Result.isSuccess(read)) admitted.push(read.success);
              else refused.push({ guardId: dir.path, reason: read.failure });
            }
            return { admitted, refused };
          }).pipe(
            Effect.mapError(
              (e) =>
                new GuardsUnreadable({
                  reason: `the guard repo ${repo.namespace}/${repo.name} could not be read: ${e._tag}`,
                }),
            ),
          );
        },
        admit: (projectId, guard, files: readonly ProbeFile[]) => {
          const repo = projectRepos(projectId).guards;
          const dir = guard.guardId;
          const text = guardFileText(guard);
          return Effect.gen(function* () {
            yield* host.create(repo).pipe(Effect.catchTag("RepoAlreadyExists", () => Effect.void));
            for (let attempt = 0; attempt <= PUSH_RETRIES; attempt += 1) {
              const head = yield* headOf(repo);
              const root: TreeEntry[] = [];
              if (Option.isSome(head)) {
                const top = yield* host.listDir(repo, head.value, "");
                if (top.some((e) => e.path === dir)) {
                  const held = (yield* host.listDir(repo, head.value, dir)).find(
                    (e) => e.path === `${dir}/${GUARD_FILE}` && e.type === "blob",
                  );
                  const heldText =
                    held === undefined
                      ? undefined
                      : utf8.decode(yield* host.readBlob(repo, held.oid));
                  if (heldText === text) return head.value;
                  return yield* Effect.die(
                    new Error(`${dir} is already in the guard repo as another guard`),
                  );
                }
                root.push(...top.map((e) => ({ name: e.path, mode: e.mode, oid: e.oid })));
              }
              const written = yield* Effect.promise(() =>
                writeTree(
                  new Map([
                    [GUARD_FILE, encoder.encode(text)],
                    ...files.map((f): [string, Uint8Array] => [
                      `${PROBE_DIR}/${f.path}`,
                      encoder.encode(f.text),
                    ]),
                  ]),
                ),
              );
              const tree = encodeTree([...root, { name: dir, mode: MODE_TREE, oid: written.tree }]);
              const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
              const keel = { name: "Keel", email: "keel@keel.invalid", time };
              const treeOid = yield* Effect.promise(() => hashObject("tree", tree));
              const commit = encodeCommit({
                tree: treeOid,
                parents: Option.isSome(head) ? [head.value] : [],
                author: keel,
                committer: keel,
                message: `Admit guard ${dir}`,
                trailers: [
                  ["Guard-Id", dir],
                  ["Probe", guard.probe],
                ],
              });
              const oid = yield* Effect.promise(() => hashObject("commit", commit));
              const outcome = yield* push(
                repo,
                { ref: MAIN, old: Option.isSome(head) ? head.value : ZERO_OID, new: oid },
                [
                  ...written.objects,
                  { type: "tree", body: tree },
                  { type: "commit", body: commit },
                ],
              ).pipe(Effect.provideService(CodeHost, host));
              if (outcome.kind === "applied") return toCommitSha(oid);
              if (outcome.kind === "failed")
                return yield* Effect.die(
                  new Error(`the push to the guard repo failed with ${outcome.status}`),
                );
              // Busy, or another admission moved main first: wait a little, then read the head again.
              yield* Effect.sleep(50 * 2 ** attempt);
            }
            return yield* Effect.die(
              new Error(`the guard repo kept moving under the admission of ${dir}`),
            );
          }).pipe(
            Effect.catchTags({
              RepoNotFound: Effect.die,
              ObjectNotFound: Effect.die,
              PathNotFound: Effect.die,
            }),
          );
        },
      });
    }),
  );
