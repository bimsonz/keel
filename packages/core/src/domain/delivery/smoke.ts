import type { SmokeCheck } from "./deploy-spec.ts";

/** What a smoke request got back: the status and the start of the body, or why nothing came. */
export type SmokeAnswer =
  | { readonly _tag: "answered"; readonly status: number; readonly body: string }
  | { readonly _tag: "no-answer"; readonly error: string };

/** One smoke check judged on what its request got back, said as the bounce cites it. */
export interface SmokeJudged {
  readonly path: string;
  readonly ok: boolean;
  readonly said: string;
}

/**
 * Judges one smoke check: it passes when the preview answered the status the
 * check names and, when it names text, a body holding it.
 */
export const judgeSmoke = (check: SmokeCheck, answer: SmokeAnswer): SmokeJudged => {
  const asked = `GET ${check.path}`;
  if (answer._tag === "no-answer")
    return { path: check.path, ok: false, said: `${asked} never answered: ${answer.error}` };
  if (answer.status !== check.status)
    return {
      path: check.path,
      ok: false,
      said: `${asked} answered ${answer.status}, not ${check.status}`,
    };
  if (check.contains !== undefined && !answer.body.includes(check.contains))
    return {
      path: check.path,
      ok: false,
      said: `${asked} answered ${answer.status} without ${JSON.stringify(check.contains)}`,
    };
  return { path: check.path, ok: true, said: `${asked} answered ${answer.status}` };
};

/**
 * Whether a check that did not pass may be asked again: a new version's
 * address can take a few seconds to answer, so no answer, a 404 or a 5xx is
 * tried again while the step's time lasts. Any other answer stands.
 */
export const smokeRetryable = (check: SmokeCheck, answer: SmokeAnswer): boolean =>
  answer._tag === "no-answer" ||
  (answer.status !== check.status && (answer.status === 404 || answer.status >= 500));
