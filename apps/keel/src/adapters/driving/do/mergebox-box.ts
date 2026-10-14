// MergeBox's work, behind a seam over its container, so it is tested without
// one: starting the box (its CA trusted, the canary planted), a compose and
// the check that follows every compose, and which outbound request the egress
// lets out. The object (`mergebox.ts`) is the shell that holds the container.
import {
  BOX_CHECK_SCRIPT,
  BOX_COMPOSE_SCRIPT,
  BOX_PLANT_SCRIPT,
  boxComposeArgs,
  type BoxMember,
  readBoxCompose,
  scanBoxCheck,
} from "@keeltown/gitcore";
import type { BoxComposeAnswer, EgressGrant } from "../../../rpc/mergebox.ts";

/** What MergeBox needs of its container, narrowed from the platform's. */
export interface BoxContainer {
  readonly running: boolean;
  /** Starts the box with `env` in its start environment and nothing else: no credential is ever there. */
  readonly start: (env: Record<string, string>) => void;
  /** Whether the running box started from an image other than the one this deploy names. */
  readonly stale: () => Promise<boolean>;
  readonly destroy: () => Promise<void>;
  readonly exec: (
    argv: readonly string[],
    env: Record<string, string>,
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

/** Every exec's environment: a home, no prompt, and the identity of the unsigned commits that chain the merges. */
export const BOX_ENV: Record<string, string> = {
  HOME: "/root",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "keel-mergebox",
  GIT_AUTHOR_EMAIL: "mergebox@keel.invalid",
  GIT_COMMITTER_NAME: "keel-mergebox",
  GIT_COMMITTER_EMAIL: "mergebox@keel.invalid",
};

/** The CA the platform's HTTPS intercept signs with, added to the box's trust before git runs. */
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const SYSTEM = "/etc/ssl/certs/ca-certificates.system.crt";
export const BOX_TRUST_SCRIPT = `set -e
[ -e ${SYSTEM} ] || { cp ${BUNDLE} ${SYSTEM}.tmp && mv ${SYSTEM}.tmp ${SYSTEM}; }
timeout 10 sh -c 'until [ -s ${CA} ]; do sleep 0.1; done'
cat ${SYSTEM} ${CA} > ${BUNDLE}.tmp && mv ${BUNDLE}.tmp ${BUNDLE}`;

/** How long a box has to run its first command. */
const READY_WITHIN_MS = 180_000;

/** Where the canary of the running box is kept, so an object that restarts still checks against it. */
export interface CanaryStore {
  readonly get: () => string | undefined;
  readonly set: (canary: string | undefined) => void;
}

/** A canary shaped as an Artifacts token, so the check's search by shape is seen to work too. */
export const freshCanary = (): string =>
  `art_v9_keelcanary_${crypto.randomUUID().replaceAll("-", "")}`;

/** One compose for the box: staging's and each member's remotes, which the egress turns into tokens. */
export interface BoxJob {
  readonly candidateId: string;
  readonly staging: string;
  readonly base: string;
  readonly members: readonly BoxMember[];
}

/** The scratch ref a candidate's chain is pushed to, swept by the next compose. */
export const scratchRef = (candidateId: string) => `refs/keel/box/${candidateId}`;

/**
 * Starts the box unless it runs with a canary this object knows, from the
 * image this deploy names: started with a fresh canary in its environment, it
 * runs its first command, trusts the egress's CA, and plants the canary in
 * its file. A box running with a canary this object has lost is destroyed
 * and started again, since its environment cannot change; so is one a deploy
 * has given a new image, which a running box never takes on its own. Answers
 * how long it took (0 when it ran).
 */
export async function readyBox(
  container: BoxContainer,
  canaries: CanaryStore,
  now: () => number = Date.now,
): Promise<number> {
  if (container.running && canaries.get() !== undefined && !(await container.stale())) return 0;
  const began = now();
  if (container.running) await container.destroy();
  const canary = freshCanary();
  canaries.set(undefined);
  container.start({ KEEL_CANARY: canary });
  for (;;) {
    try {
      await container.exec(["true"], BOX_ENV);
      break;
    } catch (error) {
      if (now() - began > READY_WITHIN_MS)
        throw new Error(`the box never ran a command: ${String(error)}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  for (const [script, args] of [
    [BOX_TRUST_SCRIPT, []],
    [BOX_PLANT_SCRIPT, [canary]],
  ] as const) {
    const run = await container.exec(["bash", "-c", script, "box", ...args], BOX_ENV);
    if (run.exitCode !== 0) throw new Error(`the box was not readied: exit ${run.exitCode}`);
  }
  canaries.set(canary);
  return now() - began;
}

/**
 * Composes `job` in the ready box, then checks the box: always, whatever the
 * compose came to, since a token could sit in it either way. `minted` is
 * every token the egress minted for this compose, read after both have run.
 * A check that does not pass refuses the candidate as a defect.
 */
export async function composeInBox(
  container: BoxContainer,
  canary: string,
  job: BoxJob,
  minted: () => readonly string[],
  startMs: number,
  now: () => number = Date.now,
): Promise<BoxComposeAnswer> {
  const scratch = scratchRef(job.candidateId);
  const composing = now();
  const run = await container.exec(
    [
      "bash",
      "-c",
      BOX_COMPOSE_SCRIPT,
      "box",
      ...boxComposeArgs(job.staging, job.base, scratch, job.members),
    ],
    BOX_ENV,
  );
  const checking = now();
  const check = await container.exec(["bash", "-c", BOX_CHECK_SCRIPT], BOX_ENV);
  const done = now();
  const timings = {
    startMs,
    composeMs: checking - composing,
    checkMs: done - checking,
    checkBytes: new TextEncoder().encode(check.stdout).length,
  };
  const checked = scanBoxCheck(check.stdout, canary, minted());
  if ("kind" in checked)
    return { kind: "check-failed", reason: `${JSON.stringify(checked)} (${timings.checkBytes} B)` };
  const read = readBoxCompose(run.exitCode, run.stdout, job.members.length);
  switch (read.kind) {
    case "composed":
      return {
        kind: "composed",
        trees: read.trees,
        scratch,
        tip: read.tip,
        boxCheck: checked,
        timings,
      };
    case "refused":
      return { kind: "refused", member: read.member, paths: read.paths, timings };
    case "crashed":
      return { kind: "crashed", exitCode: read.exitCode };
  }
  // git names the remote it failed on, and a remote carries the account id: never let one out.
  return {
    kind: "failed",
    reason: `${read.reason}: ${run.stderr.replace(/https?:\/\/\S+/g, "<remote>").slice(-400)}`,
  };
}

/** The repos one compose may reach, by the path of each remote: staging to read and write, each workspace to read. */
export interface EgressScope {
  readonly staging: string;
  readonly reads: ReadonlySet<string>;
}

/**
 * What the egress lets out: git's smart HTTP to a repo of the compose in
 * scope, upload-pack to read any of them and receive-pack only to staging.
 * Answers the repo's path and the access a token needs, or why not.
 */
export function egressDecision(
  url: URL,
  method: string,
  scope: EgressScope | undefined,
): { readonly repo: string; readonly access: "read" | "write" } | { readonly refused: string } {
  if (scope === undefined) return { refused: "no compose is running" };
  const advert = url.pathname.endsWith("/info/refs") && method === "GET";
  const service = advert
    ? url.searchParams.get("service")
    : method === "POST"
      ? url.pathname.slice(url.pathname.lastIndexOf("/") + 1)
      : null;
  if (service !== "git-upload-pack" && service !== "git-receive-pack")
    return { refused: `${method} ${url.pathname} is not git's smart HTTP` };
  const repo = url.pathname.slice(
    0,
    url.pathname.length - (advert ? "/info/refs" : `/${service}`).length,
  );
  if (service === "git-receive-pack")
    return repo === scope.staging
      ? { repo, access: "write" }
      : { refused: "a push only to staging" };
  return repo === scope.staging || scope.reads.has(repo)
    ? { repo, access: "read" }
    : { refused: "a repo the compose does not name" };
}

/** The running compose as the egress sees it: its scope, each repo by its remote's path, and every token minted for it. */
export interface Composing<R> {
  readonly scope: EgressScope;
  readonly repos: ReadonlyMap<string, R>;
  readonly minted: string[];
}

/**
 * A token for one outbound request of the box: for a repo of the running
 * compose, read for upload-pack and write for receive-pack to staging alone,
 * minted fresh for this request and kept, so the check can look for it;
 * refused otherwise, with nothing minted.
 */
export async function grantFor<R>(
  ask: { readonly url: string; readonly method: string },
  composing: Composing<R> | undefined,
  mint: (repo: R, access: "read" | "write") => Promise<string>,
): Promise<EgressGrant> {
  const decided = egressDecision(new URL(ask.url), ask.method, composing?.scope);
  if ("refused" in decided) return decided;
  const repo = composing?.repos.get(decided.repo);
  if (repo === undefined || composing === undefined)
    return { refused: "a repo the compose does not name" };
  const token = await mint(repo, decided.access);
  composing.minted.push(token);
  return { token };
}

/**
 * What the egress does with one request of the box: asks for its grant, and
 * either refuses it, sending nothing, or sends it over HTTPS with the minted
 * token as its only credential, whatever the box put in its own header.
 */
export async function egressForward(
  request: Request,
  grant: (ask: { readonly url: string; readonly method: string }) => Promise<EgressGrant>,
  send: (request: Request) => Promise<Response>,
): Promise<Response> {
  const granted = await grant({ url: request.url, method: request.method });
  if ("refused" in granted)
    return new Response(`refused by MergeBoxEgress: ${granted.refused}`, { status: 403 });
  const url = new URL(request.url);
  url.protocol = "https:";
  const forwarded = new Request(url.toString(), request);
  forwarded.headers.set("authorization", `Bearer ${granted.token}`);
  return send(forwarded);
}
