// MCP events, live: an agent that holds only a key listens over MCP itself,
// with the official client, and is told of a conflict on its change within
// seconds. Nothing in the listening polls or calls the REST API.
//
//   (a) A key signs up, and the agent makes a project in its own namespace
//       from the template.
//   (b) The official client connects to /mcp on the current revision with a
//       plain bearer for the run `listener`, and the server says a resource
//       may be watched.
//   (c) A listen for `keel://inbox` and the project's feed is acknowledged
//       for both, and for nothing it may not watch.
//   (d) The run `listener` declares a change with a premise; the run `other`
//       declares one whose effect breaks it. The listen is told the inbox
//       changed; the client reads `keel://inbox` and finds the notice, and the
//       harness prints the time from the notice's commit to the update.
//   (e) The inbox tool held with a progress token: a progress notice comes at
//       once, and the answer when the wait ends.
//
// Both changes are withdrawn at the end.
//
// Usage: KEEL_URL=https://<host> node e2e/src/mcp-events.ts <run>
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { generateAgentKey, KeelClient, KeelProblem, signUp } from "@keeltown/sdk";
import { declareS1, FIXTURE } from "./lib/s1.ts";
import { projectEvents, tagged } from "./lib/live.ts";

const [run] = process.argv.slice(2);
if (run === undefined || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(run))
  throw new Error("usage: mcp-events.ts <run>, the run a lower-case slug");
const keelUrl = process.env.KEEL_URL;
if (keelUrl === undefined) throw new Error("KEEL_URL is not set: the Keel to sign up at");
const baseUrl = new URL(keelUrl).origin;
const MCP = `${baseUrl}/mcp`;
const INBOX = "keel://inbox";
const REVISION = "2026-07-28";
const CREATED_MS = 60_000;
const SETTLE_MS = 120_000;
/** The done-when: told within seconds. */
const TOLD_MS = 10_000;
const key = (what: string) => `mcp-events:${run}:${what}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

interface Notice {
  readonly id: string;
  readonly kind: string;
  readonly ref?: string;
  readonly title?: string;
  readonly at?: string;
}

async function listenLive(): Promise<void> {
  // (a) A key, and a project in the agent's own namespace.
  const { signer } = await generateAgentKey();
  const { agentId, handle } = await signUp({ baseUrl, signer });
  console.log(`     agent ${agentId}, handle ${handle}`);
  const account = new KeelClient({ baseUrl, agentId, key: signer });
  const project = await account.createProject(
    { namespace: handle, name: `mcp-events-${run}`, source: { kind: "template", name: FIXTURE } },
    { idempotencyKey: key("project") },
  );
  console.log(`     project ${handle}/mcp-events-${run}: ${project.id}`);
  const runOf = (label: string) =>
    new KeelClient({ baseUrl, agentId, key: signer, project: project.id, run: label });
  const listener = runOf("listener");
  const other = runOf("other");
  let initializedAt: number | undefined;
  const start = await projectEvents(listener, undefined, project.id, (seen) => {
    if (tagged(seen, "TrunkInitialized").length === 0) return false;
    initializedAt ??= Date.now();
    return tagged(seen, "ProjectCreated").length > 0 || Date.now() - initializedAt > CREATED_MS;
  });
  check(tagged(start, "ProjectCreated").length > 0, "(a) the project is made from the template");

  // (b) The official client, on the current revision, with a plain bearer for the run `listener`.
  const forMcp = new KeelClient({
    baseUrl,
    agentId,
    key: signer,
    project: project.id,
    run: "listener",
    resource: MCP,
    bound: false,
  });
  const client = new Client(
    { name: "keel-mcp-events", version: "0" },
    { versionNegotiation: { mode: { pin: REVISION } } },
  );
  const updates: { readonly uri: string; readonly at: number }[] = [];
  client.setNotificationHandler("notifications/resources/updated", (notification) => {
    updates.push({ uri: notification.params.uri, at: Date.now() });
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      authProvider: { token: async () => forMcp.token() },
    }),
  );
  const discovered = client.getDiscoverResult();
  check(
    discovered?.capabilities.resources?.subscribe === true,
    "(b) on the current revision the server says a resource may be watched",
  );

  // (c) A listen for the inbox, the project's feed, and a feed it may not watch.
  const feed = `keel://projects/${project.id}/events`;
  const elsewhere = "keel://projects/prj_00000000000000000000000000/events";
  const listen = await client.listen({ resourceSubscriptions: [INBOX, feed, elsewhere] });
  console.log(`     acknowledged ${JSON.stringify(listen.honoredFilter)}`);
  check(
    JSON.stringify(listen.honoredFilter.resourceSubscriptions) === JSON.stringify([INBOX, feed]),
    "(c) the listen is acknowledged for its own inbox and its project's feed, and not another's",
  );

  // (d) A conflict on the listening run's change, caused by its other run.
  const declared: string[] = [];
  const base = (await listener.commits(project.id, { limit: 1 })).items[0]?.sha;
  if (base === undefined) throw new Error("the project's trunk has no commit");
  try {
    const before = updates.length;
    const caused = Date.now();
    await declareS1(
      { a: listener, b: other },
      base,
      (party) => key(`declare-${party}`),
      SETTLE_MS,
      (changeId) => declared.push(changeId),
    );
    const told = await waitFor(
      () => updates.slice(before).find((update) => update.uri === INBOX),
      TOLD_MS + 20_000,
    );
    check(told !== undefined, "(d) the listen is told the inbox changed");
    const read = await client.readResource({ uri: INBOX }, { cacheMode: "bypass" });
    const [contents] = read.contents;
    const page: { result?: { notices?: Notice[] } } =
      contents !== undefined && "text" in contents ? JSON.parse(contents.text) : {};
    const notices = page.result?.notices ?? [];
    const notice = notices.find((n) => declared[0] !== undefined && n.ref?.includes(declared[0]));
    for (const n of notices) console.log(`     notice ${n.kind} ${n.ref ?? ""} ${n.title ?? ""}`);
    check(notice !== undefined, "(d) keel://inbox holds a notice about the listening run's change");
    if (told !== undefined && notice?.at !== undefined) {
      const fromCommit = told.at - Date.parse(notice.at);
      console.log(
        `     from the notice's commit to the update: ${fromCommit} ms; from the second declare's start: ${told.at - caused} ms`,
      );
      check(fromCommit < TOLD_MS, `(d) told within ${TOLD_MS / 1000} s of the notice's commit`);
    }

    // (e) The inbox tool held with a progress token.
    let progressAt: number | undefined;
    const asked = Date.now();
    const held = await client.callTool(
      { name: "inbox", arguments: { cursor: "end", wait: 5 } },
      {
        onprogress: () => {
          progressAt ??= Date.now();
        },
        timeout: 60_000,
      },
    );
    check(
      progressAt !== undefined && progressAt - asked < 5_000,
      "(e) a held inbox read given a progress token is told at once that it waits",
    );
    check(held.isError !== true, "(e) and answers when its wait ends");
  } finally {
    await listen.close();
    await client.close();
    for (const changeId of declared) {
      try {
        await runOf(changeId === declared[0] ? "listener" : "other").abandon(
          changeId,
          { reason: `mcp-events ${run} finished` },
          { idempotencyKey: key(`abandon:${changeId}`) },
        );
        console.log(`     withdrawn ${changeId}`);
      } catch (error) {
        console.log(`     not withdrawn ${changeId}: ${String(error)}`);
      }
    }
  }
}

async function waitFor<T>(found: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = found();
    if (value !== undefined || Date.now() > deadline) return value;
    // A deadline for the harness, not a poll of Keel: the update arrives on the open listen.
    // oxlint-disable-next-line no-await-in-loop -- checks what the listen has told so far
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

try {
  await listenLive();
} catch (error) {
  failures += 1;
  if (error instanceof KeelProblem)
    console.log(`FAIL ${error.code}: ${error.message} next: ${JSON.stringify(error.nextActions)}`);
  else console.log(`FAIL ${String(error)}`);
}
console.log(failures === 0 ? "all mcp-events checks hold" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
