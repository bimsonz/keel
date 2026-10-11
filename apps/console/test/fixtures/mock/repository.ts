// The repository a fixture's story is about, served the way the console asks
// Keel for one: a tree, a file, trunk's history, a commit's diff, and the
// notes beside a file's lines. Everything here is read off the scripted log:
// a commit is an advance of trunk, its files are what the changes it landed
// put there, and a note is something the log says about the subject a line
// anchors.

import type { LandedFile, Landing } from "../repo.ts";
import { sha256Hex } from "../sha256.ts";
import type {
  KeelRepository,
  RepoAt,
  RepoCommit,
  RepoCommitDiff,
  RepoCommitPage,
  RepoFileDiff,
  RepoNote,
  RepoNotes,
  RepoProject,
  RepoTree,
} from "../../../src/source/repository.ts";
import type { GeneratedLog } from "./builder.ts";

interface Snapshot {
  commit: RepoCommit;
  /** How far into the log this commit is. */
  index: number;
  files: Map<string, string>;
  anchors: Landing["anchors"];
  diff: RepoFileDiff[];
}

interface Derived {
  project: RepoProject;
  /** Oldest first. */
  snapshots: Snapshot[];
}

const NONE = "this fixture has no repository";

function apply(files: Map<string, string>, changed: readonly LandedFile[]): RepoFileDiff[] {
  return changed.flatMap((file) => {
    const before = files.get(file.path) ?? null;
    if (before === file.after) return [];
    if (file.after === null) files.delete(file.path);
    else files.set(file.path, file.after);
    return [
      {
        path: file.path,
        status: before === null ? "added" : file.after === null ? "deleted" : "modified",
        before,
        after: file.after,
        binary: false,
      },
    ];
  });
}

/** Trunk's history and the files at each commit, from the log. Null when the script has no repository. */
function derive(log: GeneratedLog): Derived | null {
  const scripted = log.repository;
  if (scripted === undefined) return null;
  const labels = new Map<string, { label: string; goal: string }>();
  const files = new Map<string, string>();
  let anchors = [...scripted.anchors];
  const snapshots: Snapshot[] = [];
  let project: RepoProject | undefined;
  log.events.forEach((event, index) => {
    if (event.type === "ProjectCreated") {
      project = {
        id: event.payload.projectId,
        name: event.payload.name,
        visibility: "public",
        cloneUrl: `https://keel.town/${event.payload.name}.git`,
        head: "",
      };
    } else if (event.type === "IntentDeclared") {
      labels.set(event.payload.changeId, {
        label: event.label ?? event.payload.changeId.slice(-4),
        goal: event.payload.goal,
      });
    } else if (event.type === "TrunkInitialized") {
      const diff = apply(files, scripted.base);
      snapshots.push({
        commit: {
          sha: event.payload.head,
          parents: [],
          at: event.at,
          message: "Start of trunk",
          changes: [],
          height: 0,
        },
        index,
        files: new Map(files),
        anchors: [...anchors],
        diff,
      });
    } else if (event.type === "TrunkAdvanced") {
      const members = event.payload.landings.map((landing) => landing.changeId);
      const landings = members.flatMap((member) => scripted.landings.get(member) ?? []);
      const diff = landings.flatMap((landing) => apply(files, landing.files));
      // A landing that writes a file says afresh which of its lines anchor a subject.
      const written = new Set(
        landings.flatMap((landing) => landing.files.map((file) => file.path)),
      );
      anchors = [
        ...anchors.filter((anchor) => !written.has(anchor.path)),
        ...landings.flatMap((landing) => landing.anchors),
      ];
      const changes = members.map((member) => ({
        changeId: member,
        label: labels.get(member)?.label ?? member.slice(-4),
      }));
      const said = members
        .map((member) => labels.get(member)?.goal ?? "")
        .filter((goal) => goal !== "");
      snapshots.push({
        commit: {
          sha: event.payload.to,
          parents: [event.payload.from],
          at: event.at,
          message: said.length > 0 ? said.join("; ") : "Advances not told in this log",
          changes,
          ...(event.payload.height === undefined ? {} : { height: event.payload.height }),
          ...(event.payload.verified === undefined ? {} : { verified: event.payload.verified }),
        },
        index,
        files: new Map(files),
        anchors: [...anchors],
        diff,
      });
    }
  });
  const head = snapshots.at(-1)?.commit.sha;
  if (project === undefined || head === undefined) return null;
  return { project: { ...project, head }, snapshots };
}

/** What the log says, up to `until`, about the subject with this key. */
function notesOn(log: GeneratedLog, until: number, subjectKey: string, line: number): RepoNote[] {
  const at = { from: line, to: line, subject: subjectKey };
  let subjectId = "";
  const labels = new Map<string, string>();
  const premises = new Map<string, RepoNote>();
  const conflictsHere = new Map<string, string>();
  const guards = new Map<string, RepoNote>();
  const tenets = new Map<string, RepoNote>();
  const decisions = new Map<string, RepoNote>();
  for (const event of log.events.slice(0, until + 1)) {
    if (event.type === "SubjectMinted" && event.payload.key === subjectKey)
      subjectId = event.payload.subjectId;
    else if (event.type === "IntentDeclared" || event.type === "IntentRevised") {
      const { changeId } = event.payload;
      if (event.type === "IntentDeclared") labels.set(changeId, event.label ?? changeId.slice(-4));
      const held =
        event.type === "IntentDeclared" ? event.payload.premises : event.payload.premisesAdded;
      for (const premise of held.filter((candidate) => candidate.subject === subjectKey)) {
        premises.set(changeId, {
          ...at,
          kind: "premise",
          summary: `relies on ${premise.predicate} ${premise.relation.replace("-", " ")} ${String(premise.value)}`,
          holder: { changeId, label: labels.get(changeId) ?? changeId.slice(-4) },
        });
      }
    } else if (event.type === "ChangeWithdrawn" || event.type === "ChangeSuperseded")
      premises.delete(event.payload.changeId);
    else if (event.type === "ConflictSuspected" && event.payload.subjectId === subjectId)
      conflictsHere.set(event.payload.conflictId, event.label ?? "");
    else if (event.type === "GuardAdmitted" && conflictsHere.has(event.payload.conflictId)) {
      guards.set(event.payload.guardId, {
        ...at,
        kind: "guard",
        ...(event.label === undefined ? {} : { label: event.label }),
        summary: `guards this since conflict ${conflictsHere.get(event.payload.conflictId) ?? ""} was proven`,
      });
    } else if (event.type === "GuardRetired") guards.delete(event.payload.guardId);
    else if (event.type === "TenetEstablished" && event.payload.subjectId === subjectId) {
      const label = event.payload.x?.label;
      tenets.set(event.payload.tenetId, {
        ...at,
        kind: "tenet",
        ...(label === undefined ? {} : { label }),
        summary: `trunk holds ${event.payload.predicate} ${String(event.payload.value)}`,
      });
    } else if (event.type === "TenetRetracted" || event.type === "TenetSuperseded")
      tenets.delete(event.payload.tenetId);
    else if (event.type === "DecisionRecorded" && event.payload.scope === subjectKey) {
      decisions.set(event.payload.decisionId, {
        ...at,
        kind: "decision",
        ...(event.label === undefined ? {} : { label: event.label }),
        summary: event.payload.summary,
      });
    } else if (event.type === "DecisionSuperseded" || event.type === "DecisionOverruled")
      decisions.delete(event.payload.decisionId);
  }
  return [...decisions.values(), ...guards.values(), ...tenets.values(), ...premises.values()];
}

/** Rejects, as a transport would, when there is nothing to answer with. */
function answer<Answer>(read: () => Answer): Promise<Answer> {
  try {
    return Promise.resolve(read());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** `log` is asked for each time: a ruling replaces the log, and the repository follows it. */
export function createMockRepository(log: () => GeneratedLog): KeelRepository {
  let from: GeneratedLog | undefined;
  let derived: Derived | null = null;
  const current = (): Derived => {
    if (from !== log()) {
      from = log();
      derived = derive(from);
    }
    if (derived === null) throw new Error(NONE);
    return derived;
  };
  const snapshotAt = (ref: string | undefined): Snapshot => {
    const { snapshots } = current();
    const found =
      ref === undefined
        ? snapshots.at(-1)
        : snapshots.find((snapshot) => snapshot.commit.sha === ref);
    if (found === undefined) throw new Error(`no commit ${ref ?? ""}`);
    return found;
  };
  return {
    getProject: () => answer((): RepoProject => current().project),
    getTree: (at: RepoAt) =>
      answer((): RepoTree => {
        const snapshot = snapshotAt(at.ref);
        const prefix = at.path === "" ? "" : `${at.path}/`;
        const entries = new Map<string, RepoTree["entries"][number]>();
        for (const [path, content] of snapshot.files) {
          if (!path.startsWith(prefix)) continue;
          const [name, ...deeper] = path.slice(prefix.length).split("/");
          if (name === undefined || name === "") continue;
          if (deeper.length > 0)
            entries.set(name, {
              name,
              kind: "tree",
              sha: sha256Hex(`${snapshot.commit.sha}:${prefix}${name}`).slice(0, 40),
            });
          else
            entries.set(name, {
              name,
              kind: "blob",
              sha: sha256Hex(content).slice(0, 40),
              size: new TextEncoder().encode(content).length,
            });
        }
        if (entries.size === 0) throw new Error(`no directory ${at.path}`);
        return { ref: snapshot.commit.sha, path: at.path, entries: [...entries.values()] };
      }),
    getBlob: (at: RepoAt) =>
      answer(() => {
        const content = snapshotAt(at.ref).files.get(at.path);
        if (content === undefined) throw new Error(`no file ${at.path}`);
        return {
          path: at.path,
          sha: sha256Hex(content).slice(0, 40),
          size: new TextEncoder().encode(content).length,
          binary: false,
          content,
          truncated: false,
        };
      }),
    getCommits: (request) =>
      answer((): RepoCommitPage => {
        const { snapshots } = current();
        const tip =
          request.ref === undefined
            ? snapshots.length - 1
            : snapshots.findIndex((snapshot) => snapshot.commit.sha === request.ref);
        if (tip < 0) throw new Error(`no commit ${request.ref ?? ""}`);
        // Newest first, from the ref back to the start of trunk.
        const history = snapshots.slice(0, tip + 1).toReversed();
        const start = Number(request.cursor ?? "0") || 0;
        const items = history
          .slice(start, start + (request.limit ?? 50))
          .map((snapshot) => snapshot.commit);
        return { items, nextCursor: String(start + items.length) };
      }),
    getCommitDiff: (sha: string) =>
      answer((): RepoCommitDiff => {
        const snapshot = snapshotAt(sha);
        return { commit: snapshot.commit, files: snapshot.diff };
      }),
    getNotes: (at: RepoAt) =>
      answer((): RepoNotes => {
        const snapshot = snapshotAt(at.ref);
        if (!snapshot.files.has(at.path)) throw new Error(`no file ${at.path}`);
        const notes = snapshot.anchors
          .filter((anchor) => anchor.path === at.path)
          .flatMap((anchor) => notesOn(log(), snapshot.index, anchor.subject, anchor.line));
        return { path: at.path, ref: snapshot.commit.sha, notes };
      }),
  };
}
