/**
 * An Artifacts binding in memory, for the token rules and the import's
 * answers only: repos, their tokens and their state, and what an import was
 * asked for. Reads and git content are the live tests' job.
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

export class FakeArtifacts implements Artifacts {
  readonly repos = new Map<string, FakeToken[]>();
  /** Every import asked for, as the binding was handed it. */
  readonly imports: ImportParams[] = [];
  /** What the next import throws in place of importing. */
  refusal: Error | undefined;
  private minted = 0;

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
    const tokens = () => this.repos.get(name) ?? [];
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
      readBlob: () => unfaked("readBlob"),
      readTree: () => unfaked("readTree"),
      readCommit: () => unfaked("readCommit"),
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
