// The project's code: its tree, a file with the reasons beside its lines,
// trunk's history and a commit's diff. It is read from Keel as it is asked
// for. Where Keel does not serve it, the view says so.

import {
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  CopyIcon,
  FileIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  GitCommitIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { CodeDiff, CodeFile, type LineNote } from "../code/CodeDiff.tsx";
import type {
  BrowserEntry,
  CommitRow,
  RepoAddress,
  RepositoryState,
  RepositoryView,
} from "../engine/repository.ts";
import { TRUNK } from "../route.ts";
import { Link } from "../router.tsx";
import type { RepoNote } from "../source/repository.ts";
import type { Mode } from "../theme/mode.ts";
import { Notice } from "./Frame.tsx";
import { Markdown } from "./Markdown.tsx";
import { ChangeLink } from "./links.tsx";
import { Unverified, clockTime } from "./parts.tsx";

type Ready = Extract<RepositoryState, { status: "ready" }>;

const short = (sha: string): string => sha.slice(0, 7);

function bytes(size: number): string {
  if (size < 1000) return `${size} B`;
  return size < 1_000_000
    ? `${(size / 1000).toFixed(1)} kB`
    : `${(size / 1_000_000).toFixed(1)} MB`;
}

/** The address to clone from, and a button that copies the command. */
function CloneBox({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const command = `git clone ${url}`;
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    } catch {
      // No clipboard here: the command is on the page to be selected.
    }
  };
  return (
    <div className="a-clone">
      <code className="a-mono">{command}</code>
      <button type="button" onClick={() => void copy()} aria-label="Copy the clone command">
        {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const KIND_WORD: Record<RepoNote["kind"], string> = {
  decision: "Decision",
  guard: "Guard",
  tenet: "Tenet",
  premise: "Premise",
};

/** Why one line is as it is: every note Keel has on it, heaviest first. */
function Why({ notes }: { notes: RepoNote[] }) {
  return (
    <div className="a-note" data-why>
      <div className="flex items-center gap-2.5">
        <span className="font-semibold text-kumo-strong">Why this line</span>
        <span className="a-mono text-kumo-default">{notes[0]?.subject}</span>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {notes.map((note) => (
          <li
            key={`${note.kind}:${note.label ?? note.holder?.changeId ?? note.summary}`}
            className="flex flex-wrap items-baseline gap-x-2"
          >
            <span className="a-chip" data-tone={note.kind === "guard" ? "guarded" : undefined}>
              {KIND_WORD[note.kind]}
              {note.label === undefined ? "" : ` ${note.label}`}
            </span>
            {note.holder !== undefined && (
              <ChangeLink id={note.holder.changeId} className="a-mono a-link font-semibold">
                {note.holder.label}
              </ChangeLink>
            )}
            <span className="text-kumo-default">{note.summary}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The files the one being read sits among, beside it. A directory's name goes to the directory; the mark before
 * it opens and closes it where it is, without going anywhere.
 */
function FileBrowser({
  entries,
  at,
  onToggle,
}: {
  entries: BrowserEntry[];
  at: string;
  onToggle: (directory: string, open: boolean) => void;
}) {
  return (
    <nav aria-label="File tree" className="a-files a-scroll">
      <ul>
        {entries.map((entry) => {
          const directory = entry.kind === "tree";
          const open = entry.open === true;
          return (
            <li
              key={entry.path}
              style={{ paddingLeft: 6 + entry.depth * 14 }}
              data-current={entry.current}
            >
              {directory ? (
                <button
                  type="button"
                  className="a-files-toggle"
                  aria-expanded={open}
                  aria-label={`${open ? "Close" : "Open"} ${entry.path}`}
                  onClick={() => onToggle(entry.path, !open)}
                >
                  {open ? <CaretDownIcon size={13} /> : <CaretRightIcon size={13} />}
                </button>
              ) : (
                <span className="a-files-toggle" aria-hidden />
              )}
              <Link
                to={{ at: "code", kind: directory ? "tree" : "blob", ref: at, path: entry.path }}
                aria-current={entry.current ? "page" : undefined}
                title={entry.path}
              >
                {directory ? (
                  open ? (
                    <FolderOpenIcon size={16} weight="fill" />
                  ) : (
                    <FolderSimpleIcon size={16} weight="fill" />
                  )
                ) : (
                  <FileIcon size={16} />
                )}
                <span className="a-mono truncate">{entry.name}</span>
                {entry.reading === true && (
                  <span className="ml-auto pr-2 text-[12px] font-normal text-kumo-subtle">
                    reading
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Crumbs({ state, at }: { state: Ready; at: string }) {
  return (
    <nav aria-label="Path" className="flex flex-wrap items-center gap-1.5 text-base">
      {state.crumbs.map((crumb, index) => {
        const last = index === state.crumbs.length - 1;
        return (
          <span key={crumb.path} className="flex items-center gap-1.5">
            {index > 0 && <span className="text-kumo-subtle">/</span>}
            {last ? (
              <b className="a-mono font-semibold text-kumo-strong">{crumb.name}</b>
            ) : (
              <Link
                to={{ at: "code", kind: "tree", ref: at, path: crumb.path }}
                className="a-mono a-link"
              >
                {crumb.name}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/**
 * Where the files being read stand: the commit, what it landed, and the way to all of them. At trunk's head it
 * also says whether trunk is green, which is the one thing Keel exists to keep true.
 */
function Latest({ state, at }: { state: Ready; at: string }) {
  const { latest, commits } = state;
  if (latest === undefined) return null;
  return (
    <div className="a-latest" aria-label="Latest commit">
      {state.ref.head &&
        (state.green ? (
          <CheckCircleIcon
            size={18}
            weight="fill"
            className="shrink-0"
            style={{ color: "var(--a-pass)" }}
            aria-label="Trunk is green"
          />
        ) : (
          <XCircleIcon
            size={18}
            weight="fill"
            className="shrink-0"
            style={{ color: "var(--a-fail)" }}
            aria-label="Trunk has been red"
          />
        ))}
      <span className="shrink-0 text-kumo-subtle">
        {state.ref.head ? "trunk" : "as it stood at"}
      </span>
      <Link
        to={{ at: "commit", sha: latest.sha }}
        className="min-w-0 truncate font-medium text-kumo-strong hover:underline"
      >
        {latest.message}
      </Link>
      <Landed commit={latest} />
      {latest.unverified && <Unverified />}
      <span className="ml-auto flex shrink-0 items-center gap-4">
        <Link to={{ at: "commit", sha: latest.sha }} className="a-mono a-link-quiet">
          {short(latest.sha)}
        </Link>
        {commits !== undefined && (
          <Link
            to={{ at: "commits", ref: at }}
            className="a-link-quiet inline-flex items-center gap-1.5 font-medium text-kumo-strong"
          >
            <ClockCounterClockwiseIcon size={15} />
            <span className="a-num">
              {commits.count.toLocaleString("en-US")}
              {commits.more ? "+" : ""}
            </span>
            {commits.count === 1 && !commits.more ? "commit" : "commits"}
          </Link>
        )}
      </span>
    </div>
  );
}

function Tree({
  view,
  at,
  state,
}: {
  view: Extract<RepositoryView, { kind: "tree" }>;
  at: string;
  state: Ready;
}) {
  return (
    <>
      <div>
        <Latest state={state} at={at} />
        <ul className="a-tree" aria-label="Files">
          {view.entries.map((entry) => (
            <li key={entry.path}>
              <Link
                to={{
                  at: "code",
                  kind: entry.kind === "tree" ? "tree" : "blob",
                  ref: at,
                  path: entry.path,
                }}
                data-kind={entry.kind}
              >
                {entry.kind === "tree" ? (
                  <FolderSimpleIcon size={17} weight="fill" />
                ) : (
                  <FileIcon size={17} />
                )}
                <span className="a-mono text-kumo-strong">{entry.name}</span>
                {entry.size !== undefined && (
                  <span className="a-num ml-auto text-sm text-kumo-subtle">
                    {bytes(entry.size)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>
      {view.readme !== undefined && (
        <section className="a-panel mt-5" aria-label={view.readme.path}>
          <header className="a-panel-head">
            <h2 className="a-h a-mono">{view.readme.path}</h2>
          </header>
          <div className="px-6 py-5">
            <Markdown source={view.readme.content} />
          </div>
        </section>
      )}
    </>
  );
}

function FileView({ view, mode }: { view: Extract<RepositoryView, { kind: "file" }>; mode: Mode }) {
  // One note beneath a line, holding everything Keel says about it.
  const byLine = new Map<number, RepoNote[]>();
  for (const note of view.notes) byLine.set(note.from, [...(byLine.get(note.from) ?? []), note]);
  const notes: LineNote[] = [...byLine].map(([line, said]) => ({
    line,
    render: (): ReactNode => <Why notes={said} />,
  }));
  const meta = (
    <span className="a-file-meta">
      {byLine.size > 0 && (
        <span>
          {byLine.size === 1
            ? "1 line has a reason beside it"
            : `${byLine.size} lines have a reason beside them`}
        </span>
      )}
      {!view.binary && <span className="a-num">{view.lines} lines</span>}
      <span className="a-num">{bytes(view.size)}</span>
    </span>
  );
  if (view.binary || view.content === undefined) {
    return (
      <section className="a-panel" aria-label={view.path}>
        <header className="a-panel-head">
          <h2 className="a-h a-mono">{view.path}</h2>
          <div className="ml-auto text-sm text-kumo-subtle">{meta}</div>
        </header>
        <p className="px-5 py-6 text-base text-kumo-default">A binary file. It is not shown.</p>
      </section>
    );
  }
  return (
    <section className="a-panel overflow-hidden" aria-label={view.path}>
      <CodeFile
        path={view.path}
        source={view.content}
        mode={mode}
        notes={notes}
        meta={meta}
        className="a-code"
      />
      {view.truncated && (
        <p className="border-t border-kumo-hairline px-5 py-3 text-base text-kumo-default">
          This file is longer than Keel serves in one piece. What is above is its beginning.
        </p>
      )}
    </section>
  );
}

/** The changes a commit landed, each a link where this console's log has the change. */
function Landed({ commit }: { commit: CommitRow }) {
  if (commit.changes.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="text-sm text-kumo-subtle">landed</span>
      {commit.changes.map((change) =>
        change.known ? (
          <ChangeLink
            key={change.id}
            id={change.id}
            className="a-chip a-mono"
            title={`Open change ${change.label}`}
          >
            {change.label}
          </ChangeLink>
        ) : (
          <span key={change.id} className="a-chip a-mono" data-tone="quiet">
            {change.label}
          </span>
        ),
      )}
    </span>
  );
}

function History({ view }: { view: Extract<RepositoryView, { kind: "history" }> }) {
  return (
    <>
      <ol className="a-history" aria-label="Commits, newest first">
        {view.commits.map((commit) => (
          <li key={commit.sha}>
            <GitCommitIcon size={18} className="mt-0.5 shrink-0 text-kumo-subtle" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Link
                to={{ at: "commit", sha: commit.sha }}
                className="text-left text-base font-semibold text-kumo-strong hover:underline"
              >
                {commit.message}
              </Link>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Landed commit={commit} />
                {commit.height !== undefined && (
                  <span className="a-num text-sm text-kumo-subtle">
                    height {commit.height.toLocaleString("en-US")}
                  </span>
                )}
                {commit.unverified && <Unverified />}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Link to={{ at: "commit", sha: commit.sha }} className="a-mono a-link text-sm">
                {short(commit.sha)}
              </Link>
              <time className="a-num text-sm text-kumo-subtle" dateTime={commit.at}>
                {commit.at.slice(0, 10)} {clockTime(commit.at)}
              </time>
            </div>
          </li>
        ))}
      </ol>
      {view.more && (
        <p className="mt-3 text-sm text-kumo-subtle">Older commits are not listed here.</p>
      )}
    </>
  );
}

function Commit({
  view,
  mode,
  at,
}: {
  view: Extract<RepositoryView, { kind: "commit" }>;
  mode: Mode;
  at: string;
}) {
  const { commit } = view;
  return (
    <div className="flex flex-col gap-4">
      <header className="a-panel flex flex-col gap-2 px-5 py-4">
        <h1 className="text-xl font-semibold leading-snug text-kumo-strong">{commit.message}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-kumo-subtle">
          <span>
            commit <span className="a-mono text-kumo-default">{short(commit.sha)}</span>
          </span>
          <time className="a-num" dateTime={commit.at}>
            {commit.at.slice(0, 10)} {clockTime(commit.at)}
          </time>
          {commit.height !== undefined && (
            <span className="a-num">height {commit.height.toLocaleString("en-US")}</span>
          )}
          <Landed commit={commit} />
          {commit.unverified && <Unverified />}
          <span className="a-num ml-auto">
            {view.files.length} {view.files.length === 1 ? "file" : "files"} ·{" "}
            <span style={{ color: "var(--a-pass-ink)" }}>+{view.additions}</span>{" "}
            <span style={{ color: "var(--a-fail-ink)" }}>−{view.deletions}</span>
          </span>
        </div>
        <div className="flex gap-4 text-sm">
          <Link to={{ at: "code", kind: "tree", ref: commit.sha, path: "" }} className="a-link">
            Browse the files at this commit
          </Link>
          <Link to={{ at: "commits", ref: at }} className="a-link">
            All commits
          </Link>
        </div>
      </header>
      {view.files.length === 0 ? (
        <p className="text-base text-kumo-default">
          This commit changed no file that Keel can show.
        </p>
      ) : (
        view.files.map((file) => (
          <section key={file.path} className="a-panel overflow-hidden" aria-label={file.path}>
            <CodeDiff
              file={file}
              annotations={[]}
              mode={mode}
              renderAnnotation={() => null}
              className="a-code"
            />
          </section>
        ))
      )}
    </div>
  );
}

export function Repository({
  state,
  address,
  mode,
  onToggle,
}: {
  state: RepositoryState;
  address: RepoAddress;
  mode: Mode;
  /** Opens or closes a directory in the list of files beside the code. */
  onToggle: (directory: string, open: boolean) => void;
}) {
  if (state.status === "unserved") {
    return (
      <Notice title="Keel does not serve this project's repository yet">
        When it does, its files, its history and the reasons beside its lines are read here, from
        Keel. Nothing is shown in their place.
      </Notice>
    );
  }
  if (state.status === "loading")
    return <Notice title="Reading the repository">Asking Keel what this project is.</Notice>;
  const { view } = state;
  // What an address under this one reads at: the commit this one names, or wherever trunk's head is.
  const at = address.ref ?? TRUNK;
  const page = (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-4 px-6 py-5">
      {view.kind !== "commit" && (
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="sr-only">{address.view === "code" ? "Code" : "Commits"}</h1>
          {address.view === "code" ? (
            <Crumbs state={state} at={at} />
          ) : (
            <span className="text-base font-semibold text-kumo-strong">Commits</span>
          )}
          {/* A directory says where it stands in the bar above its files. Everything else says it here. */}
          {(view.kind !== "tree" || state.latest === undefined) && (
            <span className="text-sm text-kumo-subtle">
              {state.ref.head ? "trunk at " : "as it stood at "}
              <span className="a-mono text-kumo-default">{short(state.ref.sha)}</span>
            </span>
          )}
          {!state.ref.head && (
            <Link
              to={
                address.view === "code"
                  ? { at: "code", kind: "tree", ref: TRUNK, path: address.path }
                  : { at: "commits", ref: TRUNK }
              }
              className="a-link text-sm"
            >
              Go to trunk's head
            </Link>
          )}
          {address.view === "code" ? (
            (view.kind !== "tree" || state.latest === undefined) && (
              <Link
                to={{ at: "commits", ref: at }}
                className="a-link inline-flex items-center gap-1.5 text-sm"
              >
                <ClockCounterClockwiseIcon size={15} />
                Commits
              </Link>
            )
          ) : (
            <Link to={{ at: "code", kind: "tree", ref: at, path: "" }} className="a-link text-sm">
              Browse the files
            </Link>
          )}
          {address.view === "code" && address.path === "" && (
            <div className="ml-auto">
              <CloneBox url={state.project.cloneUrl} />
            </div>
          )}
        </header>
      )}

      {view.kind === "loading" && <p className="text-base text-kumo-subtle">Reading from Keel.</p>}
      {view.kind === "absent" && (
        <p className="text-base text-kumo-default">There is no {view.what} at this commit.</p>
      )}
      {view.kind === "tree" && <Tree view={view} at={at} state={state} />}
      {view.kind === "file" && <FileView view={view} mode={mode} />}
      {view.kind === "history" && <History view={view} />}
      {view.kind === "commit" && <Commit view={view} mode={mode} at={at} />}
    </div>
  );
  if (state.browser === undefined)
    return <div className="a-scroll h-full overflow-y-auto">{page}</div>;
  // Beside a file, the files it sits among. The list keeps its place as the reader moves; what is read starts at its top.
  return (
    <div className="flex h-full">
      <FileBrowser entries={state.browser} at={at} onToggle={onToggle} />
      <div key={`${at}:${address.path}`} className="a-scroll h-full min-w-0 flex-1 overflow-y-auto">
        {page}
      </div>
    </div>
  );
}
