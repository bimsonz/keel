/**
 * An Artifacts binding in memory, for the token rules only: repos, their
 * tokens and their state. Reads and git content are the live tests' job.
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

export class FakeArtifacts implements Artifacts {
  readonly repos = new Map<string, FakeToken[]>();
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
      remote: `https://fake.invalid/git/ns/${name}.git`,
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
      info: () => unfaked("info"),
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

  import(): Promise<ArtifactsCreateRepoResult> {
    return unfaked("import");
  }

  list(): Promise<ArtifactsRepoListResult> {
    return unfaked("list");
  }
}
