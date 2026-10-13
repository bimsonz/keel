import { describe, expect, it } from "vitest";
import type { KeelClient } from "../src/index.ts";
import { ROUTES, type RoutedOperation } from "../src/routes.ts";
import { fakeKeel } from "./fake-keel.ts";

/** The value each path parameter takes below. */
const SAMPLE: Readonly<Record<string, string>> = {
  changeId: "chg_1",
  workspaceId: "wsp_1",
  conflictId: "cfl_1",
  probeId: "prb_1",
  decisionId: "dec_1",
  verdictId: "vrd_1",
  candidateId: "cnd_1",
  projectId: "prj_1",
  agentId: "agt_1",
  escalationId: "esc_1",
  org: "keel",
  name: "forge-lite",
  sha: "a".repeat(40),
};

const LEASE = { lease: "lse_1" };
const PROPOSITION = {
  subject: "authz.permissions",
  predicate: "idempotent",
  relation: "is",
  value: true,
} as const;

/**
 * One call of the client's method for each routed operation. Typed as a
 * record over every routed operation, so an operation with a route and no
 * method here fails to compile, and [sdk.methods] then checks each call
 * reaches its own route.
 */
const INVOKE: Readonly<Record<RoutedOperation, (client: KeelClient) => Promise<unknown>>> = {
  whoami: (c) => c.whoami(),
  askSponsor: (c) => c.askSponsor(),
  Agents_getAgent: (c) => c.agent("agt_1"),
  Agents_listSponsored: (c) => c.sponsoredAgents(),
  Agents_approveSponsor: (c) => c.approveSponsor("agt_1", "CODE"),
  Agents_endSponsorship: (c) => c.endSponsorship("agt_1"),
  SignIn_methods: (c) => c.signInMethods(),
  Sessions_openSession: (c) => c.openSession({ harness: "h" }),
  declare: (c) => c.declare({ goal: "g", footprint: [], premises: [] }),
  Changes_listChanges: (c) => c.changes({ state: "working", limit: 5 }),
  change: (c) => c.change("chg_1"),
  revise: (c) => c.revise("chg_1", { goal: "g2" }, { ...LEASE, ifMatch: 3 }),
  rely: (c) => c.rely("chg_1", { premise: PROPOSITION }, LEASE),
  nearby: (c) => c.nearby("chg_1"),
  submit: (c) => c.submit({ changeId: "chg_1", commitSha: SAMPLE["sha"] ?? "" }, LEASE),
  status: (c) => c.status("chg_1", { wait: 1 }),
  abandon: (c) => c.abandon("chg_1", { reason: "r" }, LEASE),
  adopt: (c) => c.adopt("chg_1"),
  rebase: (c) => c.rebase("chg_1", LEASE),
  sketch: (c) => c.sketch({ purpose: "p" }),
  Workspaces_refreshWorkspaceToken: (c) => c.refreshWorkspaceToken("wsp_1"),
  Workspaces_releaseWorkspace: (c) => c.releaseWorkspace("wsp_1"),
  inbox: (c) => c.inbox({ cursor: "000000000001" }),
  Inbox_listEvents: (c) => c.events({ limit: 1 }),
  Inbox_getSnapshot: (c) => c.snapshot({ project: "prj_1" }),
  Conflicts_listConflicts: (c) => c.conflicts({ changeId: "chg_1" }),
  Conflicts_getConflict: (c) => c.conflict("cfl_1"),
  Probes_getProbeSource: (c) => c.probeSource("prb_1"),
  resolve: (c) => c.resolve("cfl_1", { move: "refine", changeId: "chg_1" }, LEASE),
  why: (c) => c.why({ subject: "authz.permissions" }),
  Memory_listDecisions: (c) => c.decisions({ subject: "authz.permissions" }),
  Memory_getDecision: (c) => c.decision("dec_1"),
  Lattices_listLattices: (c) => c.lattices(),
  Views_getTrunk: (c) => c.trunk("prj_1"),
  Views_getVerdict: (c) => c.verdict("vrd_1"),
  Views_getCandidate: (c) => c.candidate("cnd_1"),
  Views_listLanes: (c) => c.lanes("prj_1", { limit: 2 }),
  Repo_getTree: (c) => c.tree("prj_1"),
  Repo_getBlob: (c) => c.blob("prj_1", "README.md"),
  Repo_listCommits: (c) => c.commits("prj_1"),
  Repo_getCommit: (c) => c.commit("prj_1", SAMPLE["sha"] ?? ""),
  Operator_createProject: (c) =>
    c.createProject({ org: "keel", name: "p", source: "keel-core/fixture" }),
  Operator_listProjects: (c) => c.projects({ limit: 3 }),
  Orgs_getProject: (c) => c.project("keel", "forge-lite"),
  Users_me: (c) => c.me(),
  Operator_getSettings: (c) => c.settings("prj_1"),
  Operator_putSettings: (c) => c.putSettings("prj_1", { protectedPaths: [], maxBatchSize: 1 }),
  Operator_enrolAgent: (c) =>
    c.enrolAgent({ name: "a1", projectId: "prj_1", kind: "hosted", scopes: ["agent:work"] }),
  Operator_suspendAgent: (c) => c.suspendAgent("agt_1", { reason: "r" }),
  Operator_reinstateAgent: (c) => c.reinstateAgent("agt_1"),
  Operator_revokeAgent: (c) => c.revokeAgent("agt_1"),
  Operator_listEscalations: (c) => c.escalations({ state: "open" }),
  Operator_giveRuling: (c) => c.giveRuling("esc_1", { option: "opt_1" }),
};

const isRouted = (operation: string): operation is RoutedOperation => operation in ROUTES;

/** The routed operations whose route names query parameters. */
type QueriedOperation = {
  [Op in RoutedOperation]: (typeof ROUTES)[Op] extends { readonly query: readonly string[] }
    ? Op
    : never;
}[RoutedOperation];

/**
 * One call for each operation with query parameters, passing every one of
 * them. Typed over every such operation, so a route that names a query and
 * has no call here fails to compile, and [sdk.query] then checks the method
 * puts each parameter on the URL.
 */
const QUERY: Readonly<Record<QueriedOperation, (client: KeelClient) => Promise<unknown>>> = {
  status: (c) => c.status("chg_1", { wait: 1 }),
  inbox: (c) => c.inbox({ cursor: "c1", wait: 1 }),
  Inbox_listEvents: (c) => c.events({ cursor: "c1", project: "prj_1", wait: 1, limit: 5 }),
  Repo_getTree: (c) => c.tree("prj_1", { ref: "main", path: "src" }),
  Repo_getBlob: (c) => c.blob("prj_1", "README.md", { ref: "main" }),
  Repo_listCommits: (c) => c.commits("prj_1", { ref: "main", cursor: "c1", limit: 5 }),
  Changes_listChanges: (c) =>
    c.changes({ state: "working", project: "prj_1", cursor: "c1", limit: 5 }),
  Conflicts_listConflicts: (c) =>
    c.conflicts({
      project: "prj_1",
      open: false,
      changeId: "chg_1",
      state: "proven",
      cursor: "c1",
      limit: 5,
    }),
  Conflicts_getConflict: (c) => c.conflict("cfl_1", { project: "prj_1" }),
  Probes_getProbeSource: (c) => c.probeSource("prb_1", { project: "prj_1" }),
  why: (c) => c.why({ path: "src/a.ts", line: 3, subject: "authz.permissions" }),
  Memory_listDecisions: (c) =>
    c.decisions({ subject: "authz.permissions", cursor: "c1", limit: 5 }),
  Inbox_getSnapshot: (c) => c.snapshot({ project: "prj_1" }),
  Views_listLanes: (c) => c.lanes("prj_1", { cursor: "c1", limit: 5 }),
  Operator_listProjects: (c) => c.projects({ cursor: "c1", limit: 5 }),
  Operator_listEscalations: (c) => c.escalations({ state: "open", cursor: "c1", limit: 5 }),
};

const isQueried = (operation: string): operation is QueriedOperation => operation in QUERY;

/** The one request a call made, past the token exchange. */
async function sentBy(operation: RoutedOperation) {
  const keel = fakeKeel(() => Response.json({}));
  await INVOKE[operation](keel.client);
  const calls = keel.sent.filter((s) => !s.url.endsWith("/v1/oauth/token"));
  expect(calls).toHaveLength(1);
  const [request] = calls;
  if (request === undefined) throw new Error(`${operation} sent nothing`);
  return request;
}

describe("the client's methods", () => {
  it.each(Object.keys(INVOKE).filter(isRouted))(
    "[sdk.methods] %s has a method that reaches its route",
    async (operation) => {
      const route = ROUTES[operation];
      const request = await sentBy(operation);
      const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => SAMPLE[name] ?? name);
      expect(request.method).toBe(route.method);
      expect(new URL(request.url).pathname).toBe(`/v1${path}`);
      for (const header of "headers" in route ? route.headers : [])
        expect(Object.keys(request.headers)).toContain(header);
    },
  );

  it.each(Object.keys(QUERY).filter(isQueried))(
    "[sdk.query] %s puts every query parameter its route names on the URL",
    async (operation) => {
      const keel = fakeKeel(() => Response.json({}));
      await QUERY[operation](keel.client);
      const request = keel.sent.find((s) => !s.url.endsWith("/v1/oauth/token"));
      const sent = [...new URL(request?.url ?? "http://keel.invalid").searchParams.keys()];
      expect(sent.toSorted()).toEqual([...ROUTES[operation].query].toSorted());
    },
  );

  it("[sdk.allowed-signers] reads the signers file as text from the site's root, with no credential", async () => {
    const file = 'keel@keel.test namespaces="git" ssh-ed25519 AAAA\n';
    const keel = fakeKeel(() => new Response(file));
    expect(await keel.client.allowedSigners()).toBe(file);
    expect(keel.sent.map((s) => [s.method, s.url, s.headers["authorization"]])).toEqual([
      ["GET", "https://keel.test/.well-known/keel/allowed-signers", undefined],
    ]);
    const down = fakeKeel(() =>
      Response.json({ code: "internal.defect", title: "Defect", status: 500 }, { status: 500 }),
    );
    await expect(down.client.allowedSigners()).rejects.toMatchObject({ status: 500 });
  });

  it("[sdk.rebase] rebases under the lease and key given, with nothing in the body", async () => {
    const keel = fakeKeel(() => Response.json({}));
    await keel.client.rebase("chg_1", { lease: "lse_9", idempotencyKey: "key-rebase" });
    const [request] = keel.sent.filter((s) => !s.url.endsWith("/v1/oauth/token"));
    expect(request?.headers).toMatchObject({
      "keel-lease": "lse_9",
      "idempotency-key": "key-rebase",
    });
    expect(JSON.parse(request?.body ?? "null")).toEqual({});
  });

  it("[sdk.adopt] adopts under the key given, with nothing in the body and no lease", async () => {
    const keel = fakeKeel(() => Response.json({}));
    await keel.client.adopt("chg_1", { idempotencyKey: "key-adopt" });
    const [request] = keel.sent.filter((s) => !s.url.endsWith("/v1/oauth/token"));
    expect(request?.headers["idempotency-key"]).toBe("key-adopt");
    expect(request?.headers).not.toHaveProperty("keel-lease");
    expect(JSON.parse(request?.body ?? "null")).toEqual({});
  });

  it("[sdk.revise] sends the revision read as a strong ETag in If-Match, beside the lease", async () => {
    const keel = fakeKeel(() => Response.json({}));
    await keel.client.revise("chg_1", { goal: "g2" }, { lease: "lse_9", ifMatch: 4 });
    const [request] = keel.sent.filter((s) => !s.url.endsWith("/v1/oauth/token"));
    expect(request?.headers).toMatchObject({ "if-match": '"4"', "keel-lease": "lse_9" });
    expect(JSON.parse(request?.body ?? "null")).toEqual({ goal: "g2" });
  });

  it("[sdk.session] opens a session with the body and key given", async () => {
    const keel = fakeKeel(() => Response.json({}));
    await keel.client.openSession({ harness: "h", model: "m" }, { idempotencyKey: "key-session" });
    const [request] = keel.sent.filter((s) => !s.url.endsWith("/v1/oauth/token"));
    expect(request?.headers["idempotency-key"]).toBe("key-session");
    expect(JSON.parse(request?.body ?? "null")).toEqual({ harness: "h", model: "m" });
  });
});
