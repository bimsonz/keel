import { projectRepos } from "@keeltown/core/application/integration";
import { GUARD_FILE, readGuardFile } from "@keeltown/core/application/verification";
import type { AdmittedGuard } from "@keeltown/core/domain/verification";
import {
  AdmittedGuards,
  CodeHost,
  type GuardRefused,
  GuardsUnreadable,
} from "@keeltown/core/ports";
import { Effect, Layer, Option, Result } from "effect";

const MAIN = "refs/heads/main";
const SYMLINK = "120000";
const utf8 = new TextDecoder("utf-8");

/**
 * AdmittedGuards over CodeHost: the project's guard repo at the head of
 * `main`, one directory per guard, each read through its `guard.json` (a plain
 * file; a symlink is not followed). A repo or branch that does not exist yet
 * means admission has written nothing: no guards. A directory whose guard.json
 * is missing or cannot be admitted is refused with its reason, never skipped.
 * Anything else that stops the read is GuardsUnreadable.
 */
export const AdmittedGuardsCodeHost = Layer.effect(
  AdmittedGuards,
  Effect.gen(function* () {
    const host = yield* CodeHost;
    return AdmittedGuards.of({
      list: (projectId) => {
        const repo = projectRepos(projectId).guards;
        return Effect.gen(function* () {
          const head = yield* host.head(repo, MAIN).pipe(
            Effect.map(Option.some),
            Effect.catchTags({
              RepoNotFound: () => Effect.succeed(Option.none()),
              RefNotFound: () => Effect.succeed(Option.none()),
            }),
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
            const read = readGuardFile(dir.path, utf8.decode(yield* host.readBlob(repo, file.oid)));
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
    });
  }),
);
