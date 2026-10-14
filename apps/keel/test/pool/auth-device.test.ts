/**
 * A terminal's `keeltown login`, approved with a passkey, through the real
 * Worker: for ten minutes from that passkey its session may give an agent
 * standing (here, an invitation to the person's project), and it never
 * changes how its account signs in. The approval passes the passkey's time on
 * and never resets it; an approval with no fresh passkey passes none.
 */
import { env } from "cloudflare:workers";
import { agentIdOf } from "@keeltown/core/domain/identity";
import { makeId, NamespaceId, type ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { freshAddress, newKey, proofBy } from "./agent-keys.ts";
import { type Answer, Jar } from "./auth-harness.ts";
import { answered, handled, signUpByPasskey, site } from "./auth-users.ts";
import { aged, type Carried, keeltownLogin, keeltownLoginBy, stale, tokenOf } from "./auth-ways.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  placeProject,
  uniqueHandle,
  worker,
} from "./helpers.ts";

const REGISTER = `${BASE}/v1/oauth/register`;

/** A session row's sign-in, as D1 holds it. */
const rowOf = async (token: string) =>
  env.DB.prepare(`SELECT signedInBy, createdAt, updatedAt, passkeyAt FROM session WHERE token = ?1`)
    .bind(token)
    .first<{
      signedInBy: string | null;
      createdAt: string;
      updatedAt: string;
      passkeyAt: number | null;
    }>();

/** One `/v1` request through the real Worker as the session `token` names. */
async function v1(token: string, method: string, path: string, body?: object) {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "cf-connecting-ip": freshAddress(),
    "idempotency-key": `key-${ulid()}`,
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await worker(`${BASE}/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer: Record<string, unknown> = Object(await response.json());
  return [response.status, answer["code"]] as const;
}

/** A private project placed in the person's own namespace. */
async function projectOf(userId: string): Promise<ProjectId> {
  const projectId: ProjectId = makeId("prj", ulid());
  await placeProject(projectId, Schema.decodeUnknownSync(NamespaceId)(userId));
  await establishProject(projectId);
  return projectId;
}

/** The handle of an agent that signed itself up through the Worker with a key. */
async function agentHandle(): Promise<string> {
  const account = await newKey();
  const registered = await worker(REGISTER, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": freshAddress(),
      dpop: await proofBy(account, "POST", REGISTER),
    },
    body: JSON.stringify({
      jwks: { keys: [account.publicJwk] },
      token_endpoint_auth_method: "private_key_jwt",
      grant_types: ["client_credentials"],
    }),
  });
  expect(registered.status).toBe(201);
  const agentId = agentIdOf(account.key.jkt);
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));
  const card = await worker(`${BASE}/v1/agents/${agentId}`, {
    headers: { "cf-connecting-ip": freshAddress() },
  });
  return String(Object(await card.json())["handle"]);
}

/** A person signed up by passkey, their user id and a project of theirs. */
async function aPasskeyPerson(prefix: string) {
  const { jar, device } = await signUpByPasskey(uniqueHandle(prefix));
  const me = await site("/get-session", { jar });
  answered(me, 200);
  const userId = String(me.json.user.id);
  return { jar, device, userId, projectId: await projectOf(userId) };
}

const terminalOf = (token: Answer) => String(token.json.access_token);

/** A terminal's session token, carried as keeltown carries it: a bearer. */
const asBearer = (token: string): Carried => ({
  jar: new Jar(),
  headers: { authorization: `Bearer ${token}` },
});

describe("a device sign-in approved with a passkey", () => {
  it("[ba.device-fresh] a terminal approved by a passkey sign-in three minutes old invites an agent; its session holds that passkey's time, and a terminal it approves in turn holds the same", async () => {
    const { jar, projectId } = await aPasskeyPerson("dfresh");
    await aged(jar, 3);
    const approver = await rowOf(tokenOf(jar));
    const passkeyAt = Date.parse(approver?.createdAt ?? "");

    const terminal = terminalOf((await keeltownLogin(jar)).token);
    expect(await rowOf(terminal)).toMatchObject({ signedInBy: "device", passkeyAt });
    const agents = `/projects/${projectId}/agents`;
    expect(await v1(terminal, "POST", agents, { agent: await agentHandle() })).toEqual([
      201,
      undefined,
    ]);

    // The terminal approves another: the passkey's time is passed on, not reset to the approval's.
    const second = terminalOf((await keeltownLoginBy(asBearer(terminal))).token);
    expect(await rowOf(second)).toMatchObject({ signedInBy: "device", passkeyAt });
    expect(await v1(second, "POST", agents, { agent: await agentHandle() })).toEqual([
      201,
      undefined,
    ]);
  }, 60_000);

  it("[ba.device-stale] a terminal approved by a passkey sign-in eleven minutes old, or by an email code, holds no passkey time and is refused an invitation", async () => {
    const late = await aPasskeyPerson("dlate");
    await aged(late.jar, 11);
    const coded = await handled(`dcode-${ulid().toLowerCase()}@example.com`, uniqueHandle("dcode"));
    const cases = [
      { jar: late.jar, projectId: late.projectId },
      { jar: coded.jar, projectId: await projectOf(coded.userId) },
    ];
    for (const { jar, projectId } of cases) {
      // oxlint-disable-next-line no-await-in-loop -- each login waits out the grant's interval in turn
      const terminal = terminalOf((await keeltownLogin(jar)).token);
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect(await rowOf(terminal)).toMatchObject({ signedInBy: "device", passkeyAt: null });
      expect(
        // oxlint-disable-next-line no-await-in-loop -- as above
        await v1(terminal, "POST", `/projects/${projectId}/agents`, { agent: "agent-anyone" }),
      ).toEqual([403, "auth.fresh_sign_in_required"]);
    }
  }, 60_000);

  it("[ba.device-refresh] the session's sliding update leaves its passkey's time as it was, so the terminal's standing ends ten minutes from that passkey", async () => {
    const { jar, projectId } = await aPasskeyPerson("dslide");
    const terminal = terminalOf((await keeltownLogin(jar)).token);
    const held = await rowOf(terminal);
    expect(held?.passkeyAt).toEqual(expect.any(Number));
    // Better Auth writes a session again once its expiry is nearer than its whole life less `updateAge`.
    const slide = async () => {
      const day = 24 * 60 * 60_000;
      const long = new Date(Date.now() - 2 * day).toISOString();
      await env.DB.prepare(`UPDATE session SET updatedAt = ?1, expiresAt = ?2 WHERE token = ?3`)
        .bind(long, new Date(Date.now() + 5 * day).toISOString(), terminal)
        .run();
      const read = await site("/get-session", asBearer(terminal));
      answered(read, 200);
      const after = await rowOf(terminal);
      expect(after?.updatedAt).not.toBe(long);
      return after;
    };
    expect((await slide())?.passkeyAt).toBe(held?.passkeyAt);

    // Ten minutes and a second after the passkey, the session slides again and is refused.
    await env.DB.prepare(`UPDATE session SET passkeyAt = ?1 WHERE token = ?2`)
      .bind(Date.now() - 601_000, terminal)
      .run();
    const now = await slide();
    expect(now?.passkeyAt).toBeLessThan(Date.now() - 600_000);
    expect(
      await v1(terminal, "POST", `/projects/${projectId}/agents`, { agent: "agent-anyone" }),
    ).toEqual([403, "auth.fresh_sign_in_required"]);
  }, 60_000);

  it("[ba.device-sign-in-routes] a terminal fresh from its passkey is refused a passkey of its own and the account's deletion", async () => {
    const { jar } = await aPasskeyPerson("dways");
    const terminal = terminalOf((await keeltownLogin(jar)).token);
    expect((await rowOf(terminal))?.passkeyAt).toEqual(expect.any(Number));
    stale(await site("/passkey/generate-register-options", asBearer(terminal)));
    stale(await site("/delete-user", { body: {}, ...asBearer(terminal) }));
    expect((await site("/get-session", { jar })).json.user.id).toEqual(expect.any(String));
  }, 60_000);
});
