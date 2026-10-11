// Evidence, made readable. Keel's producers write one sentence with each piece
// of evidence; where one is missing, the console says what it has: the class
// and the reference.

import type { EvidenceItem } from "../domain/state.ts";
import type { EvidenceLine } from "../contract/provisional.ts";

export function readable(line: EvidenceLine): EvidenceItem {
  return {
    class: line.class,
    summary: line.summary ?? `${line.class}: ${line.ref}`,
    by: line.by ?? line.source ?? "",
    ref: line.ref,
    at: line.at,
    ...(line.detail === undefined ? {} : { detail: line.detail }),
  };
}
