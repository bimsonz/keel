// Control for the r2-namespace-keys guard: a store that writes the namespace's
// layout itself, a second builder beside namespaceKey.
interface Bucket {
  put(key: string, value: string): Promise<unknown>;
}
declare const bucket: Bucket;

export async function keep(namespace: string, hex: string, text: string): Promise<void> {
  await bucket.put(`ns/${namespace}/plans/${hex}`, text);
}
