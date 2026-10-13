// Control for the readonly-bundles guard's one exception: the deps box may put
// a namespace's deps pointer and its parts, and nothing else. The guard must
// pass the first two writes and report each of the others. The third is the
// only put of another family in this control, so the guard's reason for it is
// read from that line alone.
interface Bucket {
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<void>;
}
declare const env: { BUNDLES: Bucket };
declare function namespaceKey(namespace: string, family: string, hex: string): string;

export async function writes(namespace: string, hex: string): Promise<void> {
  await env.BUNDLES.put(namespaceKey(namespace, "deps", hex), "the pointer");
  await env.BUNDLES.put(namespaceKey(namespace, "deps-parts", hex), "a part");
  await env.BUNDLES.put(namespaceKey(namespace, "bundles", hex), "a candidate bundle, overwritten");
  await env.BUNDLES.delete(namespaceKey(namespace, "deps-parts", hex));
}
