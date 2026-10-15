// A change's diff, as Keel's `GET /v1/changes/{id}/diff` answers it: the shape agreed with the lane that serves
// it, held here until the endpoint is in Keel's generated contract, when it moves to `keel/`.

/** One line of a hunk, as Keel's diff of a change gives it: its kind, its numbers on each side, and its text. */
export interface DiffLine {
  kind: "context" | "add" | "del";
  oldNumber?: number;
  newNumber?: number;
  text: string;
}

/** A unified diff's hunk: where it sits in the file before and after, and its lines. */
export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** One file a change alters, as `GET /v1/changes/{id}/diff` answers: binary and too-large files carry no hunks. */
export interface ChangedFile {
  path: string;
  /** The path it had before, where the change renamed it. */
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary?: boolean;
  tooLarge?: boolean;
  hunks: DiffHunk[];
}
