import type { OrgId } from "../../domain/kernel/index.ts";

/** The families of objects Keel keeps in R2 for a namespace: candidate, world and probe bundles, deps bundles by lockfile, evidence documents and compiled plans. */
export type KeyFamily = "bundles" | "deps" | "evidence" | "plans";

/**
 * The one place an R2 key for a namespace's object is built:
 * `ns/<namespaceId>/<family>/<hex>`. The namespace is its id, never its
 * handle, and it comes first, so one namespace's objects sit under one prefix
 * and no key of one namespace is a key of another. A store that builds a key
 * any other way can read across namespaces (guard: r2-namespace-keys).
 */
export const namespaceKey = (namespace: OrgId, family: KeyFamily, hex: string): string =>
  `ns/${namespace}/${family}/${hex}`;
