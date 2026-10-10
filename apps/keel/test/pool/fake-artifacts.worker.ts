import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

/**
 * An Artifacts namespace in memory, bound over WORKSPACES in the pool tests
 * (vitest.config.ts strips its types and serves it as an auxiliary Worker).
 * Every call crosses RPC as it does on the edge: `get` answers an RpcTarget
 * repo handle, and errors arrive with their message only, so the adapter's
 * "Repository not found" recognition is exercised. A repo is its head and its
 * tokens; it holds no git content, so reads other than the head's commit
 * throw. State lives for the life of the auxiliary Worker: tests use fresh
 * names, as the pool does.
 */
interface FakeToken {
  readonly id: string;
  readonly plaintext: string;
  readonly scope: "read" | "write";
  readonly expiresAt: string;
  state: "active" | "revoked";
}

interface FakeRepo {
  readonly name: string;
  readonly head: string;
  readonly createdAt: string;
  readonly tokens: FakeToken[];
}

const repos = new Map<string, FakeRepo>();
let minted = 0;

const notFound = (name: string) => new Error(`Repository not found: ${name}.`);
const unfaked = (what: string) => new Error(`the fake Artifacts namespace does not do ${what}`);

function mint(repo: FakeRepo, scope: "read" | "write", ttlSeconds: number): FakeToken {
  minted += 1;
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token: FakeToken = {
    id: `tok-${minted}`,
    plaintext: `art_v2_x_fake${minted}?expires=${expires}`,
    scope,
    expiresAt: new Date(expires * 1000).toISOString(),
    state: "active",
  };
  repo.tokens.push(token);
  return token;
}

/** A new repo at `head`, with the day-long write token create() and fork() hand out. */
function open(name: string, head: string): ArtifactsCreateRepoResult {
  if (repos.has(name)) throw new Error(`Repository already exists: ${name}.`);
  const repo: FakeRepo = { name, head, createdAt: new Date().toISOString(), tokens: [] };
  repos.set(name, repo);
  return {
    id: name,
    name,
    description: null,
    defaultBranch: "main",
    remote: remoteOf(name),
    token: mint(repo, "write", 86_400).plaintext,
  };
}

/** A commit id derived from the repo's name, so each created repo has its own head. */
async function headFor(name: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(name));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const remoteOf = (name: string) => `https://fake.invalid/git/keel-ws-00/${name}.git`;

function listed(repo: FakeRepo): Omit<ArtifactsRepoInfo, "remote"> {
  return {
    id: repo.name,
    name: repo.name,
    description: null,
    defaultBranch: "main",
    createdAt: repo.createdAt,
    updatedAt: repo.createdAt,
    lastPushAt: null,
    source: null,
    readOnly: false,
  };
}

class FakeRepoHandle extends RpcTarget implements ArtifactsRepo {
  readonly #name: string;

  constructor(name: string) {
    super();
    this.#name = name;
  }

  #repo(): FakeRepo {
    const repo = repos.get(this.#name);
    if (repo === undefined) throw notFound(this.#name);
    return repo;
  }

  async createToken(scope: "read" | "write" = "write", ttl = 86_400) {
    const token = mint(this.#repo(), scope, ttl);
    return { id: token.id, plaintext: token.plaintext, scope, expiresAt: token.expiresAt };
  }

  async listTokens() {
    const tokens = this.#repo().tokens.map((t) => ({
      id: t.id,
      scope: t.scope,
      state: t.state,
      createdAt: "",
      expiresAt: t.expiresAt,
    }));
    return { tokens, total: tokens.length };
  }

  async revokeToken(tokenOrId: string) {
    const token = this.#repo().tokens.find((t) => t.plaintext === tokenOrId || t.id === tokenOrId);
    if (token !== undefined) token.state = "revoked";
    return token !== undefined;
  }

  async info() {
    const repo = this.#repo();
    return { ...listed(repo), remote: remoteOf(repo.name) };
  }

  async log(opts: { ref?: string; limit?: number } = {}): Promise<ArtifactsCommitMetadata[]> {
    const repo = this.#repo();
    return opts.ref === "main" || opts.ref === undefined ? [this.#commit(repo)] : [];
  }

  async readCommit(hash: string) {
    const repo = this.#repo();
    return hash === repo.head ? this.#commit(repo) : null;
  }

  async fork(name: string) {
    return open(name, this.#repo().head);
  }

  readBlob(): Promise<Blob | null> {
    return Promise.reject(unfaked("readBlob"));
  }

  readTree(): Promise<ArtifactsTreeEntry[] | null> {
    return Promise.reject(unfaked("readTree"));
  }

  readFile(): Promise<Blob | null> {
    return Promise.reject(unfaked("readFile"));
  }

  #commit(repo: FakeRepo): ArtifactsCommitMetadata {
    const who = { name: "Keel", email: "keel@keel.invalid" };
    return {
      hash: repo.head,
      treeHash: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      message: "seed\n",
      author: who,
      committer: who,
      parents: [],
      authoredAt: 0,
      committedAt: 0,
    };
  }

  [Symbol.dispose]() {}
}

export default class FakeArtifacts extends WorkerEntrypoint {
  async create(name: string) {
    return open(name, await headFor(name));
  }

  async get(name: string) {
    if (!repos.has(name)) throw notFound(name);
    return new FakeRepoHandle(name);
  }

  async delete(name: string) {
    return repos.delete(name);
  }

  async list() {
    const all = [...repos.values()].map(listed);
    return { repos: all, total: all.length };
  }
}
