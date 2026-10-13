import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { type Answer, type Authenticator, caller, Jar } from "./auth-harness.ts";
import { answered, signUpByPasskey, site } from "./auth-users.ts";
import { byBearer, byCookie, type Carried, signInByPasskey, tokenOf } from "./auth-ways.ts";
import { uniqueHandle } from "./helpers.ts";
import { recordingDb } from "./recording-db.ts";

/** One session of a person's list, as Keel answers it. */
interface Listed {
  readonly id: string;
  readonly current: boolean;
  readonly signedInBy: string;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
}

/** The browser a second sign-in says it is. */
const BROWSER = "Mozilla/5.0 (pool) Keel/1";

const listed = async (by: Carried, via = site): Promise<Listed[]> => {
  const answer = await via("/sessions", by);
  answered(answer, 200);
  return answer.json.sessions;
};

/** The ids a list names, in an order of their own. */
const ids = (sessions: readonly Listed[]) => sessions.map((session) => session.id).toSorted();

/** The sessions a list marks as the one asking. */
const current = async (by: Carried) =>
  (await listed(by)).filter((session) => session.current).map((session) => session.id);

const end = (id: unknown, by: Partial<Carried>) =>
  site("/sessions/revoke", { body: { id }, ...by });

/** A session's row in D1, by the token its jar holds. */
async function rowOf(session: Jar) {
  const row = await env.DB.prepare(`SELECT id, updatedAt, expiresAt FROM session WHERE token = ?1`)
    .bind(tokenOf(session))
    .first<{ id: string; updatedAt: string; expiresAt: string }>();
  if (row === null) throw new Error("the jar's session has no row");
  return row;
}
const idOf = async (session: Jar) => (await rowOf(session)).id;

/** Who a jar's session reads as: a user id, or null once the session is gone. */
const readsAs = async (session: Jar): Promise<string | null> =>
  (await site("/get-session", { jar: session })).json?.user?.id ?? null;

/** Signs in again with a passkey, from a browser that names itself. */
async function signInFrom(device: Authenticator, userAgent: string) {
  const jar = new Jar();
  const headers = { "user-agent": userAgent };
  const challenge = await site("/passkey/generate-authenticate-options", { jar, headers });
  answered(challenge, 200);
  answered(
    await site("/passkey/verify-authentication", {
      body: { response: await device.get(challenge.json.challenge) },
      jar,
      headers,
    }),
    200,
  );
  return jar;
}

/**
 * Sets a session's row back in D1, as if Keel had last written it `minutes`
 * ago: its last write, and the expiry that write set.
 */
async function lastWritten(session: Jar, minutes: number): Promise<string> {
  const row = await rowOf(session);
  const back = (at: string) => new Date(new Date(at).getTime() - minutes * 60_000).toISOString();
  const written = back(new Date().toISOString());
  const { meta } = await env.DB.prepare(
    `UPDATE session SET updatedAt = ?1, expiresAt = ?2 WHERE id = ?3`,
  )
    .bind(written, back(row.expiresAt), row.id)
    .run();
  expect(meta.changes).toBe(1);
  return written;
}

function refused(answer: Answer, status: number, code: string) {
  expect([answer.status, answer.json?.code, answer.text]).toEqual([
    status,
    code,
    expect.anything(),
  ]);
}

describe("a person's own sessions, at /v1/auth/sessions", () => {
  /** One person signed in twice, the second time from a named browser, and another person. */
  let ada: { jar: Jar; again: Jar; first: string; second: string };
  let grace: { jar: Jar; only: string };

  beforeAll(async () => {
    const one = await signUpByPasskey(uniqueHandle("ses"));
    const again = await signInFrom(one.device, BROWSER);
    ada = { jar: one.jar, again, first: await idOf(one.jar), second: await idOf(again) };
    const other = await signUpByPasskey(uniqueHandle("ses"));
    grace = { jar: other.jar, only: await idOf(other.jar) };
  });

  it("[ba.sessions-list] lists a person every session of their own and none of anyone else's, by cookie and by bearer", async () => {
    for (const by of [byCookie(ada.jar), byBearer(ada.jar), byCookie(ada.again)])
      expect(ids(await listed(by))).toEqual([ada.first, ada.second].toSorted());
    expect(ids(await listed(byCookie(grace.jar)))).toEqual([grace.only]);
  });

  it("[ba.sessions-current] marks the one session that is asking", async () => {
    expect(await current(byCookie(ada.jar))).toEqual([ada.first]);
    expect(await current(byBearer(ada.jar))).toEqual([ada.first]);
    expect(await current(byCookie(ada.again))).toEqual([ada.second]);
  });

  it("[ba.sessions-device] says how each session was signed in, and the browser it was signed in from", async () => {
    const mine = await listed(byCookie(ada.jar));
    const second = mine.find((session) => session.id === ada.second);
    expect([second?.signedInBy, second?.userAgent]).toEqual(["passkey", BROWSER]);
    expect(mine.find((session) => session.id === ada.first)?.signedInBy).toBe("passkey");
  });

  it("[ba.sessions-no-token] reads no session's token to list them, and answers nothing but what the list names", async () => {
    const recording = recordingDb(env.DB);
    const { app } = makeIsolate({ ...env, DB: recording.db }, isolateLayer(env));
    const via = caller(async (request) => app.fetch(request, env, createExecutionContext()));
    // By bearer, so the read of the asking session is by the token the request
    // already holds: the only row that names a token is that one.
    const answer = await via("/sessions", byBearer(ada.jar));
    answered(answer, 200);
    const sessions: Listed[] = answer.json.sessions;
    expect(ids(sessions)).toEqual([ada.first, ada.second].toSorted());
    expect(recording.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(recording.rows)).not.toContain(tokenOf(ada.again));
    expect(answer.text).not.toContain(tokenOf(ada.again));
    expect(answer.text).not.toContain(tokenOf(ada.jar));
    for (const session of sessions)
      expect(Object.keys(session).toSorted()).toEqual([
        "createdAt",
        "current",
        "expiresAt",
        "id",
        "lastUsedAt",
        "signedInBy",
        "userAgent",
      ]);
  });

  it("[ba.sessions-revoke] ends the session a person names: it reads as nobody's from then on, and leaves the list", async () => {
    const person = await signUpByPasskey(uniqueHandle("ses"));
    const elsewhere = await signInByPasskey(person.device);
    const [here, there] = [await idOf(person.jar), await idOf(elsewhere)];
    expect(await readsAs(elsewhere)).not.toBeNull();
    answered(await end(there, byCookie(person.jar)), 200);
    expect(await readsAs(elsewhere)).toBeNull();
    expect(ids(await listed(byCookie(person.jar)))).toEqual([here]);
    expect(await readsAs(person.jar)).not.toBeNull();
  });

  it("[ba.sessions-own] ends no session of anyone else's: another person's id answers as one that was never there", async () => {
    const theirs = await end(grace.only, byCookie(ada.jar));
    refused(theirs, 404, "SESSION_NOT_FOUND");
    const nowhere = await end("ses_never", byCookie(ada.jar));
    expect([nowhere.status, nowhere.text]).toEqual([theirs.status, theirs.text]);
    expect(await readsAs(grace.jar)).not.toBeNull();
    expect(ids(await listed(byCookie(grace.jar)))).toEqual([grace.only]);
  });

  it("[ba.sessions-revoke-body] ends nothing for a request that names no session by a string: it is refused as malformed", async () => {
    for (const id of [undefined, 7, null, [grace.only], { id: grace.only }])
      expect((await end(id, byCookie(grace.jar))).status).toBe(400);
    expect(await readsAs(grace.jar)).not.toBeNull();
  });

  it("[ba.sessions-signed-in] answers nobody who is not signed in, and ends nothing for them", async () => {
    expect((await site("/sessions")).status).toBe(401);
    expect((await end(grace.only, {})).status).toBe(401);
    expect(await readsAs(grace.jar)).not.toBeNull();
  });

  it("[ba.sessions-expired] leaves a session past its expiry out of the list", async () => {
    const person = await signUpByPasskey(uniqueHandle("ses"));
    const lapsed = await signInByPasskey(person.device);
    const { meta } = await env.DB.prepare(`UPDATE session SET expiresAt = ?1 WHERE id = ?2`)
      .bind(new Date(Date.now() - 60_000).toISOString(), await idOf(lapsed))
      .run();
    expect(meta.changes).toBe(1);
    expect(ids(await listed(byCookie(person.jar)))).toEqual([await idOf(person.jar)]);
  });

  it("[ba.sessions-last-used] reads a session used over an hour after Keel last wrote it as used now, and one used sooner as it was", async () => {
    const person = await signUpByPasskey(uniqueHandle("ses"));
    const hours = await signInByPasskey(person.device);
    const minutes = await signInByPasskey(person.device);
    await lastWritten(hours, 120);
    const recent = await lastWritten(minutes, 10);
    const before = Date.now();
    expect(await readsAs(hours)).not.toBeNull();
    expect(await readsAs(minutes)).not.toBeNull();
    const mine = await listed(byCookie(person.jar));
    const used = async (session: Jar) => {
      const id = await idOf(session);
      return mine.find((row) => row.id === id)?.lastUsedAt ?? "";
    };
    expect(new Date(await used(hours)).getTime()).toBeGreaterThanOrEqual(before);
    expect(await used(minutes)).toBe(recent);
  });

  it("[ba.sessions-order] lists the session used last first", async () => {
    const person = await signUpByPasskey(uniqueHandle("ses"));
    const older = await signInByPasskey(person.device);
    const oldest = await signInByPasskey(person.device);
    await lastWritten(older, 20);
    await lastWritten(oldest, 40);
    expect((await listed(byCookie(person.jar))).map((session) => session.id)).toEqual([
      await idOf(person.jar),
      await idOf(older),
      await idOf(oldest),
    ]);
    await lastWritten(person.jar, 30);
    expect((await listed(byCookie(older))).map((session) => session.id)).toEqual([
      await idOf(older),
      await idOf(person.jar),
      await idOf(oldest),
    ]);
  });
});
