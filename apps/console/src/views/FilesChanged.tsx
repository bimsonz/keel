// A change's files, as a code host's "Files changed" tab lays out a pull request's: the files changed and the
// lines added and removed, a tree of them on the left, and each file's diff in a box of its own whose header
// says its path, what became of it and its count, and folds it away. A large one is left folded until asked for.

import { CaretDownIcon, CaretRightIcon, FileIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import type { ChangedFile } from "../contract/diff.ts";
import type { DiffAnnotation } from "../domain/state.ts";
import { folded } from "../engine/patch.ts";
import type { Mode } from "../theme/mode.ts";
import { PatchView } from "./later.tsx";

const STATUS: Record<ChangedFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
};

/** The colour a status is marked in, in the tree: added green, deleted red, the rest the text's own. */
const TONE: Record<ChangedFile["status"], string> = {
  added: "var(--a-pass-ink)",
  modified: "var(--a-suspected-ink)",
  deleted: "var(--a-fail-ink)",
  renamed: "var(--text-color-kumo-subtle)",
};

const anchorOf = (index: number): string => `diff-${index}`;

/** "+N −M", added in green and removed in red, as a code host counts a file's lines. */
export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="a-num whitespace-nowrap">
      <span style={{ color: "var(--a-pass-ink)" }}>+{additions.toLocaleString("en-US")}</span>{" "}
      <span style={{ color: "var(--a-fail-ink)" }}>−{deletions.toLocaleString("en-US")}</span>
    </span>
  );
}

/** Five squares, filled in the share of added and removed lines, beside a file's count. */
function Squares({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const added = total === 0 ? 0 : Math.round((additions / total) * 5);
  const removed = total === 0 ? 0 : Math.min(5 - added, Math.round((deletions / total) * 5));
  return (
    <span aria-hidden className="flex gap-px">
      {Array.from({ length: 5 }, (_, at) => (
        <span
          key={at}
          className="size-2 rounded-[1px]"
          style={{
            background:
              at < added
                ? "var(--a-pass-ink)"
                : at < added + removed
                  ? "var(--a-fail-ink)"
                  : "var(--color-kumo-line)",
          }}
        />
      ))}
    </span>
  );
}

interface Folder {
  name: string;
  folders: Map<string, Folder>;
  files: { name: string; index: number; file: ChangedFile }[];
}

function treeOf(files: readonly ChangedFile[]): Folder {
  const root: Folder = { name: "", folders: new Map(), files: [] };
  files.forEach((file, index) => {
    const parts = file.path.split("/");
    const name = parts.pop() ?? file.path;
    let at = root;
    for (const part of parts) {
      const next = at.folders.get(part) ?? { name: part, folders: new Map(), files: [] };
      at.folders.set(part, next);
      at = next;
    }
    at.files.push({ name, index, file });
  });
  return root;
}

function Branch({ folder, depth }: { folder: Folder; depth: number }): ReactNode {
  const pad = { paddingLeft: `${8 + depth * 14}px` };
  return (
    <>
      {[...folder.folders.values()].map((inner) => (
        <li key={`d:${inner.name}`}>
          <span className="flex h-7 items-center gap-1.5 text-sm text-kumo-default" style={pad}>
            <FolderSimpleIcon size={14} aria-hidden className="shrink-0 text-kumo-subtle" />
            <span className="truncate">{inner.name}</span>
          </span>
          <ul>
            <Branch folder={inner} depth={depth + 1} />
          </ul>
        </li>
      ))}
      {folder.files.map(({ name, index, file }) => (
        <li key={`f:${file.path}`}>
          <button
            type="button"
            className="flex h-7 w-full items-center gap-1.5 rounded text-left text-sm text-kumo-default hover:bg-kumo-tint"
            style={pad}
            onClick={() =>
              document.getElementById(anchorOf(index))?.scrollIntoView({ block: "start" })
            }
          >
            <FileIcon
              size={14}
              aria-hidden
              className="shrink-0"
              style={{ color: TONE[file.status] }}
            />
            <span className="truncate">{name}</span>
          </button>
        </li>
      ))}
    </>
  );
}

function FileBox({
  file,
  index,
  annotations,
  mode,
  renderAnnotation,
}: {
  file: ChangedFile;
  index: number;
  annotations: DiffAnnotation[];
  mode: Mode;
  renderAnnotation: (annotation: DiffAnnotation) => ReactNode;
}) {
  const [open, setOpen] = useState(!folded(file));
  const [asked, setAsked] = useState(false);
  const large = folded(file) && !asked;
  return (
    <section
      id={anchorOf(index)}
      aria-label={file.path}
      className="scroll-mt-2 overflow-hidden rounded-lg border border-kumo-line bg-kumo-base"
    >
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-hairline bg-kumo-tint px-3 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${file.path}`}
          className="flex size-6 items-center justify-center rounded text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-strong"
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <CaretDownIcon size={14} aria-hidden />
          ) : (
            <CaretRightIcon size={14} aria-hidden />
          )}
        </button>
        <span className="a-mono min-w-0 flex-1 text-sm font-semibold text-kumo-strong [overflow-wrap:anywhere]">
          {file.status === "renamed" && file.previousPath !== undefined
            ? `${file.previousPath} → ${file.path}`
            : file.path}
        </span>
        {file.status !== "modified" && (
          <span className="a-chip" data-tone="quiet">
            {STATUS[file.status]}
          </span>
        )}
        <span className="flex items-center gap-2 text-sm">
          <Counts additions={file.additions} deletions={file.deletions} />
          <Squares additions={file.additions} deletions={file.deletions} />
        </span>
      </div>
      {open &&
        (file.binary === true ? (
          <p className="px-4 py-6 text-center text-sm text-kumo-subtle">Binary file not shown.</p>
        ) : file.tooLarge === true ? (
          <p className="px-4 py-6 text-center text-sm text-kumo-subtle">Diff too large to show.</p>
        ) : large ? (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-sm text-kumo-subtle">
            <p>Large diffs are not rendered by default.</p>
            <button type="button" className="a-link" onClick={() => setAsked(true)}>
              Load diff
            </button>
          </div>
        ) : file.hunks.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-kumo-subtle">No lines changed.</p>
        ) : (
          <PatchView
            file={file}
            annotations={annotations}
            mode={mode}
            renderAnnotation={renderAnnotation}
            className="a-code"
          />
        ))}
    </section>
  );
}

export function FilesChanged({
  files,
  additions,
  deletions,
  annotations,
  mode,
  renderAnnotation,
}: {
  files: readonly ChangedFile[];
  additions: number;
  deletions: number;
  annotations: DiffAnnotation[];
  mode: Mode;
  renderAnnotation: (annotation: DiffAnnotation) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-2 text-sm">
        <span className="font-semibold text-kumo-strong" aria-label="Files changed">
          {files.length.toLocaleString("en-US")} {files.length === 1 ? "file" : "files"} changed
        </span>
        <Counts additions={additions} deletions={deletions} />
      </div>
      <div className="flex items-start gap-4">
        <nav
          aria-label="Changed files"
          className="sticky top-2 hidden max-h-[calc(100vh-8rem)] w-64 shrink-0 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-base p-1 md:block"
        >
          <ul>
            <Branch folder={treeOf(files)} depth={0} />
          </ul>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {files.map((file, index) => (
            <FileBox
              key={file.path}
              file={file}
              index={index}
              annotations={annotations}
              mode={mode}
              renderAnnotation={renderAnnotation}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
