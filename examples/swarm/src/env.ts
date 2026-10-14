/** Keel's origin, from the host the deploy names. */
export const keelOrigin = (env: Pick<Env, "KEEL_HOST">): string => `https://${env.KEEL_HOST}`;
