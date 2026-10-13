// Control for the readonly-bundles guard: every way keel-verify could write to,
// or lose track of, the BUNDLES bucket. The guard must report each one. The
// put here writes a key the deps box may write, from a file that is not the
// deps box: it is the only put outside keel-deps-box.ts in this control, so
// the guard's reason for it is read from this line alone.
interface Bucket {
  get(key: string): Promise<unknown>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<void>;
  createMultipartUpload(key: string): Promise<unknown>;
}
declare const env: { BUNDLES: Bucket };
declare function namespaceKey(namespace: string, family: string, hex: string): string;

export async function writes(): Promise<void> {
  await env.BUNDLES.get("bundles/fine");
  await env.BUNDLES.put(namespaceKey("org_x", "deps-parts", "x"), "a part, from a suite box");
  await env.BUNDLES.delete("bundles/x");
  await env["BUNDLES"].createMultipartUpload("bundles/y");
  const bucket = env.BUNDLES;
  await bucket.put("bundles/z", "through an alias");
  const { BUNDLES } = env;
  await BUNDLES.delete("bundles/z");
}
