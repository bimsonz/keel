/**
 * The shape every guard and architecture rule reports in.
 *
 * A rule earns trust only after it has been seen to fail, so a result carries
 * more than its violations: how many files the rule actually read, and whether
 * a known canary file was among them. A rule pointed at the wrong path then
 * fails loudly instead of passing on nothing.
 */
export interface Violation {
  readonly rule: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface GuardResult {
  readonly rule: string;
  readonly filesScanned: number;
  readonly canarySeen: boolean;
  readonly violations: readonly Violation[];
}

export interface Vacuity {
  /** The fewest files the rule must read on the real tree. */
  readonly minFiles: number;
  /** A repo-relative path the rule must have read. */
  readonly canary: string;
}

/**
 * Turns a vacuous run into violations: too few files read, or the canary
 * missing. Every guard calls this before reporting, so "zero violations" can
 * only ever mean "looked, and found nothing".
 */
export function withVacuityCheck(
  rule: string,
  scanned: readonly string[],
  violations: readonly Violation[],
  vacuity: Vacuity,
): GuardResult {
  const canarySeen = scanned.includes(vacuity.canary);
  const vacuous: Violation[] = [];
  if (scanned.length < vacuity.minFiles) {
    vacuous.push({
      rule,
      file: ".",
      message: `vacuous: read ${scanned.length} file(s), expected at least ${vacuity.minFiles}`,
    });
  }
  if (!canarySeen) {
    vacuous.push({
      rule,
      file: vacuity.canary,
      message: `vacuous: canary ${vacuity.canary} was not among the files read`,
    });
  }
  return {
    rule,
    filesScanned: scanned.length,
    canarySeen,
    violations: [...vacuous, ...violations],
  };
}

/** Options every guard accepts. Controls relax the vacuity floor to their own size. */
export interface GuardOptions {
  readonly skip?: readonly string[];
  readonly vacuity?: Vacuity;
}

export function formatResult(result: GuardResult): string {
  const head = `${result.violations.length === 0 ? "ok  " : "FAIL"} ${result.rule} (${result.filesScanned} files, canary ${result.canarySeen ? "seen" : "MISSING"})`;
  const lines = result.violations.map(
    (v) => `       ${v.file}${v.line === undefined ? "" : `:${v.line}`}  ${v.message}`,
  );
  return [head, ...lines].join("\n");
}
