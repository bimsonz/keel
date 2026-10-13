import { NamespaceId, type ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { makeProjectNamespacesMemory } from "./memory/tenancy.ts";

/** The namespace the fixtures' projects belong to: every object a fixture keeps is kept for it. */
export const sampleNamespace = Schema.decodeUnknownSync(NamespaceId)(
  "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
);

/** Another namespace, to show that what is kept for one is not there for the other. */
export const otherNamespace = Schema.decodeUnknownSync(NamespaceId)(
  "org_01JZ8PT2C4E6G8J0M2N4Q6S8V1",
);

/**
 * The projects' places in memory, with `projectId` already placed in
 * `namespace`: what a Lane or a Workflow of that project reads to learn where
 * its bundles, plans and evidence are kept.
 */
export function makePlacedProject(projectId: ProjectId, namespace: NamespaceId = sampleNamespace) {
  const places = makeProjectNamespacesMemory();
  places.places.set(projectId, { projectId, namespace, name: projectId.toLowerCase() });
  return places;
}
