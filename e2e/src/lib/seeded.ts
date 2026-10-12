import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KeelClient } from "@keeltown/sdk";

/** One credential `scripts/seed.ts` wrote. */
export interface Credential {
  readonly agentId: string;
  readonly projectId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface SeededProject {
  readonly id: string;
  readonly verification: string;
  readonly agents: readonly Credential[];
}

/** The seed's automation user: a bearer session, and its org named by its handle. */
export interface SeedUser {
  readonly userId: string;
  readonly handle: string;
  readonly org: string;
  readonly token: string;
}

/** `.keel/<env>.json`, as `scripts/seed.ts` writes it. */
export interface Seeded {
  readonly environment: string;
  readonly keelUrl: string;
  readonly seedUser: SeedUser;
  readonly projects: Readonly<Record<string, SeededProject>>;
}

export function readSeeded(root: string, environment: string): Seeded {
  const path = join(root, ".keel", `${environment}.json`);
  const seeded: Seeded = JSON.parse(readFileSync(path, "utf8"));
  if (
    seeded.projects["forge-lite"] === undefined ||
    seeded.projects["forge-lite-control"] === undefined
  )
    throw new Error(`${path} lacks the S-0 projects: run \`node scripts/seed.ts ${environment}\``);
  return seeded;
}

/** The seed's user: it governs the seed's projects and reads every project of its org's feed. */
export const userClient = (keelUrl: string, user: SeedUser): KeelClient =>
  new KeelClient({ baseUrl: process.env["KEEL_URL"] ?? keelUrl, session: user.token });

export const clientFor = (keelUrl: string, credential: Credential): KeelClient =>
  new KeelClient({
    baseUrl: process.env["KEEL_URL"] ?? keelUrl,
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
  });
