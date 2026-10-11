import { Result, Schema } from "effect";
import { Proposition } from "../../domain/coordination/index.ts";
import { ContentHash, GuardId } from "../../domain/kernel/index.ts";
import type { AdmittedGuard } from "../../domain/verification/index.ts";

/** Where an admitted guard lives in the project's guard repo: `<guardId>/guard.json`, beside its probe's files. */
export const GUARD_FILE = "guard.json";

/**
 * What admission writes for a guard and Precheck reads back: the guard, the
 * probe bundle it was admitted with, and the proposition it guards (taken from
 * the conflict's premise). The proposition is required: a guard that does not
 * say what it guards cannot be selected for a change, so it is refused.
 */
export const GuardFile = Schema.Struct({
  guardId: GuardId,
  probe: ContentHash,
  proposition: Proposition,
});
export type GuardFile = typeof GuardFile.Type;

/** The guard file's text, as admission commits it: canonical key order, one trailing newline. */
export const guardFileText = (guard: GuardFile): string =>
  `${JSON.stringify(Schema.encodeSync(GuardFile)(guard), null, 2)}\n`;

/**
 * Reads `<dir>/guard.json` as an admitted guard, or the reason it cannot be
 * one: not JSON, no proposition, a field that does not decode, or a guardId
 * other than its directory's (a guard copied under another name).
 */
export const readGuardFile = (dir: string, text: string): Result.Result<AdmittedGuard, string> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return Result.fail(
      `${dir}/${GUARD_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Reflect.get(Object(json), "proposition") === undefined)
    return Result.fail(`${dir}/${GUARD_FILE} names no proposition, so nothing says what it guards`);
  const decoded = Schema.decodeUnknownResult(GuardFile)(json);
  if (Result.isFailure(decoded))
    return Result.fail(`${dir}/${GUARD_FILE} does not decode: ${decoded.failure.message}`);
  const { guardId, probe, proposition } = decoded.success;
  if (guardId !== dir)
    return Result.fail(`${dir}/${GUARD_FILE} names guard ${guardId}, not its directory's`);
  return Result.succeed({ guardId, probe, tenet: { proposition } });
};
