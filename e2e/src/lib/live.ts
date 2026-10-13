import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type KeelClient, KeelProblem } from "@keeltown/sdk";
import { git } from "./git.ts";

export type EventRecord = Awaited<ReturnType<KeelClient["events"]>>["items"][number];
export type Declared = Awaited<ReturnType<KeelClient["declare"]>>["result"];
type Intent = Parameters<KeelClient["declare"]>[0];

/** How long a live scenario waits for a project to settle. */
export const SETTLE_MS = 15 * 60_000;

/**
 * The project's events after `cursor` (from its first when there is none),
 * read until `done` holds or the deadline passes.
 */
export async function projectEvents(
  reader: KeelClient,
  cursor: string | undefined,
  projectId: string,
  done: (events: readonly EventRecord[]) => boolean,
): Promise<EventRecord[]> {
  const seen: EventRecord[] = [];
  const deadline = Date.now() + SETTLE_MS;
  let at = cursor;
  while (Date.now() < deadline) {
    const page = await reader.events({
      ...(at === undefined ? {} : { cursor: at }),
      project: projectId,
      limit: 500,
    });
    at = page.nextCursor;
    seen.push(...page.items.filter((e) => e.project === projectId));
    if (done(seen)) break;
    if (page.items.length === 0) await new Promise((r) => setTimeout(r, 3_000));
  }
  return seen;
}

export const tagged = (events: readonly EventRecord[], tag: string, changeId?: string) =>
  events.filter(
    (e) =>
      e.payload._tag === tag &&
      (changeId === undefined || Reflect.get(e.payload, "changeId") === changeId),
  );

/** One line per event, ids and shas short, as e2e:chain prints them. */
export function line(e: EventRecord): string {
  const keep = ["changeId", "workspaceId", "ref", "sha", "commitSha", "base", "from", "to", "head"];
  const parts = keep.flatMap((k) => {
    const v = Reflect.get(e.payload, k);
    if (typeof v !== "string") return [];
    return [`${k}=${/^[0-9a-f]{40}$/.test(v) ? v.slice(0, 12) : v}`];
  });
  const landings: unknown = Reflect.get(e.payload, "landings");
  if (Array.isArray(landings))
    parts.push(
      `landings=[${landings.map((l) => `${String(Reflect.get(Object(l), "changeId"))}@${String(Reflect.get(Object(l), "commitSha")).slice(0, 12)}`).join(", ")}]`,
    );
  return `${e.at}  ${e.payload._tag.padEnd(22)} ${parts.join(" ")}`;
}

/** Declares `intent`, asking again while the project's pool is still forking its workspaces. */
export async function declareWhenPooled(
  client: KeelClient,
  intent: Pick<Intent, "goal" | "footprint">,
  idempotencyKey: string,
): Promise<Declared> {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    try {
      return (await client.declare({ ...intent, premises: [] }, { idempotencyKey })).result;
    } catch (error) {
      if (
        !(error instanceof KeelProblem) ||
        error.code !== "workspace.pool_exhausted" ||
        Date.now() > deadline
      )
        throw error;
      console.log(`     pool still forking; retrying in ${error.retryAfterMs ?? 5_000} ms`);
      await new Promise((r) => setTimeout(r, error.retryAfterMs ?? 5_000));
    }
  }
}

/** Whether the clone in `dir` holds `sha` as a commit. */
export function holdsCommit(dir: string, sha: string): boolean {
  try {
    git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** git's setting that names the signers file a commit is verified against. */
const trusting = (file: string) => ["-c", `gpg.ssh.allowedSignersFile=${file}`];

/** Stock git's reading of who signed a commit, against one signers file or another. */
export interface KeelSigners {
  /** The name Keel signs and commits under at this host. */
  readonly principal: string;
  /** The signers file Keel publishes, as fetched. */
  readonly published: string;
  /** A signers file that gives Keel's name to a key made here. */
  readonly stranger: string;
  /** Whether `git verify-commit` accepts `sha` against the signers file at `file`. */
  readonly verifies: (file: string, sha: string) => boolean;
  /** `git log -1 --format=<format>` of `sha`, read with the published file trusted. */
  readonly show: (sha: string, format: string) => string;
}

/**
 * Keel's published signers file and a stranger's, written under the `.git` of
 * the clone in `dir`. The stranger's is another key under Keel's own name: a
 * signature is good only by a key the file holds.
 */
export async function keelSigners(
  dir: string,
  client: KeelClient,
  keelUrl: string,
): Promise<KeelSigners> {
  const principal = `keel@${new URL(keelUrl).host}`;
  const published = join(dir, ".git", "keel-allowed-signers");
  writeFileSync(published, await client.allowedSigners());
  const strangerKey = join(dir, ".git", "stranger");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", strangerKey]);
  const stranger = join(dir, ".git", "stranger-allowed-signers");
  writeFileSync(
    stranger,
    `${principal} namespaces="git" ${readFileSync(`${strangerKey}.pub`, "utf8").trim()}\n`,
  );
  return {
    principal,
    published,
    stranger,
    verifies: (file, sha) => {
      try {
        git(dir, [...trusting(file), "verify-commit", sha]);
        return true;
      } catch {
        return false;
      }
    },
    show: (sha, format) =>
      git(dir, [...trusting(published), "log", "-1", `--format=${format}`, sha]),
  };
}
