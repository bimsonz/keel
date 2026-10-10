// The forge-lite S-1 pair and its variants. Diffs live in diffs/<id>.diff:
//   F01, F02, F03, F07 are the source hunks of the real patches in
//     fixtures/forge-lite/scenarios (test files left out), with the comments
//     that state the cache's lifetime removed (the leak check requires it);
//   F04, F05, F06, F08 are hand-written on the same code.
// Effects are derived by hand; labels are computed on the lattice and must
// match the label written here.
import type { ItemSpec } from "../s17/items.ts";

const SUBJECT = "authz.permission-evaluation";
const SCOPE = "service:forge-lite";

const F = (id: string, kind: ItemSpec["kind"], effect: string, label: ItemSpec["label"], reason: string, symbols: ItemSpec["symbols"], extra: Partial<ItemSpec>): ItemSpec => ({
  id, kind, subject: SUBJECT, predicate: "freshness", value: "per-request", scope: SCOPE, effect, label, reason, symbols, ...extra,
});

export const FORGE_ITEMS: ItemSpec[] = [
  F("F01", "core", "per-session", "contradiction",
    "Agent B (scenarios/s1/b.patch): requirePermission resolves collaborator roles through RoleCache, keyed by (session.id, repo.id) and never invalidated; a cached role that suffices is trusted for the rest of the session. per-session ranks above per-request.",
    [["RoleCache", "class", "src/authz/cache.ts", "added"], ["RoleCache.get", "method", "src/authz/cache.ts", "added"], ["RoleCache.set", "method", "src/authz/cache.ts", "added"], ["roleCacheFor", "function", "src/authz/cache.ts", "added"], ["requirePermission", "function", "src/authz/require-permission.ts", "modified"], ["callerRole", "function", "src/authz/require-permission.ts", "modified"]],
    { tags: ["forge-lite-S-1", "real-hunks"] }),
  F("F02", "core", "per-session", "contradiction",
    "The \"simplify\" change (scenarios/s2/careless.patch, on base+A+B+B'): removes the collaborator.removed subscription and evict(), so nothing invalidates the per-(session, repo) cache any more. per-session ranks above per-request.",
    [["RoleCache.get", "method", "src/authz/cache.ts", "modified"], ["RoleCache.set", "method", "src/authz/cache.ts", "modified"], ["RoleCache.evict", "method", "src/authz/cache.ts", "removed"], ["roleCacheFor", "function", "src/authz/cache.ts", "modified"], ["Entry", "interface", "src/authz/cache.ts", "removed"], ["key", "function", "src/authz/cache.ts", "removed"], ["callerRole", "function", "src/authz/require-permission.ts", "modified"]],
    { tags: ["forge-lite-S-2", "real-hunks"] }),
  F("F03", "decoy", "per-call", "compatible",
    "B' (scenarios/s1/b-revised.patch, on base+A+B): the cache subscribes to collaborator.removed and evicts the collaborator's entries in all sessions. Removal is the only write that lowers a role, and a cached role that falls short is looked up again, so every decision equals a fresh evaluation of the store: observable freshness is per-call, which is within per-request.",
    [["RoleCache.get", "method", "src/authz/cache.ts", "modified"], ["RoleCache.set", "method", "src/authz/cache.ts", "modified"], ["RoleCache.evict", "method", "src/authz/cache.ts", "added"], ["roleCacheFor", "function", "src/authz/cache.ts", "modified"], ["Entry", "interface", "src/authz/cache.ts", "added"], ["callerRole", "function", "src/authz/require-permission.ts", "modified"]],
    { decoyType: "same-subject-compatible", tags: ["forge-lite-S-1", "real-hunks", "invalidated-on-revoke"] }),
  F("F04", "core", "ttl", "contradiction",
    "Variant of B: roles are cached per (user, repo) with expiresAt = now + 60 s and no invalidation, so a revoked collaborator keeps access for up to a minute across requests and sessions. ttl ranks above per-request.",
    [["ENTRY_LIFETIME_MS", "const", "src/authz/cache.ts", "added"], ["RoleCache.get", "method", "src/authz/cache.ts", "added"], ["RoleCache.set", "method", "src/authz/cache.ts", "added"], ["roleCacheFor", "function", "src/authz/cache.ts", "added"], ["callerRole", "function", "src/authz/require-permission.ts", "modified"]],
    { tags: ["forge-lite-S-1", "ttl-cache"] }),
  F("F05", "decoy", "per-request", "compatible",
    "Variant of B: the role memo is a Map stored on the Hono context (c.set(\"roleMemo\")), which exists for one request only. per-request equals the premise bound.",
    [["AppVariables.roleMemo", "field", "src/http/env.ts", "added"], ["callerRole", "function", "src/authz/require-permission.ts", "modified"]],
    { decoyType: "same-subject-compatible", tags: ["forge-lite-S-1", "per-request-memo"] }),
  F("F06", "core", "per-session", "contradiction",
    "A second \"simplify\" on base+A+B+B': inlines key() and drops the collaborator.removed subscription, leaving evict() defined but never called. The per-(session, repo) cache is no longer invalidated: per-session ranks above per-request.",
    [["RoleCache.get", "method", "src/authz/cache.ts", "modified"], ["RoleCache.set", "method", "src/authz/cache.ts", "modified"], ["RoleCache.evict", "method", "src/authz/cache.ts", "unchanged"], ["roleCacheFor", "function", "src/authz/cache.ts", "modified"], ["key", "function", "src/authz/cache.ts", "removed"]],
    { tags: ["forge-lite-S-2", "invalidation-stripped"] }),
  F("F07", "decoy", "per-call", "compatible",
    "Agent A (scenarios/s1/a.patch): adds the revoke route, removeCollaborator and the collaborator.removed event. requirePermission is untouched and still evaluates the role from the store on every call. per-call is within per-request.",
    [["ACTIONS", "const", "src/domain/permissions.ts", "modified"], ["MINIMUM_ROLE", "const", "src/domain/permissions.ts", "modified"], ["CollaboratorRemoved", "interface", "src/events.ts", "added"], ["DomainEvent", "type", "src/events.ts", "modified"], ["DELETE /repos/:owner/:repo/collaborators/:username", "route", "src/routes/collaborators.ts", "added"], ["MemoryStore.removeCollaborator", "method", "src/store/memory.ts", "added"], ["Store.removeCollaborator", "method", "src/store/types.ts", "added"], ["requirePermission", "function", "src/authz/require-permission.ts", "unchanged"]],
    { decoyType: "different-subject", tags: ["forge-lite-S-1", "real-hunks"] }),
  F("F08", "decoy", "per-call", "compatible",
    "A per-session cache of the repository owner's user record for the repo view; requirePermission and evaluateRole are untouched. The subject keeps its per-call value, within per-request.",
    [["ownerCache", "const", "src/routes/repos.ts", "added"], ["view", "function", "src/routes/repos.ts", "modified"], ["requirePermission", "function", "src/authz/require-permission.ts", "unchanged"]],
    { decoyType: "different-subject", tags: ["forge-lite-S-1"] }),
];
