// Control for the r2-namespace-keys guard: a store that spells an object's key
// itself, as a template and as a string, in the layout of before namespaces.
// The guard must report each one, and neither the call nor the doc comment.
interface Bucket {
  get(key: string): Promise<unknown>;
  put(key: string, value: Uint8Array): Promise<unknown>;
}
declare const bucket: Bucket;
declare function namespaceKey(namespace: string, family: string, hex: string): string;

/** Keeps a bundle at `bundles/<hex>`, and reads its evidence at `evidence/<hex>`. */
export async function keep(namespace: string, hex: string, bytes: Uint8Array): Promise<void> {
  await bucket.put(namespaceKey(namespace, "bundles", hex), bytes);
  await bucket.put(`bundles/${hex}`, bytes);
  await bucket.get("evidence/" + hex);
}
