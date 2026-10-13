// The builder, as the real tree has it: the guard reads the families from
// KeyFamily and reports nothing in this file.
export type KeyFamily = "bundles" | "deps" | "evidence" | "plans";

export const namespaceKey = (namespace: string, family: KeyFamily, hex: string): string =>
  `ns/${namespace}/${family}/${hex}`;
