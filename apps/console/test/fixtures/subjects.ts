// The demo codebase's subjects, by namespace, and the lanes its footprint is
// partitioned into. The swarm is built from these.

export type SeedState = "calm" | "suspected" | "proven" | "guarded";

export interface SubjectSeed {
  key: string;
  gloss: string;
  /** Relative share of the swarm's attention. */
  heat: number;
  state?: SeedState;
}

export const SUBJECTS: Record<string, SubjectSeed[]> = {
  authz: [
    {
      key: "authz.permission-evaluation",
      gloss: "How a request's permissions are decided",
      heat: 9,
      state: "guarded",
    },
    { key: "authz.session-lifetime", gloss: "How long a session stays valid", heat: 5 },
    { key: "authz.token-revocation", gloss: "When a revoked token stops working", heat: 4 },
    { key: "authz.role-inheritance", gloss: "How team roles reach a repository", heat: 3 },
  ],
  repo: [
    { key: "repo.visibility", gloss: "Who can see a repository", heat: 4 },
    {
      key: "repo.refs.ordering",
      gloss: "The order ref updates apply in",
      heat: 6,
      state: "guarded",
    },
    { key: "repo.pack.cache", gloss: "How long packfiles are reused", heat: 7 },
    { key: "repo.default-branch", gloss: "Which ref a clone checks out", heat: 2 },
  ],
  collab: [
    { key: "collab.invitations", gloss: "How an invitation becomes access", heat: 4 },
    { key: "collab.revocation", gloss: "How access is taken away", heat: 5 },
    { key: "collab.team-sync", gloss: "How teams follow the directory", heat: 2 },
  ],
  billing: [
    {
      key: "billing.quota.enforcement",
      gloss: "When a quota starts refusing work",
      heat: 6,
      state: "guarded",
    },
    { key: "billing.invoice.rounding", gloss: "How line items round", heat: 3 },
    { key: "billing.plan.limits", gloss: "What each plan allows", heat: 3 },
  ],
  search: [
    {
      key: "search.index.freshness",
      gloss: "How stale a search result may be",
      heat: 8,
      state: "suspected",
    },
    { key: "search.ranking", gloss: "What orders the results", heat: 5 },
    { key: "search.tokenizer", gloss: "How code is split into terms", heat: 2 },
  ],
  webhooks: [
    {
      key: "webhooks.delivery.ordering",
      gloss: "Whether deliveries keep event order",
      heat: 7,
      state: "suspected",
    },
    {
      key: "webhooks.retry.idempotency",
      gloss: "Whether a retry can act twice",
      heat: 5,
      state: "guarded",
    },
    { key: "webhooks.signing", gloss: "How a payload is signed", heat: 2 },
  ],
  api: [
    { key: "api.rate-limit.bound", gloss: "The most a client may send", heat: 6 },
    {
      key: "api.pagination.shape",
      gloss: "What a page of results looks like",
      heat: 7,
      state: "suspected",
    },
    { key: "api.error.shape", gloss: "What every error carries", heat: 4 },
  ],
  storage: [
    { key: "storage.blob.presence", gloss: "Whether a referenced blob exists", heat: 5 },
    {
      key: "storage.gc.safety",
      gloss: "What garbage collection may delete",
      heat: 8,
      state: "proven",
    },
    { key: "storage.lfs.quota", gloss: "How large files are counted", heat: 2 },
  ],
  ci: [
    { key: "ci.cache.scope", gloss: "Which runs may share a cache", heat: 6, state: "guarded" },
    { key: "ci.runner.isolation", gloss: "What a runner can reach", heat: 4 },
    { key: "ci.artifact.retention", gloss: "How long build output is kept", heat: 3 },
  ],
  audit: [
    {
      key: "audit.log.append-only",
      gloss: "Whether history can be rewritten",
      heat: 4,
      state: "guarded",
    },
    { key: "audit.export.shape", gloss: "What an export contains", heat: 2 },
  ],
  notif: [
    { key: "notif.digest.cardinality", gloss: "How many digests a person gets", heat: 5 },
    { key: "notif.email.dedupe", gloss: "Whether one event can email twice", heat: 3 },
  ],
  deploy: [
    { key: "deploy.preview.routing", gloss: "Which candidate a preview serves", heat: 4 },
    { key: "deploy.rollout.stages", gloss: "The steps of a gradual promotion", heat: 3 },
  ],
  fw: [
    {
      key: "fw.flash-size-budget",
      gloss: "How much flash the image may use",
      heat: 4,
      state: "guarded",
    },
    { key: "fw.boot.sequence", gloss: "The order start-up stages run in", heat: 2 },
  ],
};

export const LANES: { id: string; label: string; partition: string; namespaces: string[] }[] = [
  {
    id: "lane-1",
    label: "Lane 1",
    partition: "src/authz · src/collab · src/audit",
    namespaces: ["authz", "collab", "audit"],
  },
  {
    id: "lane-2",
    label: "Lane 2",
    partition: "src/repo · src/storage",
    namespaces: ["repo", "storage"],
  },
  {
    id: "lane-3",
    label: "Lane 3",
    partition: "src/billing · src/notif",
    namespaces: ["billing", "notif"],
  },
  {
    id: "lane-4",
    label: "Lane 4",
    partition: "src/search · src/api",
    namespaces: ["search", "api"],
  },
  {
    id: "lane-5",
    label: "Lane 5",
    partition: "src/webhooks · src/deploy",
    namespaces: ["webhooks", "deploy"],
  },
  { id: "lane-6", label: "Lane 6", partition: "src/ci · firmware/", namespaces: ["ci", "fw"] },
];
