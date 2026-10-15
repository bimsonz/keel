// Keel's `why` on one path of a project: the decisions that explain it, newest first, as Keel answers anyone
// it shows the project to (`GET /v1/why?project&path`). The page reads the decisions' records alone: each one's
// id, when it was ruled, and Keel's own line for it.

/** One decision Keel says explains a path. */
export interface WhyDecision {
  id: string;
  at: string;
  /** Keel's line for it, as `why` says it. */
  summary: string;
}

interface WhyAnswer {
  result?: {
    chain?: {
      summary?: unknown;
      record?: { id?: unknown; at?: unknown; message?: { kind?: unknown } };
    }[];
  };
}

/** The decisions Keel says explain `path`; none where it names none, or answers anything but a chain. */
export async function readWhy(
  projectId: string,
  path: string,
  signal?: AbortSignal,
): Promise<WhyDecision[]> {
  const query = new URLSearchParams({ project: projectId, path });
  const response = await fetch(`/v1/why?${query.toString()}`, {
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) return [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- read field by field below, and anything else is dropped
  const answer = (await response.json()) as WhyAnswer;
  return (answer.result?.chain ?? []).flatMap((item) => {
    const { record } = item;
    return record?.message?.kind === "decision" &&
      typeof record.id === "string" &&
      typeof record.at === "string" &&
      typeof item.summary === "string"
      ? [{ id: record.id, at: record.at, summary: item.summary }]
      : [];
  });
}
