// Control for the readonly-bundles guard: every way keel-verify could write to,
// or lose track of, the BUNDLES bucket. The guard must report each one.
interface Bucket {
  get(key: string): Promise<unknown>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<void>;
  createMultipartUpload(key: string): Promise<unknown>;
}
declare const env: { BUNDLES: Bucket };

export async function writes(): Promise<void> {
  await env.BUNDLES.get("bundles/fine");
  await env.BUNDLES.put("bundles/x", "overwritten");
  await env.BUNDLES.delete("bundles/x");
  await env["BUNDLES"].createMultipartUpload("bundles/y");
  const bucket = env.BUNDLES;
  await bucket.put("bundles/z", "through an alias");
  const { BUNDLES } = env;
  await BUNDLES.delete("bundles/z");
}
