import { env } from "cloudflare:workers";
import { agentIdOf, givenHandle } from "@keeltown/core/domain/identity";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import {
  freshAddress,
  granted,
  newKey,
  proofBy,
  requestToken,
  type TestKey,
  TOKEN_ENDPOINT,
} from "./agent-keys.ts";
import { BASE, drainOutbox, worker } from "./helpers.ts";

const REGISTER = `${BASE}/v1/oauth/register`;

interface SignUp {
  /** The proof to send; a fresh one made by the key being registered when absent, none when null. */
  readonly proof?: string | null;
  readonly name?: string;
  /** The body to send instead of the one an agent sends for `key`. */
  readonly body?: unknown;
}

/** Signs `key` up the way an agent does: its public key, and a proof made by that key for this request. */
async function signUp(key: TestKey, request: SignUp = {}): Promise<Response> {
  const proof = request.proof === undefined ? await proofBy(key, "POST", REGISTER) : request.proof;
  const response = await worker(REGISTER, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": freshAddress(),
      ...(proof === null ? {} : { dpop: proof }),
    },
    body: JSON.stringify(
      request.body ?? {
        jwks: { keys: [key.publicJwk] },
        token_endpoint_auth_method: "private_key_jwt",
        grant_types: ["client_credentials"],
        ...(request.name === undefined ? {} : { client_name: request.name }),
      },
    ),
  });
  // The agent's own object flushes what it committed before the next case starts.
  await drainOutbox(
    env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentIdOf(key.key.jkt)}`)),
  );
  return response;
}

interface Registered {
  readonly client_id: string;
  readonly client_id_issued_at: number;
  readonly handle: string;
  readonly kind: string;
  readonly client_name: string;
  readonly token_endpoint_auth_method: string;
  readonly grant_types: readonly string[];
  readonly jwks: { readonly keys: readonly Record<string, unknown>[] };
}

const refusal = async (response: Response) => ({
  status: response.status,
  error: (await response.json<{ error?: string }>()).error,
});

describe("an agent signs itself up with a key", () => {
  it("[signup.http] a key and nothing else: the account's id and handle are made from the key, and it gets a token at once", async () => {
    const account = await newKey();
    const response = await signUp(account, { name: "builder" });
    expect(response.status).toBe(201);
    const registered = await response.json<Registered>();
    const agentId = agentIdOf(account.key.jkt);
    expect(registered).toMatchObject({
      client_id: agentId,
      handle: givenHandle(agentId),
      kind: "agent",
      client_name: "builder",
      token_endpoint_auth_method: "private_key_jwt",
      grant_types: ["client_credentials"],
      jwks: { keys: [account.key.jwk] },
    });
    expect(registered.client_id_issued_at).toBeGreaterThan(1_700_000_000);
    const token = await granted(
      await requestToken(registered.client_id, account, { runKey: await newKey() }),
    );
    expect(token.token_type).toBe("DPoP");
  });

  it("[signup.one-account-per-key] the same key again is the same account, answered 200 with what the first answer said", async () => {
    const account = await newKey();
    const first = await signUp(account);
    const again = await signUp(account, { name: "another-name" });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(await again.json()).toEqual(await first.json());
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents WHERE id = ?")
      .bind(agentIdOf(account.key.jkt))
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("[signup.key-proof] a sign-up needs a proof made by the key it registers, for this request, made now", async () => {
    const account = await newKey();
    const other = await newKey();
    const stale = Math.floor(Date.now() / 1000) - 600;
    const proofs: Record<string, string | null> = {
      "no proof": null,
      "another key's proof": await proofBy(other, "POST", REGISTER),
      "a proof for the token endpoint": await proofBy(account, "POST", TOKEN_ENDPOINT),
      "a proof for another method": await proofBy(account, "GET", REGISTER),
      "a proof made ten minutes ago": await proofBy(account, "POST", REGISTER, {
        issuedAt: stale,
      }),
      "something that is no proof": "not.a.proof",
    };
    for (const [what, proof] of Object.entries(proofs))
      expect([what, await refusal(await signUp(account, { proof }))]).toEqual([
        what,
        { status: 401, error: "invalid_dpop_proof" },
      ]);
    const none = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents WHERE id = ?")
      .bind(agentIdOf(account.key.jkt))
      .first<{ n: number }>();
    expect(none?.n).toBe(0);
    expect((await signUp(account)).status).toBe(201);
  });

  it("[signup.key-refused] a private key, a key of a kind Keel does not take, and more than one key are refused before anything is made", async () => {
    const account = await newKey();
    // The whole key, sent with a proof that same key made: nothing but its private part is wrong with it.
    const whole = await newKey({ extractable: true });
    const withPrivatePart = await exportJWK(whole.privateKey);
    expect("d" in withPrivatePart).toBe(true);
    const { publicKey: rsa } = await generateKeyPair("RS256");
    const cases: Record<string, readonly [TestKey, unknown]> = {
      "a private key": [whole, { jwks: { keys: [withPrivatePart] } }],
      "an RSA key": [account, { jwks: { keys: [await exportJWK(rsa)] } }],
      "two keys": [account, { jwks: { keys: [account.publicJwk, (await newKey()).publicJwk] } }],
      "no key": [account, { jwks: { keys: [] } }],
      "a client secret": [
        account,
        { jwks: { keys: [account.publicJwk] }, token_endpoint_auth_method: "client_secret_post" },
      ],
    };
    for (const [what, [key, body]] of Object.entries(cases))
      expect([what, (await signUp(key, { body })).status]).toEqual([what, 400]);
    const none = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents WHERE id IN (?, ?)")
      .bind(agentIdOf(account.key.jkt), agentIdOf(whole.key.jkt))
      .first<{ n: number }>();
    expect(none?.n).toBe(0);
  });
});
