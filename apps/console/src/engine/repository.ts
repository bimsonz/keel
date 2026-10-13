// The repository, as the console shows it: read on demand from Keel, beside
// the log, and joined to what the log says (a change's number and state,
// trunk's head). Nothing here is folded from events, and nothing is kept
// that Keel did not answer with.

import type { DiffFile } from "../domain/state.ts";
import type { RepoBlob, RepoCommit, RepoCommitDiff, RepoTree } from "../contract/keel/index.ts";
import type { RepoNote } from "../contract/provisional.ts";
import { type KeelRepository, NO_SUCH_PROJECT, RepoRefused } from "../source/repository.ts";
import type { Visibility } from "./projects.ts";
import { readmeAmong } from "./readme.ts";
import type { World } from "./world.ts";

/** Where in the repository the view is: among its files, or in its history. */
export interface RepoAddress {
  view: "code" | "history";
  /** A commit to read at. Absent: trunk's head. */
  ref?: string;
  /** A directory or a file, from the root. The root is the empty path. */
  path: string;
  /** What the address says the path is. Only Keel knows; this is what whoever made the link saw there. */
  kind?: "tree" | "blob";
  /** In the history: the commit whose diff is open. */
  commit?: string;
}

const PAGE = 100;

/** How what was read at trunk's head is kept, where no commit was named and the log has not said where trunk is. */
const HEAD = "@head";

/** The project being read, as the console knows it apart from Keel's answers about its files. */
export interface ReadProject {
  /** Keel's id for it. Absent where the console cannot yet tell which project an address names. */
  id?: string;
  name: string;
  visibility?: Visibility;
}

/** Reads the repository once for each thing asked, and keeps what Keel answered. */
export class RepositoryReader {
  /** The projects Keel has answered this reader that there are none such: private ones, or none at all. */
  readonly #refused = new Set<string>();
  readonly trees = new Map<string, RepoTree>();
  readonly blobs = new Map<string, RepoBlob>();
  readonly notes = new Map<string, RepoNote[]>();
  readonly diffs = new Map<string, RepoCommitDiff>();
  readonly histories = new Map<string, { commits: RepoCommit[]; more: boolean }>();
  /** The commit each ref read at turned out to be, by Keel's own answer. */
  readonly resolved = new Map<string, string>();
  /** Asked for, and not there. */
  readonly absent = new Set<string>();
  readonly #asked = new Set<string>();
  readonly #source: KeelRepository;
  readonly #changed: () => void;
  readonly #project: () => ReadProject | undefined;

  /** `project` says which project the address names right now; the reader asks again when that changes. */
  constructor(source: KeelRepository, changed: () => void, project: () => ReadProject | undefined) {
    this.#source = source;
    this.#changed = changed;
    this.#project = project;
  }

  /** The project being read. */
  get reading(): ReadProject | undefined {
    return this.#project();
  }

  /** True once Keel has answered that there is no such project for this reader: a private one, or none. */
  get refused(): boolean {
    return this.#refused.has(this.#project()?.id ?? "");
  }

  /**
   * What an address reads at: the ref it names, else trunk's head as the log has it, else the project's `main`,
   * which is what Keel reads where no ref is named. So the code is read before the log has said where trunk is.
   * What was read at `main` stands for as long as trunk is still at the commit Keel read it at: the log saying
   * where trunk is does not send the page to read the same commit again.
   */
  refOf(address: RepoAddress, head: string): string {
    if (address.ref !== undefined) return address.ref;
    return head === "" || this.resolved.get(this.keyOf(HEAD, "")) === head ? HEAD : head;
  }

  /** What is kept is kept by project, so that one project's files are never shown as another's. */
  keyOf(ref: string, path: string): string {
    return `${this.#project()?.id ?? ""} ${ref}:${path}`;
  }

  /**
   * Read whatever `address` needs that has not been asked for yet. Beside a file or a directory below the root
   * stands the list of files it sits among: for that, the root and each directory on the way are read, and
   * whichever directories a reader has `opened`.
   */
  want(address: RepoAddress, head: string, opened: Iterable<string> = []): void {
    const id = this.#project()?.id;
    if (id === undefined) return;
    const ref = this.refOf(address, head);
    const named = ref === HEAD ? {} : { ref };
    // The code's own page says where trunk is: its latest commit, and how many there are.
    this.#once(`history ${this.keyOf(ref, "")}`, async () => {
      const page = await this.#source.getCommits(id, { ...named, limit: PAGE });
      this.histories.set(this.keyOf(ref, ""), {
        commits: page.items,
        more: page.nextCursor !== undefined,
      });
    });
    if (address.view === "code") {
      this.#wantPath(id, ref, address.path, address.kind ?? "tree");
      if (address.path !== "") {
        const parts = address.path.split("/");
        for (const directory of [
          "",
          ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/")),
          ...opened,
        ])
          this.#wantTree(id, ref, directory);
      }
      return;
    }
    const sha = address.commit;
    if (sha === undefined) return;
    const key = this.keyOf("commit", sha);
    this.#once(
      `commit ${key}`,
      async () => {
        this.diffs.set(key, await this.#source.getCommit(id, sha));
      },
      () => this.absent.add(key),
    );
  }

  /** A directory known to be one, read for the list of files beside the code. */
  #wantTree(id: string, ref: string, path: string): void {
    const key = this.keyOf(ref, path);
    if (this.trees.has(key)) return;
    this.#once(`tree ${key}`, async () => {
      this.#keep(
        key,
        ref,
        await this.#source.getTree(id, { ...(ref === HEAD ? {} : { ref }), path }),
      );
    });
  }

  #keep(key: string, ref: string, tree: RepoTree): void {
    this.trees.set(key, tree);
    this.resolved.set(this.keyOf(ref, ""), tree.commit);
  }

  #wantPath(id: string, ref: string, path: string, first: "tree" | "blob"): void {
    const key = this.keyOf(ref, path);
    const at = { ...(ref === HEAD ? {} : { ref }), path };
    const asDirectory = async (): Promise<void> => {
      this.#keep(key, ref, await this.#source.getTree(id, at));
    };
    const asFile = async (): Promise<void> => {
      const blob: RepoBlob = await this.#source.getBlob(id, at);
      // A file whose notes cannot be read is still a file, and Keel has no notes to read yet.
      const notes =
        (await this.#source.getNotes?.(at).then(
          (answer) => answer.notes,
          () => [],
        )) ?? [];
      // Both at once: the file is never there to be drawn without the notes that belong beside its lines.
      this.blobs.set(key, blob);
      this.notes.set(key, notes);
      this.resolved.set(this.keyOf(ref, ""), blob.commit);
    };
    // A path is a directory or a file, and only Keel knows which. What the address says it is is asked for
    // first, so a link to a file costs one read and not a refused one before it. Keel answers the wrong kind
    // of read with its own code for a path that is not there, and the other kind is read then.
    this.#once(`path ${key}`, async () => {
      for (const read of first === "blob" ? [asFile, asDirectory] : [asDirectory, asFile]) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- the second read is asked only once Keel has refused the first
          await read();
          return;
        } catch (error) {
          // No such project for this reader is the answer to every read of it. Nothing more is asked.
          if (error instanceof RepoRefused && error.code === NO_SUCH_PROJECT) {
            this.#refused.add(id);
            return;
          }
        }
      }
      this.absent.add(key);
    });
    // A directory's README is shown beneath it.
    const readme = readmeAmong(this.trees.get(key)?.entries ?? []);
    if (readme === undefined) return;
    const beneath = this.keyOf(ref, readme.path);
    this.#once(`readme ${beneath}`, async () => {
      this.blobs.set(
        beneath,
        await this.#source.getBlob(id, { ...(ref === HEAD ? {} : { ref }), path: readme.path }),
      );
    });
  }

  #once(key: string, load: () => Promise<void>, failed?: () => void): void {
    if (this.#asked.has(key)) return;
    this.#asked.add(key);
    void (async () => {
      try {
        await load();
      } catch {
        failed?.();
      }
      this.#changed();
    })();
  }
}

export interface CommitRow {
  sha: string;
  at: string;
  message: string;
  height?: number;
  unverified: boolean;
  /** The changes it landed. `known` is whether this console's log has the change, so its page can be opened. */
  changes: { id: string; label: string; known: boolean }[];
}

/** One line of the list of files beside the code: a file, or a directory with whether what is in it is listed beneath. */
export interface BrowserEntry {
  name: string;
  path: string;
  kind: RepoTree["entries"][number]["kind"];
  /** How far below the root: what it is indented by. */
  depth: number;
  /** A directory: whether it is open. */
  open?: boolean;
  /** Open, and Keel has not yet said what is in it. */
  reading?: boolean;
  /** The file or directory being read. */
  current: boolean;
}

/** What a reader has done to the list of files: directories they opened, and directories they closed. What a reader chose stands. */
export interface Browsing {
  opened: ReadonlySet<string>;
  closed: ReadonlySet<string>;
}

const AS_IT_COMES: Browsing = { opened: new Set(), closed: new Set() };

export type RepositoryView =
  | { kind: "loading" }
  | {
      kind: "tree";
      entries: {
        name: string;
        kind: RepoTree["entries"][number]["kind"];
        path: string;
      }[];
      readme?: { path: string; content: string };
    }
  | {
      kind: "file";
      path: string;
      size: number;
      lines: number;
      binary: boolean;
      truncated: boolean;
      content?: string;
      notes: RepoNote[];
    }
  | { kind: "absent"; what: string }
  | { kind: "history"; commits: CommitRow[]; more: boolean }
  | { kind: "commit"; commit: CommitRow; files: DiffFile[]; additions: number; deletions: number };

export type RepositoryState =
  /** Keel would not read the project's files to this reader: it is private or not there, or its trunk has nothing on it. */
  | { status: "refused" }
  | { status: "loading" }
  | {
      status: "ready";
      project: { name: string; visibility?: Visibility };
      /** The commit being read, and whether it is trunk's head. */
      ref: { sha: string; head: boolean };
      /** From the root to where the address is. The root's name is the project's. */
      crumbs: { name: string; path: string }[];
      /** The commit being read, as history has it, once history has been read. */
      latest?: CommitRow;
      /** How many commits lead to it. `more` where there are more than Keel gave in one page. */
      commits?: { count: number; more: boolean };
      /** True while no audit of trunk has come back red. */
      green: boolean;
      /** The files the one being read sits among. Absent at the root, which is that list already, and until the root has been read. */
      browser?: BrowserEntry[];
      view: RepositoryView;
    };

/**
 * A commit as history shows it. Keel's history gives the commit and the change it carries; the log gives the
 * rest: the change's number, how high trunk stood once the commit was its head, and whether that was verified.
 * A commit restacked onto trunk keeps its author's own date, so when it landed is its committer's.
 */
function rowOf(world: World, commit: RepoCommit): CommitRow {
  const landed = world.landed.get(commit.sha);
  const changeId = commit.changeId ?? landed?.changeId;
  const change = changeId === undefined ? undefined : world.changes.get(changeId);
  return {
    sha: commit.sha,
    at: commit.committer.at,
    message: commit.message.split("\n")[0] ?? "",
    ...(landed === undefined ? {} : { height: landed.height }),
    unverified: landed?.unverified === true,
    changes:
      changeId === undefined
        ? []
        : [
            {
              id: changeId,
              label: change?.label ?? changeId.slice(-4),
              known: change !== undefined,
            },
          ],
  };
}

function changedLines(
  before: string | null,
  after: string | null,
): { additions: number; deletions: number } {
  const old = new Set((before ?? "").split("\n"));
  const now = new Set((after ?? "").split("\n"));
  return {
    additions: [...now].filter((line) => !old.has(line) && line.trim() !== "").length,
    deletions: [...old].filter((line) => !now.has(line) && line.trim() !== "").length,
  };
}

/** Directories first, then files, each by name. */
function inOrder(tree: RepoTree): RepoTree["entries"] {
  return tree.entries.toSorted(
    (a, b) => Number(b.kind === "tree") - Number(a.kind === "tree") || a.name.localeCompare(b.name),
  );
}

function viewOf(
  world: World,
  reader: RepositoryReader,
  address: RepoAddress,
  ref: string,
): RepositoryView {
  if (address.view === "history") {
    if (address.commit !== undefined) {
      const commitKey = reader.keyOf("commit", address.commit);
      if (reader.absent.has(commitKey))
        return { kind: "absent", what: `commit ${address.commit.slice(0, 7)}` };
      const diff = reader.diffs.get(commitKey);
      if (diff === undefined) return { kind: "loading" };
      const counts = diff.files.map((file) => changedLines(file.before, file.after));
      return {
        kind: "commit",
        commit: rowOf(world, diff.commit),
        files: diff.files.map((file) => ({
          path: file.path,
          before: file.before,
          after: file.after,
        })),
        additions: counts.reduce((sum, count) => sum + count.additions, 0),
        deletions: counts.reduce((sum, count) => sum + count.deletions, 0),
      };
    }
    const history = reader.histories.get(reader.keyOf(ref, ""));
    return history === undefined
      ? { kind: "loading" }
      : {
          kind: "history",
          commits: history.commits.map((commit) => rowOf(world, commit)),
          more: history.more,
        };
  }
  const key = reader.keyOf(ref, address.path);
  if (reader.absent.has(key)) return { kind: "absent", what: address.path };
  const tree = reader.trees.get(key);
  if (tree !== undefined) {
    const entries = inOrder(tree).map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      path: entry.path,
    }));
    const named = readmeAmong(entries);
    const readme =
      named === undefined ? undefined : reader.blobs.get(reader.keyOf(ref, named.path));
    return {
      kind: "tree",
      entries,
      ...(named === undefined || readme?.content === undefined
        ? {}
        : { readme: { path: named.path, content: readme.content } }),
    };
  }
  const blob = reader.blobs.get(key);
  if (blob === undefined) return { kind: "loading" };
  return {
    kind: "file",
    path: blob.path,
    size: blob.size,
    lines: blob.content === undefined ? 0 : blob.content.replace(/\n$/, "").split("\n").length,
    binary: blob.binary,
    truncated: blob.truncated,
    ...(blob.content === undefined ? {} : { content: blob.content }),
    notes: reader.notes.get(key) ?? [],
  };
}

/**
 * The list of files beside the code. A directory is open where it is on the way to what is being read, or a
 * reader opened it, unless a reader closed it. What is in an open directory is listed beneath it once read.
 */
function browserOf(
  reader: RepositoryReader,
  ref: string,
  path: string,
  browsing: Browsing,
): BrowserEntry[] | undefined {
  const root = reader.trees.get(reader.keyOf(ref, ""));
  if (root === undefined) return undefined;
  const entries: BrowserEntry[] = [];
  const list = (tree: RepoTree, within: string, depth: number): void => {
    for (const entry of inOrder(tree)) {
      const at = within === "" ? entry.name : `${within}/${entry.name}`;
      const current = at === path;
      if (entry.kind !== "tree") {
        entries.push({ name: entry.name, path: at, kind: entry.kind, depth, current });
        continue;
      }
      const open =
        !browsing.closed.has(at) &&
        (browsing.opened.has(at) || current || path.startsWith(`${at}/`));
      const inside = open ? reader.trees.get(reader.keyOf(ref, at)) : undefined;
      entries.push({
        name: entry.name,
        path: at,
        kind: entry.kind,
        depth,
        open,
        ...(open && inside === undefined ? { reading: true } : {}),
        current,
      });
      if (inside !== undefined) list(inside, at, depth + 1);
    }
  };
  list(root, "", 0);
  return entries;
}

/** What the repository view shows at `address`, from what has been read so far. */
export function repositoryOf(
  world: World,
  reader: RepositoryReader,
  address: RepoAddress,
  browsing: Browsing = AS_IT_COMES,
): RepositoryState {
  const reading = reader.reading;
  if (reading?.id === undefined || reader.refused) return { status: "refused" };
  const ref = reader.refOf(address, world.trunk.head);
  // The commit being read: the one Keel resolved the ref to, once it has answered anything read at it.
  const sha = reader.resolved.get(reader.keyOf(ref, "")) ?? (ref === HEAD ? undefined : ref);
  const parts = address.path === "" ? [] : address.path.split("/");
  const history = reader.histories.get(reader.keyOf(ref, ""));
  const [latest] = history?.commits ?? [];
  const view = viewOf(world, reader, address, ref);
  // A project whose root cannot be read has no code to show, whatever the reason Keel gave.
  if (view.kind === "absent" && address.view === "code" && address.path === "")
    return { status: "refused" };
  if (sha === undefined) return { status: "loading" };
  const browser =
    address.view === "code" && address.path !== ""
      ? browserOf(reader, ref, address.path, browsing)
      : undefined;
  return {
    status: "ready",
    project: {
      name: reading.name,
      ...(reading.visibility === undefined ? {} : { visibility: reading.visibility }),
    },
    // Where no commit was named, what is read is trunk's head, wherever that is.
    ref: { sha, head: address.ref === undefined },
    crumbs: [
      { name: reading.name, path: "" },
      ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") })),
    ],
    ...(latest === undefined ? {} : { latest: rowOf(world, latest) }),
    ...(history === undefined
      ? {}
      : { commits: { count: history.commits.length, more: history.more } }),
    green: world.trunk.redCount === 0,
    ...(browser === undefined ? {} : { browser }),
    view,
  };
}
