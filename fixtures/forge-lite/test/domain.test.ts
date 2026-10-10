import { describe, expect, it } from "vitest";
import { allows, canSee, minimumRole } from "../src/domain/permissions.ts";
import { COLLABORATOR_ROLES, atLeast, compareRoles, isCollaboratorRole } from "../src/domain/roles.ts";

describe("role lattice", () => {
  it("orders collaborator roles read < triage < write < maintain < admin", () => {
    const sorted = COLLABORATOR_ROLES.toSorted(compareRoles);
    expect(sorted).toEqual(["read", "triage", "write", "maintain", "admin"]);
    for (let i = 1; i < sorted.length; i++) {
      expect(compareRoles(sorted[i - 1] ?? "read", sorted[i] ?? "read")).toBeLessThan(0);
    }
  });

  it("puts owner above every collaborator role", () => {
    for (const role of COLLABORATOR_ROLES) {
      expect(atLeast("owner", role)).toBe(true);
      expect(atLeast(role, "owner")).toBe(false);
    }
  });

  it("treats owner as a role that cannot be granted", () => {
    expect(isCollaboratorRole("owner")).toBe(false);
    expect(isCollaboratorRole("admin")).toBe(true);
    expect(isCollaboratorRole("superuser")).toBe(false);
    expect(isCollaboratorRole(3)).toBe(false);
  });
});

describe("permissions", () => {
  // The permission matrix covers every other action through its route.
  it("lets only admins and the owner change visibility", () => {
    expect(minimumRole("change-visibility")).toBe("admin");
  });

  it("lets anyone read a public repository but nothing more", () => {
    expect(allows(null, "read", "public")).toBe(true);
    expect(allows(null, "read", "private")).toBe(false);
    expect(allows(null, "push", "public")).toBe(false);
  });

  it("hides private repositories from callers without a role", () => {
    expect(canSee(null, "private")).toBe(false);
    expect(canSee(null, "public")).toBe(true);
    expect(canSee("read", "private")).toBe(true);
  });
});
