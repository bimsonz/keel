// Authority families: owner < admin < maintainer < member < authenticated < anyone.
import { b, type Block, type Family } from "./types.ts";

const ALL = ["owner", "admin", "maintainer", "member", "authenticated", "anyone"];

// ---------- TypeScript: Hono route guards ----------
function tsGuard(v: string): string[] {
  switch (v) {
    case "owner": case "admin": case "maintainer":
      return [`  requireRole(c, repo, "${v}");`];
    case "member":
      return [`  requireOrgMembership(c, repo.orgId);`];
    case "authenticated":
      return [`  requireUser(c);`];
    case "anyone":
      return [];
  }
  throw new Error(v);
}

function tsRoute(method: string, path: string, action: string, v: string, trap?: string): Block {
  const guard = trap === "auth-first" ? ["  requireUser(c);", ...tsGuard(v)] : tsGuard(v);
  return b([
    `repos.${method}("${path}", async (c) => {`,
    `  const repo = await loadRepo(c);`,
    ...guard,
    `  await c.var.repos.${action}(repo.id);`,
    `  return c.body(null, 204);`,
    `});`,
  ].join("\n"), [`${method.toUpperCase()} ${path}`, "route"]);
}

const auTs: Family = {
  id: "au-ts",
  predicate: "authority",
  language: "typescript",
  subject: "repo.archive",
  scope: "api:v1",
  anchor: "POST /repos/:owner/:name/archive",
  values: ALL,
  sibValues: ALL,
  baseline: "authenticated",
  mech: {
    owner: "the archive route calls requireRole(c, repo, \"owner\")",
    admin: "the archive route calls requireRole(c, repo, \"admin\"), which admits admins and above",
    maintainer: "the archive route calls requireRole(c, repo, \"maintainer\"), which admits maintainers and above",
    member: "the archive route calls requireOrgMembership(c, repo.orgId), which admits any org member",
    authenticated: "the archive route calls only requireUser(c)",
    anyone: "the archive route has no guard at all",
  },
  traps: [
    {
      name: "auth-first", value: "owner", premise: "owner",
      before: { s: "owner", sib: "authenticated" }, after: { s: "owner", sib: "authenticated", trap: "auth-first" },
      why: "A requireUser(c) call is added in front, but requireRole(c, repo, \"owner\") still follows it: owner only.",
    },
  ],
  render({ s, sib, trap }) {
    return [{
      path: "src/routes/repos.ts",
      blocks: [
        b(`import { Hono } from "hono";\nimport { loadRepo, requireOrgMembership, requireRole, requireUser } from "../auth/guards.ts";\n\nexport const repos = new Hono<AppEnv>();`),
        tsRoute("post", "/repos/:owner/:name/archive", "archive", s, trap),
        tsRoute("put", "/repos/:owner/:name/star", "star", sib),
      ],
    }];
  },
};

// ---------- Python: DRF permission classes ----------
const PY_PERM: Record<string, string> = {
  owner: "[IsAuthenticated, IsOrgOwner]",
  admin: "[IsAuthenticated, IsOrgAdmin]",
  maintainer: "[IsAuthenticated, IsOrgMaintainer]",
  member: "[IsAuthenticated, IsOrgMember]",
  authenticated: "[IsAuthenticated]",
  anyone: "[AllowAny]",
};

const auPy: Family = {
  id: "au-py",
  predicate: "authority",
  language: "python",
  subject: "org.billing-settings.update",
  scope: "service:orgs",
  anchor: "BillingSettingsView.permission_classes",
  values: ALL,
  sibValues: ALL,
  baseline: "member",
  mech: {
    owner: "permission_classes is [IsAuthenticated, IsOrgOwner]",
    admin: "permission_classes is [IsAuthenticated, IsOrgAdmin] (IsOrgAdmin admits owners too)",
    maintainer: "permission_classes is [IsAuthenticated, IsOrgMaintainer] (admits maintainers and above)",
    member: "permission_classes is [IsAuthenticated, IsOrgMember]",
    authenticated: "permission_classes is [IsAuthenticated] only",
    anyone: "permission_classes is [AllowAny]",
  },
  traps: [
    {
      name: "moved-to-get-permissions", value: "admin", premise: "admin",
      before: { s: "admin", sib: "member" }, after: { s: "admin", sib: "member", trap: "moved-to-get-permissions" },
      why: "permission_classes is replaced by get_permissions(), which returns IsAuthenticated and IsOrgAdmin for writes and IsOrgMember only for safe methods; the update path still needs admin.",
    },
  ],
  render({ s, sib, trap }) {
    const view = (cls: string, v: string, extra: string) => {
      const lines = [`class ${cls}(OrgScopedView):`];
      if (trap === "moved-to-get-permissions" && cls === "BillingSettingsView") {
        lines.push(
          "    def get_permissions(self):",
          "        if self.request.method in SAFE_METHODS:",
          "            return [IsAuthenticated(), IsOrgMember()]",
          "        return [IsAuthenticated(), IsOrgAdmin()]",
        );
      } else {
        lines.push(`    permission_classes = ${PY_PERM[v]}`);
      }
      lines.push("", `    def ${extra}(self, request, org_slug):`, `        return self.${extra}_for(self.get_org(org_slug), request)`);
      return b(lines.join("\n"), [cls, "class"]);
    };
    return [{
      path: "orgs/views.py",
      blocks: [
        b("from rest_framework.permissions import SAFE_METHODS, AllowAny, IsAuthenticated\n\nfrom orgs.base import OrgScopedView\nfrom orgs.permissions import IsOrgAdmin, IsOrgMaintainer, IsOrgMember, IsOrgOwner"),
        view("BillingSettingsView", s, "put"),
        view("MemberDirectoryView", sib, "get"),
      ],
    }];
  },
};

// ---------- Go: rule methods ----------
function goRule(name: string, v: string): Block {
  const body =
    v === "anyone" ? "    return true"
    : v === "authenticated" ? "    return p.Authenticated()"
    : `    return p.Role.AtLeast(Role${v[0].toUpperCase()}${v.slice(1)})`;
  return b([`func (r *Rules) ${name}(p Principal, repo Repo) bool {`, body, "}"].join("\n"), [`Rules.${name}`, "method"]);
}

const auGo: Family = {
  id: "au-go",
  predicate: "authority",
  language: "go",
  subject: "branch.protection-update",
  scope: "service:git",
  anchor: "Rules.CanEditProtection",
  values: ALL,
  sibValues: ALL,
  baseline: "member",
  mech: Object.fromEntries(ALL.map((v) => [v, v === "anyone" ? "CanEditProtection returns true" : v === "authenticated" ? "CanEditProtection returns p.Authenticated()" : `CanEditProtection returns p.Role.AtLeast(Role${v[0].toUpperCase()}${v.slice(1)})`])),
  render({ s, sib }) {
    return [{
      path: "internal/protect/rules.go",
      blocks: [b("package protect"), goRule("CanEditProtection", s), goRule("CanListBranches", sib)],
    }];
  },
};

// ---------- HCL: bucket IAM ----------
const HCL_MEMBER: Record<string, string> = {
  owner: `"user:\${var.repo_owner_email}"`,
  admin: `"group:\${var.org_admins_group}"`,
  maintainer: `"group:\${var.release_maintainers_group}"`,
  member: `"group:\${var.org_members_group}"`,
  authenticated: `"allAuthenticatedUsers"`,
  anyone: `"allUsers"`,
};

const binding = (name: string, role: string, v: string) =>
  b([
    `resource "google_storage_bucket_iam_member" "${name}" {`,
    "  bucket = google_storage_bucket.releases.name",
    `  role   = "${role}"`,
    `  member = ${HCL_MEMBER[v]}`,
    "}",
  ].join("\n"), [`google_storage_bucket_iam_member.${name}`, "resource"]);

const auHcl: Family = {
  id: "au-hcl",
  predicate: "authority",
  language: "hcl",
  subject: "storage.release-artifacts.write",
  scope: "infra:gcp",
  anchor: "google_storage_bucket_iam_member.release_write",
  values: ALL,
  sibValues: ALL,
  baseline: "member",
  mech: Object.fromEntries(ALL.map((v) => [v, `roles/storage.objectCreator on the release bucket is granted to ${HCL_MEMBER[v].replaceAll('"', "")}`])),
  render({ s, sib }) {
    return [{
      path: "infra/storage.tf",
      blocks: [binding("release_write", "roles/storage.objectCreator", s), binding("release_read", "roles/storage.objectViewer", sib)],
    }];
  },
};

export const AUTHORITY: Family[] = [auTs, auPy, auGo, auHcl];
