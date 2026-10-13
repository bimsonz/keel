import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoordinationEvent } from "../src/domain/coordination/index.ts";
import { DeliveryEvent } from "../src/domain/delivery/index.ts";
import { IdentityEvent } from "../src/domain/identity/index.ts";
import { IntegrationEvent } from "../src/domain/integration/index.ts";
import { MemoryEvent } from "../src/domain/memory/index.ts";
import { VerificationEvent } from "../src/domain/verification/index.ts";

/** The `_tag` of each member of a union of tagged structs. */
function tags(union: {
  readonly members: readonly {
    readonly fields: { readonly _tag: { readonly schema: { readonly literal: unknown } } };
  }[];
}): string[] {
  return union.members.map((member) => String(member.fields._tag.schema.literal));
}

const catalogue = readFileSync(join(import.meta.dirname, "../../../docs/domain/events.md"), "utf8");

/** Event names per `## context` section of the catalogue. */
function catalogued(): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let section = "";
  for (const line of catalogue.split("\n")) {
    const heading = /^## (\w+)/.exec(line);
    if (heading?.[1] !== undefined) section = heading[1];
    const event = /^\|\s*`([A-Z][A-Za-z]+)`\s*\|/.exec(line);
    if (event?.[1] !== undefined)
      sections.set(section, [...(sections.get(section) ?? []), event[1]]);
  }
  return sections;
}

describe("the domain's events are the catalogue's events", () => {
  const sections = catalogued();
  it.each([
    ["identity", IdentityEvent],
    ["coordination", CoordinationEvent],
    ["verification", VerificationEvent],
    ["integration", IntegrationEvent],
    ["memory", MemoryEvent],
    ["delivery", DeliveryEvent],
  ] as const)("%s", (context, union) => {
    expect(tags(union).toSorted()).toEqual((sections.get(context) ?? []).toSorted());
  });

  it("covers all 109 catalogued events", () => {
    expect([...sections.values()].flat()).toHaveLength(109);
  });
});
