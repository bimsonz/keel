import { describe, expect, it } from "vitest";
import { KeelClient, KeelProblem } from "../../sdk/src/index.ts";
import { seedProject } from "../../../scripts/lib/seed-project.ts";

/**
 * `scripts/seed.ts` reads each project it declares before it creates it. The
 * create's Idempotency-Key is the one every earlier seed sent, and the request
 * Keel stored under it is that seed's body: replayed with today's shape it is
 * refused as a different project, and the seed stops. Held here through the
 * SDK's client over a fetch that answers as Keel's routes do and records what
 * it was asked.
 */

const KEEL = "https://keel.test";
const EXISTING = "prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0";
const CREATED = "prj_01JZ8PT2C4E6G8J0M2N4Q6S8V2";
const KEY = "seed:staging:project:forge-lite";
const request = {
  namespace: "keel-seed",
  name: "forge-lite",
  source: { kind: "template", name: "fixture-forge-lite" },
} as const;

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const json = (status: number, body: object): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const refusal = (status: number, code: string): Response =>
  json(status, {
    type: "about:blank",
    title: code,
    status,
    code,
    requestId: "req-1",
    nextActions: [],
  });

/** A Keel whose read of the project answers `read`, and whose create makes CREATED. */
function keel(read: Response) {
  const asked: Asked[] = [];
  const client = new KeelClient({
    baseUrl: KEEL,
    session: "seed-session",
    fetch: async (url, init) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      asked.push({ method: init.method ?? "GET", url, headers, body });
      if (init.method === "GET" && url === `${KEEL}/v1/namespaces/keel-seed/projects/forge-lite`)
        return read;
      if (init.method === "POST" && url === `${KEEL}/v1/projects`)
        return json(201, { id: CREATED, namespace: request.namespace, name: request.name });
      return refusal(404, "route.not_found");
    },
  });
  return { client, asked, routes: () => asked.map((a) => `${a.method} ${a.url}`) };
}

const READ = `GET ${KEEL}/v1/namespaces/keel-seed/projects/forge-lite`;
const CREATE = `POST ${KEEL}/v1/projects`;

describe("the seed's project step", () => {
  it("[seed.keeps-existing-project] keeps a project that is already there, taking its id, and sends no create", async () => {
    const { client, routes } = keel(
      json(200, {
        id: EXISTING,
        namespace: { handle: "keel-seed", kind: "user" },
        name: "forge-lite",
        visibility: "private",
        viewer: { role: "owner" },
      }),
    );
    expect(await seedProject(client, request, KEY)).toEqual({ id: EXISTING, existed: true });
    expect(routes()).toEqual([READ]);
  });

  it("[seed.creates-missing-project] creates the project when its read answers 404, under the seed's Idempotency-Key", async () => {
    const { client, asked, routes } = keel(refusal(404, "resource.not_found"));
    expect(await seedProject(client, request, KEY)).toEqual({ id: CREATED, existed: false });
    expect(routes()).toEqual([READ, CREATE]);
    expect(asked[1]?.headers["idempotency-key"]).toBe(KEY);
    expect(asked[1]?.body).toEqual(request);
  });

  it("[seed.project-read-refused] stops on any other refusal of the read, and creates nothing", async () => {
    const refusals = [
      [401, "auth.unauthenticated"],
      [403, "auth.forbidden"],
      [500, "internal"],
    ] as const;
    await Promise.all(
      refusals.map(async ([status, code]) => {
        const { client, routes } = keel(refusal(status, code));
        const stopped = await seedProject(client, request, KEY).catch((error: unknown) => error);
        expect(stopped).toBeInstanceOf(KeelProblem);
        expect(stopped).toMatchObject({ status, code });
        expect(routes()).toEqual([READ]);
      }),
    );
  });
});
