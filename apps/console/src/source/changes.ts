// One change of a project by its number, from Keel's read model of the project's changes (`GET /v1/changes`,
// newest first, its cursor a number): what a change's page draws before the project's log has been read.

import type { ChangeSummary } from "../contract/keel/index.ts";

/** The change Keel numbers `number` in the project, or null where it names none by that number. */
export async function readChangeByNumber(
  projectId: string,
  number: number,
  signal?: AbortSignal,
): Promise<ChangeSummary | null> {
  // The list runs newest first and its cursor is the number below which a page starts.
  const query = new URLSearchParams({ project: projectId, limit: "1", cursor: String(number + 1) });
  const response = await fetch(`/v1/changes?${query.toString()}`, {
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) return null;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Keel's own page of ChangeSummary, checked by number below
  const page = (await response.json()) as { items?: ChangeSummary[] };
  const [first] = page.items ?? [];
  return first?.number === number ? first : null;
}
