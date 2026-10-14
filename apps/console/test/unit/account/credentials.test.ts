import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONNECT_OUTCOMES,
  CONNECT_SAID,
  credentialOf,
  outcomeIn,
  storedOf,
} from "../../../src/account/credentials.ts";
import type { Credential, NamespaceRef } from "../../../src/contract/keel/index.ts";
import { createHttpCredentials, createHttpSource } from "../../../src/source/http.ts";
import { KeelRefused } from "../../../src/source/types.ts";
import {
  CONSENT_ACCOUNT,
  CONSENT_URL,
  type Reached,
  SESSION_COOKIE,
  TARGETS_MOST,
  createFakeKeel,
} from "../../fixtures/mock/fakeKeel.ts";

const ORIGIN = "https://keel.example";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-token-that-reaches-the-account";

type Person = "ada" | "max" | "eve";

/**
 * A Keel whose project is in Ada's own namespace, unless a test says whose: Ada owns it, Max maintains it where
 * it is an org's, and Eve is nobody to it. The browser's part is played here: it sends a session's cookie and
 * the page's origin, and what the page's own code put on each request is kept as it was sent.
 */
function keel(
  over: {
    namespace?: NamespaceRef;
    visibility?: "private" | "public";
    cloudflare?: (asked: { secret: string; accountId: string }) => Reached;
    oauthClient?: boolean;
  } = {},
) {
  const fake = createFakeKeel({
    namespace: over.namespace ?? { handle: "ada", kind: "user" },
    visibility: over.visibility ?? "public",
    sessions: { ada: "owner", max: "maintainer", eve: "stranger" },
    now: () => Date.parse("2026-10-14T01:30:00.000Z"),
    ...(over.cloudflare === undefined ? {} : { cloudflare: over.cloudflare }),
    ...(over.oauthClient === undefined ? {} : { oauthClient: over.oauthClient }),
  });
  const fromThePage: Request[] = [];
  const options = (who?: Person, origin = ORIGIN) => ({
    origin: ORIGIN,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const asked = new Request(input, init);
      fromThePage.push(asked.clone());
      const headers = new Headers(asked.headers);
      if (who !== undefined) headers.set("cookie", `${SESSION_COOKIE}=${who}`);
      headers.set("origin", origin);
      return fake.fetch(new Request(asked, { headers }));
    },
  });
  const credentials = (who?: Person, origin?: string) =>
    createHttpCredentials(options(who, origin));
  const targets = (who?: Person, origin?: string) =>
    createHttpSource(fake.project, options(who, origin)).targets;
  return { fake, fromThePage, credentials, targets, handle: fake.project.namespace.handle };
}

/**
 * A credential stored as Keel's API stores one, by the namespace's owner: the console has no way to, since Keel
 * makes the tokens it deploys with when an owner connects an account.
 */
async function seeded(
  k: ReturnType<typeof keel>,
  handle: string,
  stored: { label: string; provider: "cloudflare"; secret: string },
): Promise<Credential> {
  const response = await k.fake.fetch(
    new Request(`${ORIGIN}/v1/namespaces/${handle}/credentials`, {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=ada`,
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify(stored),
    }),
  );
  expect(response.status).toBe(201);
  const made: Credential = await response.json();
  return made;
}

/** Strings in order, for comparing two lists as sets. */
const order = (a: string, b: string) => a.localeCompare(b);

/** Cloudflare's consent, played: the owner ticks the one account, and the consent sends them to Keel's callback. */
const consented = async (k: ReturnType<typeof keel>, consent: string, who: Person = "ada") => {
  const state = new URL(consent).searchParams.get("state") ?? "";
  return k.fake.fetch(
    new Request(`${ORIGIN}/v1/cloudflare/callback?code=the-code&state=${state}`, {
      headers: { cookie: `${SESSION_COOKIE}=${who}` },
    }),
  );
};

/** A refusal in full: Keel's sentence and the ways forward it gave under it, as a page shows them. */
const worded = (error: unknown): unknown =>
  error instanceof KeelRefused
    ? { status: error.status, code: error.code, said: error.message, next: error.next }
    : error;

const NOT_THE_OWNER = {
  status: 403,
  code: "auth.forbidden",
  said: "Refused: role.",
  next: [
    "This is a person's own namespace and has no members: only its owner does this. Use your own namespace, or an org you are a member of",
  ],
};
const NOT_AN_OWNER = {
  status: 403,
  code: "auth.forbidden",
  said: "Refused: role.",
  next: ["Ask an owner: this needs that role"],
};
const CONNECT_AGAIN = "Connect the account again through Cloudflare, which makes Keel a new token";

describe("a namespace's credentials", () => {
  it("[credentials.calls] reads and removes by the namespace's handle, sends no token, and adds nothing of the page's to any call", async () => {
    const k = keel();
    const made = await seeded(k, "ada", {
      label: "ada deploys",
      provider: "cloudflare",
      secret: TOKEN,
    });
    expect(await k.credentials("ada").listCredentials("ada")).toEqual([made]);
    await k.credentials("ada").removeCredential("ada", made.id);
    const [list, remove] = k.fromThePage;
    expect(`${list?.method} ${list?.url}`).toBe(`GET ${ORIGIN}/v1/namespaces/ada/credentials`);
    expect(`${remove?.method} ${remove?.url}`).toBe(
      `DELETE ${ORIGIN}/v1/namespaces/ada/credentials/${made.id}`,
    );
    for (const sent of k.fromThePage) {
      expect(sent.url).not.toContain(TOKEN);
      expect([...sent.headers.keys()]).toEqual([]);
      expect(await sent.text()).toBe("");
    }
  });

  it("[credentials.owner] are read and removed by the namespace's owner alone, and refused to anyone else in Keel's words", async () => {
    const own = keel();
    const refusedTo = async (who: Person | undefined, handle: string) => [
      await own.credentials(who).listCredentials(handle).catch(worded),
      await own
        .credentials(who)
        .removeCredential(handle, "crd_00000000000000000000000000")
        .catch(worded),
    ];
    // A person's own namespace has nobody else to ask.
    expect(await refusedTo("eve", "ada")).toEqual([NOT_THE_OWNER, NOT_THE_OWNER]);
    // Someone signed in to nothing is asked to be.
    expect(await refusedTo(undefined, "ada")).toEqual(
      Array.from({ length: 2 }, () => expect.objectContaining({ code: "auth.required" })),
    );
    // A handle that is nobody's is not there.
    expect(await own.credentials("ada").listCredentials("nobody").catch(worded)).toMatchObject({
      status: 404,
      code: "resource.not_found",
    });
    // In an org, a maintainer is not an owner, and is told whom to ask.
    const org = keel({ namespace: { handle: "acme", kind: "org" } });
    expect(await org.credentials("max").listCredentials("acme").catch(worded)).toEqual(
      NOT_AN_OWNER,
    );
    expect(
      await org
        .credentials("max")
        .removeCredential("acme", "crd_00000000000000000000000000")
        .catch(worded),
    ).toEqual(NOT_AN_OWNER);
    expect(await org.credentials("ada").listCredentials("acme")).toEqual([]);
  });

  it("[credentials.cross-site] takes no move another site's page sent", async () => {
    const k = keel();
    const made = await seeded(k, "ada", { label: "x", provider: "cloudflare", secret: TOKEN });
    expect(
      await k
        .credentials("ada", "https://elsewhere.example")
        .removeCredential("ada", made.id)
        .catch(worded),
    ).toMatchObject({ status: 403, code: "auth.cross_site" });
    expect(await k.credentials("ada").listCredentials("ada")).toEqual([made]);
  });

  it("[credentials.removed] deletes a credential a target still names, which keeps its id and names nothing stored", async () => {
    const k = keel();
    const made = await seeded(k, "ada", {
      label: "ada deploys",
      provider: "cloudflare",
      secret: TOKEN,
    });
    const target = await k
      .targets("ada")
      .putTarget("production", { provider: "cloudflare", accountId: ACCOUNT, credential: made.id });
    const other = await seeded(k, "ada", { label: "spare", provider: "cloudflare", secret: TOKEN });
    expect(credentialOf(target, [other, made])).toEqual(made);
    await k.credentials("ada").removeCredential("ada", made.id);
    const left = await k.credentials("ada").listCredentials("ada");
    expect(left).toEqual([other]);
    expect(await k.targets("ada").listTargets()).toEqual([target]);
    // The credential left is not the target's, whatever is stored beside it.
    expect(credentialOf(target, left)).toBe(undefined);
    expect(await k.credentials("ada").removeCredential("ada", made.id).catch(worded)).toEqual({
      status: 404,
      code: "resource.not_found",
      said: `The namespace holds no credential ${made.id}.`,
      next: [],
    });
  });
});

/** Ada's credential, stored in the namespace of the project. */
const storedBy = async (k: ReturnType<typeof keel>, secret = TOKEN) =>
  seeded(k, k.handle, { label: "ada deploys", provider: "cloudflare", secret });

describe("a project's deploy targets", () => {
  it("[targets.calls] sets a target with the credential's id and never its token, the name and the account sent less the space around them", async () => {
    const k = keel();
    const made = await storedBy(k);
    const before = k.fromThePage.length;
    const set = await k.targets("ada").putTarget(" production ", {
      provider: "cloudflare",
      accountId: ` ${ACCOUNT} `,
      credential: made.id,
    });
    await k.targets("ada").listTargets();
    await k.targets("ada").clearTarget("production");
    const [put, list, clear] = k.fromThePage.slice(before);
    const at = `${ORIGIN}/v1/projects/${k.fake.project.id}/deploy-targets`;
    expect(`${put?.method} ${put?.url}`).toBe(`PUT ${at}/production`);
    expect(JSON.parse((await put?.clone().text()) ?? "")).toEqual({
      provider: "cloudflare",
      accountId: ACCOUNT,
      credential: made.id,
    });
    expect(`${list?.method} ${list?.url}`).toBe(`GET ${at}`);
    expect(`${clear?.method} ${clear?.url}`).toBe(`DELETE ${at}/production`);
    for (const sent of k.fromThePage.slice(before)) {
      expect(`${sent.url} ${await sent.clone().text()}`).not.toContain(TOKEN);
      expect([...sent.headers.keys()].filter((name) => name !== "content-type")).toEqual([]);
    }
    expect(set).toEqual({
      name: "production",
      provider: "cloudflare",
      accountId: ACCOUNT,
      credential: made.id,
      workersDev: "keel-previews.workers.dev",
    });
  });

  it("[targets.read] are read and set by the owner of the project's namespace alone, and a project the reader is not read is not there", async () => {
    const org = keel({ namespace: { handle: "acme", kind: "org" }, visibility: "private" });
    expect(await org.targets("ada").listTargets()).toEqual([]);
    expect(await org.targets("max").listTargets().catch(worded)).toEqual(NOT_AN_OWNER);
    expect(
      await org
        .targets("max")
        .putTarget("production", {
          provider: "cloudflare",
          accountId: ACCOUNT,
          credential: "crd_x",
        })
        .catch(worded),
    ).toEqual(NOT_AN_OWNER);
    expect(await org.targets("eve").listTargets().catch(worded)).toMatchObject({
      status: 404,
      code: "resource.not_found",
    });
    expect(await org.targets().listTargets().catch(worded)).toMatchObject({
      status: 401,
      code: "auth.required",
    });
    // A public project is read to anyone, so anyone else is refused by role.
    const own = keel();
    expect(await own.targets("eve").listTargets().catch(worded)).toEqual(NOT_THE_OWNER);
  });

  it("[targets.refused] refuses as Keel does and in its order: a credential the namespace does not hold before Cloudflare is asked, then what Cloudflare said, then the count", async () => {
    const asked: string[] = [];
    const k = keel({
      cloudflare: ({ secret, accountId }) => {
        asked.push(secret);
        if (secret === "revoked") return { reaches: false, why: "token-invalid", code: 1000 };
        if (accountId !== ACCOUNT) return { reaches: false, why: "account-unreachable" };
        if (secret === "no-subdomain") return { reaches: true };
        return { reaches: true, subdomain: "ada" };
      },
    });
    const put = (name: string, credential: string, accountId = ACCOUNT) =>
      k
        .targets("ada")
        .putTarget(name, { provider: "cloudflare", accountId, credential })
        .catch(worded);
    expect(await put("production", "crd_00000000000000000000000000")).toEqual({
      status: 409,
      code: "deploy_target.refused",
      said: "Deploy target production names a credential this project's namespace does not hold. A target uses only a credential of its own project's namespace.",
      next: ["Read the namespace's credentials", CONNECT_AGAIN],
    });
    expect(asked).toEqual([]);
    const revoked = await storedBy(k, "revoked");
    expect(await put("production", revoked.id)).toEqual({
      status: 422,
      code: "deploy_target.unreachable",
      said: "Cloudflare refused the credential's token (Cloudflare error 1000): it is invalid, expired or revoked. Nothing was set.",
      next: [CONNECT_AGAIN],
    });
    const good = await storedBy(k);
    expect(await put("production", good.id, "f".repeat(32))).toEqual({
      status: 422,
      code: "deploy_target.unreachable",
      said: "The credential's token does not reach the account's Workers: check the account id, and that the token may edit Workers on that account. Nothing was set.",
      next: [CONNECT_AGAIN],
    });
    const bare = await storedBy(k, "no-subdomain");
    expect(await put("production", bare.id)).toMatchObject({
      status: 422,
      code: "deploy_target.no_workers_dev",
      next: ["Set the target again once the account has a workers.dev subdomain"],
    });
    expect(await k.targets("ada").listTargets()).toEqual([]);
    // A project holds at most sixteen; setting one already there again is not a seventeenth.
    const names = Array.from(
      { length: TARGETS_MOST },
      (_, at) => `target-${String(at).padStart(2, "0")}`,
    );
    for (const name of names) await put(name, good.id);
    expect(await put("one-more", good.id)).toEqual({
      status: 409,
      code: "deploy_target.refused",
      said: "The project already has all the deploy targets it may, so one-more was not set. Clear one first, or set one already there again.",
      next: ["Read the project's deploy targets"],
    });
    expect(await put("target-00", good.id)).toMatchObject({
      name: "target-00",
      workersDev: "ada.workers.dev",
    });
    expect((await k.targets("ada").listTargets()).map((target) => target.name)).toEqual(names);
  });

  it("[targets.cleared] clears a target by its name, and a name with none is not there", async () => {
    const k = keel();
    const made = await storedBy(k);
    await k
      .targets("ada")
      .putTarget("staging", { provider: "cloudflare", accountId: ACCOUNT, credential: made.id });
    await k
      .targets("ada")
      .putTarget("production", { provider: "cloudflare", accountId: ACCOUNT, credential: made.id });
    expect((await k.targets("ada").listTargets()).map((target) => target.name)).toEqual([
      "production",
      "staging",
    ]);
    await k.targets("ada").clearTarget("staging");
    expect((await k.targets("ada").listTargets()).map((target) => target.name)).toEqual([
      "production",
    ]);
    expect(await k.targets("ada").clearTarget("staging").catch(worded)).toEqual({
      status: 404,
      code: "resource.not_found",
      said: "The project has no deploy target named staging.",
      next: [],
    });
  });
});

describe("connecting a Cloudflare account", () => {
  it("[targets.connect] begins with the target's name alone and sends the owner to Cloudflare's consent, whose callback sets the target with a token Keel made", async () => {
    const k = keel();
    const consent = await k.targets("ada").beginConnect(" production ");
    const [begun] = k.fromThePage;
    expect(`${begun?.method} ${begun?.url}`).toBe(
      `POST ${ORIGIN}/v1/projects/${k.fake.project.id}/deploy-targets/production/cloudflare-connect`,
    );
    expect(await begun?.text()).toBe("");
    expect(consent.startsWith(`${CONSENT_URL}?`)).toBe(true);
    const back = await consented(k, consent);
    expect([back.status, back.headers.get("location")]).toEqual([
      303,
      `/${k.handle}/${k.fake.project.name}/settings?cloudflare=connected`,
    ]);
    const [made] = await k.credentials("ada").listCredentials(k.handle);
    expect(made?.label).toBe(`Keel deploys: ${k.handle}/${k.fake.project.name}`);
    expect(await k.targets("ada").listTargets()).toEqual([
      {
        name: "production",
        provider: "cloudflare",
        accountId: CONSENT_ACCOUNT,
        credential: made?.id,
        workersDev: "keel-previews.workers.dev",
      },
    ]);
    // The same consent again finishes nothing.
    expect((await consented(k, consent)).headers.get("location")).toMatch(/cloudflare=expired$/);
  });

  it("[targets.connect-owner] is begun by the namespace's owner alone, from Keel's own page", async () => {
    const k = keel();
    expect(await k.targets("eve").beginConnect("production").catch(worded)).toEqual(NOT_THE_OWNER);
    expect(
      await k.targets("ada", "https://elsewhere.example").beginConnect("production").catch(worded),
    ).toMatchObject({ status: 403, code: "auth.cross_site" });
    const org = keel({ namespace: { handle: "acme", kind: "org" } });
    expect(await org.targets("max").beginConnect("production").catch(worded)).toEqual(NOT_AN_OWNER);
  });

  it("[connect.unset] on an instance with no OAuth client, beginning says so in Keel's words, as a refusal the page knows", async () => {
    const k = keel({ oauthClient: false });
    expect(await k.targets("ada").beginConnect("production").catch(worded)).toMatchObject({
      status: 503,
      code: "cloudflare.not_configured",
    });
    expect(await k.targets("ada").listTargets()).toEqual([]);
  });

  it("[connect.outcomes] reads the outcome Keel's callback names, says each, and knows exactly the ones Keel's API publishes", () => {
    expect(outcomeIn("?cloudflare=connected")).toBe("connected");
    expect(outcomeIn("?tab=x&cloudflare=no-workers-dev")).toBe("no-workers-dev");
    expect(outcomeIn("?cloudflare=whatever")).toBe(undefined);
    expect(outcomeIn("")).toBe(undefined);
    expect(CONNECT_OUTCOMES.filter((outcome) => CONNECT_SAID[outcome].ok)).toEqual(["connected"]);
    const document = JSON.parse(
      readFileSync(
        new URL("../../../../../packages/contracts/openapi.json", import.meta.url),
        "utf8",
      ),
    );
    const header = document.paths["/cloudflare/callback"].get.responses["303"].headers;
    const named = String(header["keel-cloudflare-outcome"].schema.$ref).split("/").at(-1) ?? "";
    const published: string[] = document.components.schemas[named].enum;
    expect(published.toSorted(order)).toEqual([...CONNECT_OUTCOMES].toSorted(order));
  });
});

describe("what the pages say of a credential", () => {
  it("[credentials.words] says who stored a credential, and when", () => {
    const credential = {
      id: "crd_00000000000000000000000000",
      label: "x",
      provider: "cloudflare" as const,
      createdAt: "2026-10-14T01:30:00.000Z",
      createdBy: "usr_ada",
    };
    expect(storedOf(credential, "usr_ada")).toBe("Cloudflare · stored on 2026-10-14 by you");
    expect(storedOf(credential, "usr_max")).toBe("Cloudflare · stored on 2026-10-14");
  });
});
