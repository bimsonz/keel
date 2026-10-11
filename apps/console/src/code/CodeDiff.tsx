import { File, MultiFileDiff } from "@pierre/diffs/react";
import type { CSSProperties, ReactNode } from "react";
import type { DiffAnnotation, DiffFile } from "../domain/state.ts";
import type { Mode } from "../theme/mode.ts";

const THEME = { dark: "pierre-dark", light: "pierre-light" } as const;

/**
 * One file of a change's diff, with notes pinned to lines. The viewer renders
 * in a shadow root, so a direction styles the code through `style` (the
 * `--diffs-*` custom properties) and styles the notes as ordinary React.
 */
export function CodeDiff({
  file,
  annotations,
  mode,
  renderAnnotation,
  layout = "unified",
  showHeader = true,
  style,
  className,
}: {
  file: DiffFile;
  annotations: DiffAnnotation[];
  mode: Mode;
  renderAnnotation: (annotation: DiffAnnotation) => ReactNode;
  layout?: "unified" | "split";
  showHeader?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const lineAnnotations = annotations
    .filter((annotation) => annotation.path === file.path)
    .map((annotation) => ({
      side: annotation.side,
      lineNumber: annotation.line,
      metadata: annotation,
    }));
  const shared = {
    options: {
      theme: THEME,
      themeType: mode,
      diffStyle: layout,
      overflow: "wrap" as const,
      disableFileHeader: !showHeader,
    },
    lineAnnotations,
    renderAnnotation: (annotation: { metadata: DiffAnnotation }) =>
      renderAnnotation(annotation.metadata),
    disableWorkerPool: true,
    ...(style === undefined ? {} : { style }),
    ...(className === undefined ? {} : { className }),
  };
  const before = file.before === null ? null : { name: file.path, contents: file.before };
  const after = file.after === null ? null : { name: file.path, contents: file.after };
  if (before !== null && after !== null)
    return <MultiFileDiff<DiffAnnotation> oldFile={before} newFile={after} {...shared} />;
  if (after !== null)
    return <MultiFileDiff<DiffAnnotation> oldFile={null} newFile={after} {...shared} />;
  if (before !== null)
    return <MultiFileDiff<DiffAnnotation> oldFile={before} newFile={null} {...shared} />;
  return null;
}

/** Something said beneath one line of a file. */
export interface LineNote {
  /** The line's number, from 1. */
  line: number;
  render: () => ReactNode;
}

const NO_NOTES: readonly LineNote[] = [];

/**
 * A single source file, read-only: a probe's source, or a file of the repository with notes beneath its lines.
 * The viewer's own header is always shown: with it switched off, this version of the viewer draws no code
 * until something makes it draw again. `meta` is said at the right of that header.
 */
export function CodeFile({
  path,
  source,
  mode,
  notes = NO_NOTES,
  meta,
  style,
  className,
}: {
  path: string;
  source: string;
  mode: Mode;
  notes?: readonly LineNote[];
  meta?: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <File<LineNote>
      file={{ name: path, contents: source }}
      options={{ theme: THEME, themeType: mode, overflow: "wrap" }}
      disableWorkerPool
      lineAnnotations={notes.map((note) => ({ lineNumber: note.line, metadata: note }))}
      renderAnnotation={(annotation) => annotation.metadata.render()}
      {...(meta === undefined ? {} : { renderHeaderMetadata: () => meta })}
      {...(style === undefined ? {} : { style })}
      {...(className === undefined ? {} : { className })}
    />
  );
}
