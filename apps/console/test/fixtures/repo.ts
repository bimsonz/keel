// The demo repository the scripted scenarios are about: the files it starts
// with, and what each change puts on trunk when it lands. A test fixture: the
// built console reads Keel's repository, or says Keel does not serve one yet.

import { CACHE_AFTER, CHECK_AFTER, CHECK_BEFORE } from "./s1.ts";

/** One file a landing changes. `after: null` deletes it. */
export interface LandedFile {
  path: string;
  after: string | null;
}

/** What a change puts on trunk when it lands, and the lines it leaves that anchor a subject. */
export interface Landing {
  files: LandedFile[];
  anchors: { path: string; line: number; subject: string }[];
}

const README = `# demo

![build: passing](https://img.example.invalid/build.svg)

A small service with repositories, collaborators and permissions. It is the
codebase the Keel scenarios change. How to [run it](#run) is below.

## Layout

- \`src/authz\`: who may do what. \`requirePermission\` is the one way in.
- \`src/collaborators\`: adding and removing the people on a repository.
- [\`src/http.ts\`](src/http.ts): the request, the session and the routes' plumbing.

## Run

\`\`\`sh
pnpm install
pnpm test
\`\`\`

Every request passes through \`requirePermission\`. What it promises about how
fresh a permission is, other code relies on.

<script>window.readmeRan = "a script"</script>

<img src="https://img.example.invalid/pixel.png" onerror="window.readmeRan = 'an image'">
`;

const PACKAGE = `{
  "name": "demo",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "7.0.2",
    "vitest": "5.0.3"
  }
}
`;

const HTTP = `export interface Session {
  readonly id: string;
  readonly userId: string;
}

export interface Request {
  readonly user: { readonly id: string };
  readonly repo: { readonly id: string };
  readonly session: Session;
  readonly params: Readonly<Record<string, string>>;
}

export type Handler = (req: Request) => Promise<Response>;
`;

const ACTIONS = `export type Action = "read" | "write" | "admin";

export class Forbidden extends Error {
  constructor(readonly action: Action) {
    super(\`not allowed: \${action}\`);
  }
}
`;

const ROLES = `import type { Action } from "./actions.ts";

export interface Role {
  readonly name: string;
  allows(action: Action): boolean;
}

/** A user's roles on one repository, read from the store on every call. */
export async function loadRoles(userId: string, repoId: string): Promise<Role[]> {
  const rows = await store.roles.where({ userId, repoId });
  return rows.map((row) => roleNamed(row.role));
}

declare const store: { roles: { where(match: object): Promise<{ role: string }[]> } };
declare function roleNamed(name: string): Role;
`;

const ROUTES_BEFORE = `import { requirePermission } from "../authz/check.ts";
import type { Handler } from "../http.ts";

export const listCollaborators: Handler = async (req) => {
  await requirePermission(req, "read");
  return Response.json(await collaborators.of(req.repo.id));
};

export const routes = { "GET /repos/:repo/collaborators": listCollaborators };

declare const collaborators: { of(repoId: string): Promise<string[]> };
`;

const ROUTES_AFTER = `import { requirePermission } from "../authz/check.ts";
import type { Handler } from "../http.ts";
import { revokeCollaborator } from "./revoke.ts";

export const listCollaborators: Handler = async (req) => {
  await requirePermission(req, "read");
  return Response.json(await collaborators.of(req.repo.id));
};

export const routes = {
  "GET /repos/:repo/collaborators": listCollaborators,
  "DELETE /repos/:repo/collaborators/:user": revokeCollaborator,
};

declare const collaborators: { of(repoId: string): Promise<string[]> };
`;

const REVOKE = `import { requirePermission } from "../authz/check.ts";
import type { Handler } from "../http.ts";

/** An owner removes a collaborator. The next request that collaborator makes is refused. */
export const revokeCollaborator: Handler = async (req) => {
  await requirePermission(req, "admin");
  await store.roles.remove({ userId: req.params.user, repoId: req.repo.id });
  return new Response(null, { status: 204 });
};

declare const store: { roles: { remove(match: object): Promise<void> } };
`;

const REVOKE_INVALIDATING = `import { permissionCache } from "../authz/cache.ts";
import { requirePermission } from "../authz/check.ts";
import type { Handler } from "../http.ts";

/** An owner removes a collaborator. The next request that collaborator makes is refused. */
export const revokeCollaborator: Handler = async (req) => {
  await requirePermission(req, "admin");
  await store.roles.remove({ userId: req.params.user, repoId: req.repo.id });
  // The cache keeps roles for a session: drop this user's, or they would outlive the revocation.
  permissionCache.invalidate(req.params.user ?? "", req.repo.id);
  return new Response(null, { status: 204 });
};

declare const store: { roles: { remove(match: object): Promise<void> } };
`;

const CACHE_INVALIDATING = `import { loadRoles, type Role } from "./roles.ts";
import type { Session } from "../http.ts";

/** Roles per session and repository. Filled on first use, and dropped the moment a collaborator is revoked. */
class PermissionCache {
  readonly #bySession = new Map<Session, Map<string, Role[]>>();

  async rolesFor(session: Session, repoId: string): Promise<Role[]> {
    let repos = this.#bySession.get(session);
    if (repos === undefined) {
      repos = new Map();
      this.#bySession.set(session, repos);
    }
    let roles = repos.get(repoId);
    if (roles === undefined) {
      roles = await loadRoles(session.userId, repoId);
      repos.set(repoId, roles);
    }
    return roles;
  }

  /** Forget what every session of this user holds for the repository. */
  invalidate(userId: string, repoId: string): void {
    for (const [session, repos] of this.#bySession) {
      if (session.userId === userId) repos.delete(repoId);
    }
  }
}

export const permissionCache = new PermissionCache();
`;

const SUBJECT = "authz.permission-evaluation";

/** What trunk holds before either change lands. */
export const BASE_FILES: LandedFile[] = [
  { path: "README.md", after: README },
  { path: "package.json", after: PACKAGE },
  { path: "src/authz/actions.ts", after: ACTIONS },
  { path: "src/authz/check.ts", after: CHECK_BEFORE },
  { path: "src/authz/roles.ts", after: ROLES },
  { path: "src/collaborators/routes.ts", after: ROUTES_BEFORE },
  { path: "src/http.ts", after: HTTP },
];

/** The lines of the starting tree that anchor a subject. */
export const BASE_ANCHORS: Landing["anchors"] = [
  { path: "src/authz/check.ts", line: 5, subject: SUBJECT },
];

/** A: owners can revoke collaborators. */
export const LANDED_A: Landing = {
  files: [
    { path: "src/collaborators/revoke.ts", after: REVOKE },
    { path: "src/collaborators/routes.ts", after: ROUTES_AFTER },
  ],
  anchors: [{ path: "src/collaborators/revoke.ts", line: 5, subject: "collab.revocation" }],
};

/** B as it was first written: roles cached for the session, and never dropped. */
export const LANDED_B_AS_WRITTEN: Landing = {
  files: [
    { path: "src/authz/cache.ts", after: CACHE_AFTER },
    { path: "src/authz/check.ts", after: CHECK_AFTER },
  ],
  anchors: [{ path: "src/authz/cache.ts", line: 5, subject: SUBJECT }],
};

/** B as revised after the ruling: the cache is dropped on revocation. */
export const LANDED_B_INVALIDATING: Landing = {
  files: [
    { path: "src/authz/cache.ts", after: CACHE_INVALIDATING },
    { path: "src/authz/check.ts", after: CHECK_AFTER },
    { path: "src/collaborators/revoke.ts", after: REVOKE_INVALIDATING },
  ],
  anchors: [
    { path: "src/authz/cache.ts", line: 5, subject: SUBJECT },
    { path: "src/collaborators/revoke.ts", line: 11, subject: SUBJECT },
  ],
};
