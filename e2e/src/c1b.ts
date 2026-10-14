// The live proof that a project is answered at trunk and finished behind it:
//   KEEL_URL=<keel> KEEL_SESSION=<token> KEEL_NAMESPACE=<handle> node e2e/src/c1b.ts <run> <source> [<url>]
//
// KEEL_SESSION is a user's bearer session, read and never printed. That user
// makes two projects in KEEL_NAMESPACE, new for the run, and sponsors an agent
// in each:
//   (a) `<run>-fork`, a fork of the namespace's project `<source>`;
//   (b) `<run>-import`, an import of Keel's own public repository (or `<url>`,
//       any public Git repository).
// For each it times two things from the create's ask: the create's answer,
// and the first declare of the project's agent that is granted a workspace.
// The pool is configured by the project's finish, behind the answer, so until
// then a declare is refused `workspace.pool_exhausted` and is asked again
// after the wait the refusal names. The declared change is then abandoned.
// No remote URL or credential is printed.
import { KeelClient, KeelProblem } from "@keeltown/sdk";

const [run, source, url] = process.argv.slice(2);
if (run === undefined || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(run) || source === undefined)
  throw new Error("usage: c1b.ts <run> <source> [<url>], the run a lower-case slug");
const needed = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(
      `${name} is not set: c1b needs KEEL_URL, KEEL_SESSION (a user's session) and KEEL_NAMESPACE (the projects' namespace, by handle)`,
    );
  return value;
};
const keelUrl = needed("KEEL_URL");
const session = needed("KEEL_SESSION");
const NAMESPACE = needed("KEEL_NAMESPACE");
const UPSTREAM = url ?? "https://github.com/bimsonz/keel";
/** How long a declare is asked again while the pool refuses it, from the create's ask. */
const POOLED_MS = 10 * 60_000;
const key = (what: string) => `c1b:${run}:${what}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

const operator = new KeelClient({ baseUrl: keelUrl, session });

type Start =
  | { readonly kind: "fork"; readonly project: string }
  | { readonly kind: "import"; readonly url: string };

/** Creates `name` from `start`, then declares in it until a workspace is granted, timing both from the ask. */
async function timed(label: string, name: string, start: Start): Promise<void> {
  const asked = Date.now();
  const project = await operator.createProject(
    { namespace: NAMESPACE, name, source: start },
    { idempotencyKey: key(`project:${name}`) },
  );
  const answered = Date.now() - asked;
  console.log(
    `     ${label} ${NAMESPACE}/${name}: ${project.id}, the create answered in ${answered} ms`,
  );
  const enrolment = await operator.enrolAgent(
    {
      name: "c1b-agent",
      kind: "interactive",
      scopes: ["agent:read", "agent:work"],
      projectId: project.id,
    },
    { idempotencyKey: key(`agent:${name}`) },
  );
  const enrolled = Date.now() - asked;
  const agent = new KeelClient({
    baseUrl: keelUrl,
    clientId: enrolment.clientId,
    clientSecret: enrolment.clientSecret,
  });
  const refusals: number[] = [];
  for (;;) {
    try {
      const declared = (
        await agent.declare(
          {
            goal: `c1b ${run}: the first workspace of ${name}`,
            footprint: [{ path: `c1b-${run}.md`, op: "create" }],
            premises: [],
          },
          { idempotencyKey: key(`declare:${name}`) },
        )
      ).result;
      const granted = Date.now() - asked;
      console.log(
        `     ${label}: agent enrolled at +${enrolled} ms; the first workspace granted at +${granted} ms, ${granted - answered} ms after the answer, after ${refusals.length} refusal(s)${refusals.length === 0 ? "" : ` naming waits of ${refusals.join(", ")} ms`}`,
      );
      check(
        declared.workspace.remote !== "",
        `(${label}) the first declare answered holds a workspace`,
      );
      check(
        answered < granted,
        `(${label}) the create answered before the project had a workspace to grant`,
      );
      await agent.abandon(
        declared.change.id,
        {},
        { lease: declared.lease.id, idempotencyKey: key(`abandon:${name}`) },
      );
      return;
    } catch (error) {
      if (
        !(error instanceof KeelProblem) ||
        error.code !== "workspace.pool_exhausted" ||
        Date.now() - asked > POOLED_MS
      )
        throw error;
      const wait = error.retryAfterMs ?? 5_000;
      refusals.push(wait);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

console.log(`c1b run ${run} at ${new Date().toISOString()}`);
const from = await operator.project(NAMESPACE, source);
console.log(`     source ${NAMESPACE}/${source}: ${from.id}`);
await timed("(a) fork", `${run}-fork`, { kind: "fork", project: from.id });
await timed("(b) import", `${run}-import`, { kind: "import", url: UPSTREAM });
console.log(failures === 0 ? "c1b: all checks passed" : `c1b: ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
