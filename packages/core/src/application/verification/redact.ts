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

/**
 * How many credential-shaped strings a runner's raw output held, per pattern,
 * counting every occurrence. A runner holds no credential, so any count above
 * zero means one reached it: the step abstains (`credential-leak`), and only
 * these counts, never the matches, are kept as evidence.
 */
export type CredentialScan = {
  /** `art_v<n>_…` tokens. */
  readonly token: number;
  /** `expires=` parameters, the tail of a token URL. */
  readonly expiry: number;
  /** Artifacts remotes (`<scheme>://…artifacts.cloudflare.net…`). */
  readonly remote: number;
  /** Artifacts hosts, which carry the account id. */
  readonly host: number;
  /** The caller's literal secrets, such as the account id. */
  readonly literal: number;
};

const count = (texts: readonly string[], pattern: RegExp): number =>
  texts.reduce((n, text) => n + (text.match(pattern)?.length ?? 0), 0);

/** Scans raw text with redaction's own patterns, before anything is redacted or written. */
export const scanCredentials = (
  texts: readonly string[],
  options: RedactOptions = {},
): CredentialScan => ({
  token: count(texts, TOKEN),
  expiry: count(texts, EXPIRES),
  remote: count(texts, REMOTE),
  host: count(texts, HOST),
  literal: (options.literals ?? [])
    .filter((literal) => literal.length >= MIN_LITERAL)
    .reduce(
      (n, literal) => n + texts.reduce((m, text) => m + text.split(literal).length - 1, 0),
      0,
    ),
});

/** Whether a scan found anything at all. */
export const leaked = (scan: CredentialScan): boolean =>
  scan.token + scan.expiry + scan.remote + scan.host + scan.literal > 0;

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
