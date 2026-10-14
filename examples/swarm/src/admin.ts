const digest = async (s: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** Compares digests in time that doesn't depend on where they differ. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return difference === 0;
}

/**
 * Whether a request carries the swarm's admin bearer. Every route but the
 * root needs it, the agents' own among them: an open route would let anyone
 * spend the shared account's model calls. With no secret set, nothing is
 * admitted.
 */
export async function admitted(
  authorization: string | null | undefined,
  secret: string | undefined,
): Promise<"admitted" | "refused" | "unset"> {
  if (secret === undefined || secret.length === 0) return "unset";
  const presented = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
  if (presented === undefined) return "refused";
  return (await sameSecret(presented, secret)) ? "admitted" : "refused";
}
