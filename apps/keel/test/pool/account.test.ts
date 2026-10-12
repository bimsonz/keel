import { env, exports } from "cloudflare:workers";
import type { SavedPasskey } from "@keeltown/testing/passkey";
import { describe, expect, it } from "vitest";
import { signIn, signUp, whoIs } from "../../../../scripts/lib/account.ts";
import { BASE, uniqueHandle } from "./helpers.ts";

/** keel.town's own entry, each call from its own address so the per-IP limit never binds here. */
const fetcher = (request: Request) => {
  const from = new Request(request);
  from.headers.set("cf-connecting-ip", `2001:db8::${crypto.randomUUID().slice(0, 4)}`);
  return exports.default.fetch(from);
};

const usersNamed = async (handle: string) =>
  (
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE username = ?1`)
      .bind(handle)
      .first<{ n: number }>()
  )?.n;

describe("automation accounts, made as any visitor's", () => {
  it("[account.sign-up] signs a handle up by passkey, hands the passkey over before the account exists, and answers a session the gate reads as that user", async () => {
    const handle = uniqueHandle("auto");
    const kept: SavedPasskey[] = [];
    const before: (number | undefined)[] = [];
    const account = await signUp(BASE, handle, {
      fetcher,
      keep: async (passkey) => {
        kept.push(passkey);
        before.push(await usersNamed(handle));
      },
    });
    expect(kept).toEqual([account.passkey]);
    expect(before).toEqual([0]);
    expect(await usersNamed(handle)).toBe(1);
    expect(account.session).toMatchObject({ keelUrl: BASE, handle, namespace: handle });
    expect(await whoIs(BASE, account.session.token, fetcher)).toEqual({
      status: 200,
      handle,
      userId: account.session.userId,
      orgs: { [handle]: "owner" },
    });
    expect((await whoIs(BASE, `${account.session.token}x`, fetcher)).status).toBe(401);
    // The handle is taken now, and the refusal carries its code and nothing of an answer's body.
    await expect(signUp(BASE, handle, { fetcher })).rejects.toMatchObject({
      name: "AccountRefused",
      status: 400,
      code: "NAME_TAKEN",
    });
  });

  it("[account.sign-in] signs in again from the kept passkey, each time with the passkey it was last handed", async () => {
    const handle = uniqueHandle("again");
    const first = await signUp(BASE, handle, { fetcher });
    const second = await signIn(BASE, handle, first.passkey, fetcher);
    const third = await signIn(BASE, handle, second.passkey, fetcher);
    expect([first, second, third].map((account) => account.passkey.count)).toEqual([0, 1, 2]);
    const tokens = [first, second, third].map((account) => account.session.token);
    expect(new Set(tokens).size).toBe(3);
    for (const token of tokens)
      expect(await whoIs(BASE, token, fetcher)).toMatchObject({ status: 200, handle });
    // Another account's passkey signs in to that account, never to this handle.
    const other = await signUp(BASE, uniqueHandle("other"), { fetcher });
    await expect(signIn(BASE, handle, other.passkey, fetcher)).rejects.toThrow(
      `the session is not ${handle}'s`,
    );
  });
});
