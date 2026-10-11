/**
 * Redaction for anything Keel writes from a runner: logs, evidence, step
 * outputs. Applied before the write, never after:
 * - Artifacts tokens, `art_v1_…` and `art_v2_x_…` (any `art_v<n>_` shape);
 * - their `?expires=` suffix, wherever an `expires` parameter appears;
 * - Artifacts remotes and hosts, whose host carries the account id;
 * - any literal secret the caller knows, such as the account id itself.
 *
 * A runner holds no credential by design, so redaction is the second fence,
 * not the first.
 */

const TOKEN = /art_v\d+_[A-Za-z0-9_.~+/=-]+/g;
const EXPIRES = /([?&])expires=[^&\s"'<>]*/g;
const REMOTE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*artifacts\.cloudflare\.net[^\s"'<>]*/gi;
const HOST = /[A-Za-z0-9-]+\.artifacts\.cloudflare\.net/gi;

/** Literals shorter than this are not redacted: replacing a two-letter string would shred every log. */
const MIN_LITERAL = 8;

export interface RedactOptions {
  /** Secret values known to the caller (the account id, for one), removed wherever they appear. */
  readonly literals?: readonly string[];
}

export const redact = (text: string, options: RedactOptions = {}): string => {
  let out = text;
  for (const literal of options.literals ?? []) {
    if (literal.length >= MIN_LITERAL) out = out.split(literal).join("[REDACTED]");
  }
  // Tokens go first: a host or scheme glued to a token body would otherwise
  // match from inside it and leave an `art_v1_` prefix TOKEN no longer sees.
  return out
    .replace(TOKEN, "[REDACTED:token]")
    .replace(REMOTE, "[REDACTED:remote]")
    .replace(HOST, "[REDACTED:host]")
    .replace(EXPIRES, "$1expires=[REDACTED]");
};
