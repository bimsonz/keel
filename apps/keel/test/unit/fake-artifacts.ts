/**
 * An Artifacts binding in memory, for the token rules, the import's answers
 * and reads by id: repos, their tokens and their state, what an import was
 * asked for, the objects a test chose for a repo under the ids it chose, and
 * each handle opened and object read. Git content itself is the live tests' job.
 */
interface FakeToken {
  readonly id: string;
  readonly plaintext: string;
  readonly scope: "read" | "write";
  state: "active" | "revoked";
}

class NotFound extends Error {
  readonly code = "NOT_FOUND";
}

const unfaked = (what: string) =>
  Promise.reject(new Error(`the fake Artifacts binding does not do ${what}`));

/** The remote the fake gives a repo: what a test's `fetch` is asked for its refs at. */
export const fakeRemote = (name: string) => `https://fake.invalid/git/ns/${name}.git`;

type ImportParams = Parameters<Artifacts["import"]>[0];

/** The objects a repo serves, each under the id a test chose: none it is not given. */
export interface FakeObjects {
  /** Each commit's root tree. */
  readonly commits?: Readonly<Record<string, string>>;
  readonly trees?: Readonly<Record<string, readonly ArtifactsTreeEntry[]>>;
  /** Each blob's content, as text. */
  readonly blobs?: Readonly<Record<string, string>>;
}

/** One object read through a handle. */
export interface FakeRead {
  readonly kind: "commit" | "tree" | "blob";
  readonly repo: string;
  readonly oid: string;
}

export class FakeArtifacts implements Artifacts {
  readonly repos = new Map<string, FakeToken[]>();
  /** Every import asked for, as the binding was handed it. */
  readonly imports: ImportParams[] = [];
  /** What the next import throws in place of importing. */
  refusal: Error | undefined;
  /** The repo of every handle `get()` opened, in order. */
  readonly opened: string[] = [];
  /** Every object read through a handle, in order, found or not. */
  readonly reads: FakeRead[] = [];
  /** Blob ids whose reads answer a little after the others, so reads made together finish out of the order asked. */
  readonly slow = new Set<string>();
  private readonly objects = new Map<string, FakeObjects>();
  private minted = 0;

  /** Makes `name` a repo that serves `objects`. */
  serve(name: string, objects: FakeObjects): void {
    if (!this.repos.has(name)) this.repos.set(name, []);
    this.objects.set(name, objects);
  }

  private mint(name: string, scope: "read" | "write"): FakeToken {
    this.minted += 1;
    const token: FakeToken = {
      id: `tok-${this.minted}`,
      plaintext: `art_v2_x_fake${this.minted}?expires=1999999999`,
      scope,
      state: "active",
    };
    this.repos.get(name)?.push(token);
    return token;
  }

  /** What create() and fork() return: the repo plus an initial write token. */
  private created(name: string): ArtifactsCreateRepoResult {
    this.repos.set(name, []);
    const token = this.mint(name, "write");
    return {
      id: name,
      name,
      description: null,
      defaultBranch: "main",
      remote: fakeRemote(name),
      token: token.plaintext,
    };
  }

  create(name: string): Promise<ArtifactsCreateRepoResult> {
    return Promise.resolve(this.created(name));
  }

  get(name: string): Promise<ArtifactsRepo> {
    if (!this.repos.has(name))
      return Promise.reject(new NotFound(`Repository not found: ${name}.`));
    this.opened.push(name);
    const tokens = () => this.repos.get(name) ?? [];
    const served = () => this.objects.get(name) ?? {};
    const read = (kind: FakeRead["kind"], oid: string) =>
      this.reads.push({ kind, repo: name, oid });
    const repo: ArtifactsRepo = {
      createToken: (scope = "write") => {
        const t = this.mint(name, scope);
        return Promise.resolve({
          id: t.id,
          plaintext: t.plaintext,
          scope,
          expiresAt: "2099-01-01T00:00:00Z",
        });
      },
      listTokens: () =>
        Promise.resolve({
          tokens: tokens().map((t) => ({
            id: t.id,
            scope: t.scope,
            state: t.state,
            createdAt: "",
            expiresAt: "",
          })),
          total: tokens().length,
        }),
      revokeToken: (tokenOrId) => {
        const t = tokens().find((x) => x.plaintext === tokenOrId || x.id === tokenOrId);
        if (t !== undefined) t.state = "revoked";
        return Promise.resolve(t !== undefined);
      },
      fork: (target) => Promise.resolve(this.created(target)),
      info: () =>
        Promise.resolve({
          id: name,
          name,
          description: null,
          defaultBranch: "main",
          remote: fakeRemote(name),
          createdAt: "",
          updatedAt: "",
          lastPushAt: null,
          source: null,
          readOnly: false,
        }),
      readBlob: async (hash) => {
        read("blob", hash);
        if (this.slow.has(hash)) await new Promise((resolve) => setTimeout(resolve, 5));
        const text = served().blobs?.[hash];
        return text === undefined ? null : new Blob([text]);
      },
      readTree: (hash) => {
        read("tree", hash);
        const entries = served().trees?.[hash];
        return Promise.resolve(entries === undefined ? null : [...entries]);
      },
      readCommit: (hash) => {
        read("commit", hash);
        const tree = served().commits?.[hash];
        return Promise.resolve(
          tree === undefined
            ? null
            : {
                hash,
                treeHash: tree,
                message: "",
                author: { name: "Keel", email: "keel@keel.invalid" },
                committer: { name: "Keel", email: "keel@keel.invalid" },
                parents: [],
                authoredAt: 0,
                committedAt: 0,
              },
        );
      },
      readFile: () => unfaked("readFile"),
      log: () => unfaked("log"),
      [Symbol.dispose]: () => undefined,
    };
    return Promise.resolve(repo);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.repos.delete(name));
  }

  /** As the binding does: `main` is reported as the default branch whatever the upstream's is. */
  import(params: ImportParams): Promise<ArtifactsCreateRepoResult> {
    this.imports.push(params);
    const refusal = this.refusal;
    this.refusal = undefined;
    if (refusal !== undefined) return Promise.reject(refusal);
    if (this.repos.has(params.target.name))
      return Promise.reject(
        new Error(`ArtifactsError: repo already exists: ${params.target.name}`),
      );
    return Promise.resolve(this.created(params.target.name));
  }

  list(): Promise<ArtifactsRepoListResult> {
    return unfaked("list");
  }
}
