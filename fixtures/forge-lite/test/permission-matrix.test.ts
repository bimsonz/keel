import { describe, expect, it } from "vitest";
import { harness, problem, type Client } from "./support/harness.ts";

/**
 * Every subject against every guarded action on public and private
 * repositories, through the real routes.
 *
 * The expectations come from the oracle below, written out independently of
 * src/domain so a mistake in the permission table cannot agree with itself.
 */

type Subject = "anonymous" | "stranger" | "read" | "triage" | "write" | "maintain" | "admin" | "owner";
type Visibility = "public" | "private";
type Method = "GET" | "PUT" | "PATCH" | "POST" | "DELETE";

const LADDER = ["read", "triage", "write", "maintain", "admin", "owner"] as const;
type Rung = (typeof LADDER)[number];

interface Operation {
  readonly action: string;
  readonly minimum: Rung;
  readonly method: Method;
  /** Appended to /repos/olive/forge. */
  readonly path: string;
  readonly body?: unknown;
  readonly ok: number;
}

const OPERATIONS: readonly Operation[] = [
  { action: "read", minimum: "read", method: "GET", path: "", ok: 200 },
  {
    action: "manage-issues",
    minimum: "triage",
    method: "PUT",
    path: "/labels/bug",
    body: { color: "d73a4a" },
    ok: 201,
  },
  {
    action: "push",
    minimum: "write",
    method: "PUT",
    path: "/refs/heads/feature",
    body: { sha: "a".repeat(40) },
    ok: 201,
  },
  {
    action: "manage-settings",
    minimum: "maintain",
    method: "PATCH",
    path: "",
    body: { description: "Updated by the matrix" },
    ok: 200,
  },
  {
    action: "add-collaborator",
    minimum: "admin",
    method: "PUT",
    path: "/collaborators/newcomer",
    body: { role: "read" },
    ok: 201,
  },
  {
    action: "change-role",
    minimum: "admin",
    method: "PATCH",
    path: "/collaborators/target",
    body: { role: "triage" },
    ok: 200,
  },
  { action: "delete-repo", minimum: "admin", method: "DELETE", path: "", ok: 204 },
  {
    action: "transfer",
    minimum: "owner",
    method: "POST",
    path: "/transfer",
    body: { newOwner: "recipient" },
    ok: 200,
  },
];

const SUBJECTS: readonly Subject[] = ["anonymous", "stranger", "read", "triage", "write", "maintain", "admin", "owner"];
const VISIBILITIES: readonly Visibility[] = ["public", "private"];

const COLLABORATORS = [
  ["rhea", "read"],
  ["tia", "triage"],
  ["wes", "write"],
  ["mia", "maintain"],
  ["ada", "admin"],
] as const;

function expectedStatus(subject: Subject, operation: Operation, visibility: Visibility): number {
  const hasRole = subject !== "anonymous" && subject !== "stranger";
  // Without a role, a private repository is indistinguishable from a missing one.
  if (!hasRole && visibility === "private") return 404;
  if (operation.action === "read") return operation.ok;
  if (subject === "anonymous") return 401;
  if (subject === "stranger") return 403;
  return LADDER.indexOf(subject) >= LADDER.indexOf(operation.minimum) ? operation.ok : 403;
}

/** olive owns olive/forge; five collaborators hold one role each; sam has none. */
async function world(visibility: Visibility): Promise<Record<Subject, Client>> {
  const h = harness();
  const owner = await h.user("olive");
  await h.createRepo(owner, "forge", visibility);
  const clients: Partial<Record<Subject, Client>> = { anonymous: h.anonymous, owner };
  for (const [username, role] of COLLABORATORS) {
    clients[role] = await h.user(username);
    await h.addCollaborator(owner, "forge", username, role);
  }
  clients.stranger = await h.user("sam");
  await h.signUp("target");
  await h.addCollaborator(owner, "forge", "target", "read");
  await h.signUp("newcomer");
  await h.signUp("recipient");
  return clients as Record<Subject, Client>;
}

function send(client: Client, method: Method, path: string, body: unknown): Promise<Response> {
  switch (method) {
    case "GET":
      return client.get(path);
    case "PUT":
      return client.put(path, body);
    case "PATCH":
      return client.patch(path, body);
    case "POST":
      return client.post(path, body);
    case "DELETE":
      return client.delete(path);
  }
}

const CASES = SUBJECTS.flatMap((subject) =>
  OPERATIONS.flatMap((operation) =>
    VISIBILITIES.map((visibility) => ({
      subject,
      action: operation.action,
      visibility,
      operation,
      status: expectedStatus(subject, operation, visibility),
    })),
  ),
);

describe("permission matrix", () => {
  it.each(CASES.filter((c) => c.status < 400))(
    "$subject: $action on a $visibility repo answers $status",
    async ({ subject, visibility, operation, status }) => {
      const clients = await world(visibility);
      const res = await send(clients[subject], operation.method, `/repos/olive/forge${operation.path}`, operation.body);
      expect(res.status).toBe(status);
    },
  );

  it.each(CASES.filter((c) => c.status >= 400))(
    "$subject: $action on a $visibility repo answers $status and changes nothing",
    async ({ subject, visibility, operation, status }) => {
      const clients = await world(visibility);
      const before = await (await clients.owner.get("/repos/olive/forge")).text();
      const res = await send(clients[subject], operation.method, `/repos/olive/forge${operation.path}`, operation.body);
      expect((await problem(res, status)).status).toBe(status);
      const after = await clients.owner.get("/repos/olive/forge");
      expect(after.status).toBe(200);
      expect(await after.text()).toBe(before);
    },
  );
});
