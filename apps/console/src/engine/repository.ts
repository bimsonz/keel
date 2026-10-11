// The repository, as the console shows it: read on demand from Keel, beside
// the log, and joined to what the log says (a change's number and state,
// trunk's head). Nothing here is folded from events, and nothing is kept
// that Keel did not answer with.

import type { DiffFile } from "../domain/state.ts";
import type {
  KeelRepository,
  RepoBlob,
  RepoCommit,
  RepoCommitDiff,
  RepoNote,
  RepoProject,
  RepoTree,
} from "../source/repository.ts";
import type { World } from "./world.ts";

/** Where in the repository the view is: among its files, or in its history. */
export interface RepoAddress {
  view: "code" | "history";
  /** A commit to read at. Absent: trunk's head. */
  ref?: string;
  /** A directory or a file, from the root. The root is the empty path. */
  path: string;
  /** In the history: the commit whose diff is open. */
  commit?: string;
}

const PAGE = 100;

/** Reads the repository once for each thing asked, and keeps what Keel answered. */
export class RepositoryReader {
  project: RepoProject | undefined;
  /** True once Keel has refused to say what the project is: it does not serve a repository. */
  unserved = false;
  readonly trees = new Map<string, RepoTree>();
  readonly blobs = new Map<string, RepoBlob>();
  readonly notes = new Map<string, RepoNote[]>();
  readonly diffs = new Map<string, RepoCommitDiff>();
  readonly histories = new Map<string, { commits: RepoCommit[]; more: boolean }>();
  /** Asked for, and not there. */
  readonly absent = new Set<string>();
  readonly #asked = new Set<string>();
  readonly #source: KeelRepository;
  readonly #changed: () => void;

  constructor(source: KeelRepository, changed: () => void) {
    this.#source = source;
    this.#changed = changed;
  }

  /** The commit an address reads at: the one it names, else trunk's head as the log has it, else the project's own. */
  refOf(address: RepoAddress, head: string): string | undefined {
    return address.ref ?? (head === "" ? this.project?.head : head);
  }

  /** Ask what the project is: its name, who may read it, where to clone it from. */
  wantProject(): void {
    this.#once(
      "project",
      async () => {
        this.project = await this.#source.getProject();
      },
      () => {
        this.unserved = true;
      },
    );
  }

  /**
   * Read whatever `address` needs that has not been asked for yet. Beside a file or a directory below the root
   * stands the list of files it sits among: for that, the root and each directory on the way are read, and
   * whichever directories a reader has `opened`.
   */
  want(address: RepoAddress, head: string, opened: Iterable<string> = []): void {
    this.wantProject();
    const ref = this.refOf(address, head);
    if (ref === undefined) return;
    // The code's own page says where trunk is: its latest commit, and how many there are.
    this.#once(`history ${ref}`, async () => {
      const page = await this.#source.getCommits({ ref, limit: PAGE });
      this.histories.set(ref, { commits: page.items, more: page.items.length === PAGE });
    });
    if (address.view === "code") {
      this.#wantPath(ref, address.path);
      if (address.path !== "") {
        const parts = address.path.split("/");
        for (const directory of [
          "",
          ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/")),
          ...opened,
        ])
          this.#wantTree(ref, directory);
      }
      return;
    }
    const sha = address.commit;
    if (sha === undefined) return;
    this.#once(
      `commit ${sha}`,
      async () => {
        this.diffs.set(sha, await this.#source.getCommitDiff(sha));
      },
      () => this.absent.add(`commit ${sha}`),
    );
  }

  /** A directory known to be one, read for the list of files beside the code. */
  #wantTree(ref: string, path: string): void {
    const key = `${ref}:${path}`;
    if (this.trees.has(key)) return;
    this.#once(`tree ${key}`, async () => {
      this.trees.set(key, await this.#source.getTree({ ref, path }));
    });
  }

  #wantPath(ref: string, path: string): void {
    const key = `${ref}:${path}`;
    // A path is a directory or a file, and only Keel knows which. A directory is tried first.
    this.#once(`path ${key}`, async () => {
      try {
        this.trees.set(key, await this.#source.getTree({ ref, path }));
        return;
      } catch {
        // Not a directory.
      }
      let blob: RepoBlob;
      try {
        blob = await this.#source.getBlob({ ref, path });
      } catch {
        this.absent.add(key);
        return;
      }
      // A file whose notes cannot be read is still a file.
      const notes = await this.#source.getNotes({ ref, path }).then(
        (answer) => answer.notes,
        () => [],
      );
      // Both at once: the file is never there to be drawn without the notes that belong beside its lines.
      this.blobs.set(key, blob);
      this.notes.set(key, notes);
    });
    // A directory's README is shown beneath it.
    const readme = this.trees
      .get(key)
      ?.entries.find((entry) => entry.kind === "blob" && /^readme\.md$/i.test(entry.name));
    if (readme === undefined) return;
    const at = path === "" ? readme.name : `${path}/${readme.name}`;
    this.#once(`readme ${ref}:${at}`, async () => {
      this.blobs.set(`${ref}:${at}`, await this.#source.getBlob({ ref, path: at }));
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
        size?: number;
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
  /** Keel does not serve a repository. */
  | { status: "unserved" }
  | { status: "loading" }
  | {
      status: "ready";
      project: { name: string; visibility: RepoProject["visibility"]; cloneUrl: string };
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

function rowOf(world: World, commit: RepoCommit): CommitRow {
  return {
    sha: commit.sha,
    at: commit.at,
    message: commit.message,
    ...(commit.height === undefined ? {} : { height: commit.height }),
    unverified: commit.verified === false,
    changes: commit.changes.map((change) => ({
      id: change.changeId,
      label: change.label,
      known: world.changes.has(change.changeId),
    })),
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
      if (reader.absent.has(`commit ${address.commit}`))
        return { kind: "absent", what: `commit ${address.commit.slice(0, 7)}` };
      const diff = reader.diffs.get(address.commit);
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
    const history = reader.histories.get(ref);
    return history === undefined
      ? { kind: "loading" }
      : {
          kind: "history",
          commits: history.commits.map((commit) => rowOf(world, commit)),
          more: history.more,
        };
  }
  const key = `${ref}:${address.path}`;
  if (reader.absent.has(key)) return { kind: "absent", what: address.path };
  const tree = reader.trees.get(key);
  if (tree !== undefined) {
    const join = (name: string): string => (address.path === "" ? name : `${address.path}/${name}`);
    const entries = inOrder(tree).map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      path: join(entry.name),
      ...(entry.size === undefined ? {} : { size: entry.size }),
    }));
    const named = entries.find(
      (entry) => entry.kind === "blob" && /^readme\.md$/i.test(entry.name),
    );
    const readme = named === undefined ? undefined : reader.blobs.get(`${ref}:${named.path}`);
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
  const root = reader.trees.get(`${ref}:`);
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
      const inside = open ? reader.trees.get(`${ref}:${at}`) : undefined;
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
  if (reader.unserved) return { status: "unserved" };
  const { project } = reader;
  const ref = reader.refOf(address, world.trunk.head);
  if (project === undefined || ref === undefined) return { status: "loading" };
  const head = world.trunk.head === "" ? project.head : world.trunk.head;
  const parts = address.path === "" ? [] : address.path.split("/");
  const history = reader.histories.get(ref);
  const [latest] = history?.commits ?? [];
  const browser =
    address.view === "code" && address.path !== ""
      ? browserOf(reader, ref, address.path, browsing)
      : undefined;
  return {
    status: "ready",
    project: { name: project.name, visibility: project.visibility, cloneUrl: project.cloneUrl },
    ref: { sha: ref, head: ref === head },
    crumbs: [
      { name: project.name, path: "" },
      ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") })),
    ],
    ...(latest === undefined ? {} : { latest: rowOf(world, latest) }),
    ...(history === undefined
      ? {}
      : { commits: { count: history.commits.length, more: history.more } }),
    green: world.trunk.redCount === 0,
    ...(browser === undefined ? {} : { browser }),
    view: viewOf(world, reader, address, ref),
  };
}
