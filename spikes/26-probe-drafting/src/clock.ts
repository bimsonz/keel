/**
 * Date.now() only advances when I/O completes in workerd (S14). A cache lookup
 * is cheap real I/O, so bracket every timing with it.
 */
export async function clock(): Promise<number> {
  await caches.default.match("https://clock.invalid/");
  return Date.now();
}
