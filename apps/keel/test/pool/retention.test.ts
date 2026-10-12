import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Purged } from "../../src/adapters/driven/better-auth/retention.ts";
import worker from "../../src/index.ts";
import type { Answer, Jar } from "./auth-harness.ts";
import { answered, call, handled, signUpByPasskey, site } from "./auth-users.ts";

/** Better Auth's tables the cron purges, each by the count it logs for it. */
const TABLES = [
  ["session", "sessions"],
  ["verification", "verifications"],
  ["deviceCode", "deviceCodes"],
  ["invitation", "invitations"],
] as const;
type Table = (typeof TABLES)[number][0];

/** A date as Better Auth writes one to D1: `toISOString()`, ISO-8601 text in UTC. */
const BETTER_AUTH_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Row {
  readonly id: string;
  readonly expiresAt: unknown;
}

const rowsOf = async (table: Table) =>
  (await env.DB.prepare(`SELECT id, expiresAt FROM "${table}"`).all<Row>()).results;

/** Runs `act`, answering what it answered and the one row it added to `table`. */
async function adding<T>(table: Table, act: () => Promise<T>): Promise<[T, Row]> {
  const before = new Set((await rowsOf(table)).map((row) => row.id));
  const done = await act();
  const rows = (await rowsOf(table)).filter((row) => !before.has(row.id));
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error(`no ${table} row was added`);
  // Better Auth's own write, in the format the purge compares in.
  expect(row.expiresAt).toMatch(BETTER_AUTH_DATE);
  return [done, row];
}

/** Moves a row's expiry a minute into the past, in Better Auth's own format. */
async function lapse(table: Table, id: string): Promise<void> {
  const past = new Date(Date.now() - 60_000).toISOString();
  await env.DB.prepare(`UPDATE "${table}" SET expiresAt = ?2 WHERE id = ?1`).bind(id, past).run();
}

async function stillThere(table: Table, ids: readonly string[]): Promise<string[]> {
  const present = new Set((await rowsOf(table)).map((row) => row.id));
  return ids.filter((id) => present.has(id));
}

/** Each table's row count, by the name the purge logs it under. */
async function counts(): Promise<Record<string, number>> {
  return Object.fromEntries(
    await Promise.all(TABLES.map(async ([table, count]) => [count, (await rowsOf(table)).length])),
  );
}

/**
 * Runs the Worker's own scheduled handler as the cron fires it, and answers
 * the counts it logged, each held to the rows its table lost.
 */
async function purge(): Promise<Purged> {
  const before = await counts();
  const log = vi.spyOn(console, "log");
  try {
    const ctx = createExecutionContext();
    worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: "*/10 * * * *" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const line = log.mock.calls.find(([first]) => first === "retention purged");
    if (line === undefined) throw new Error("the cron logged no purge");
    const purged: Purged = JSON.parse(String(line[1]));
    const after = await counts();
    expect(purged).toEqual(
      Object.fromEntries(
        TABLES.map(([, count]) => [count, (before[count] ?? 0) - (after[count] ?? 0)]),
      ),
    );
    return purged;
  } finally {
    log.mockRestore();
  }
}

/** An email sign-in code, which Better Auth keeps as a verification row. */
async function sendCode(email: string): Promise<void> {
  const sent = await call("/email-otp/send-verification-otp", { body: { email, type: "sign-in" } });
  answered(sent, 200);
}

/** The CLI's device grant, started: a deviceCode row. */
async function startDevice(): Promise<void> {
  answered(await site("/device/code", { body: { client_id: "keeltown" } }), 200);
}

const invite = (jar: Jar, organizationId: string, handle: string) =>
  call("/organization/invite-member", {
    body: { organizationId, role: "member", handle },
    jar,
  });

const getInvitation = (jar: Jar, id: string) =>
  call(`/organization/get-invitation?id=${encodeURIComponent(id)}`, { jar });

function refused(answer: Answer, status: number, code: string) {
  expect([answer.status, answer.json?.code, answer.text]).toEqual([
    status,
    code,
    expect.anything(),
  ]);
}

describe("the retention cron", () => {
  it("[purge.sessions] deletes an expired session and keeps a live one", async () => {
    const [kit, expired] = await adding("session", () => signUpByPasskey("kit"));
    const [lou, live] = await adding("session", () => signUpByPasskey("lou"));
    await lapse("session", expired.id);

    expect((await purge()).sessions).toBe(1);
    expect(await stillThere("session", [expired.id, live.id])).toEqual([live.id]);
    const session = await site("/get-session", { jar: lou.jar });
    answered(session, 200);
    expect(session.json.user.username).toBe("lou");
    expect((await site("/get-session", { jar: kit.jar })).json).toBeNull();
  });

  it("[purge.verifications] deletes an expired sign-in code and keeps a live one", async () => {
    const [, expired] = await adding("verification", () => sendCode("old-code@example.com"));
    const [, live] = await adding("verification", () => sendCode("new-code@example.com"));
    await lapse("verification", expired.id);

    expect((await purge()).verifications).toBe(1);
    expect(await stillThere("verification", [expired.id, live.id])).toEqual([live.id]);
  });

  it("[purge.device-codes] deletes an expired device code and keeps a live one", async () => {
    const [, expired] = await adding("deviceCode", startDevice);
    const [, live] = await adding("deviceCode", startDevice);
    await lapse("deviceCode", expired.id);

    expect((await purge()).deviceCodes).toBe(1);
    expect(await stillThere("deviceCode", [expired.id, live.id])).toEqual([live.id]);
  });

  it("[purge.invitations] deletes lapsed and answered invitations and keeps a pending one, which its recipient then can't find", async () => {
    const owner = await handled("vic@example.com", "vic");
    const org = await call("/organization/create", {
      body: { name: "Vale", slug: "vale" },
      jar: owner.jar,
    });
    answered(org, 200);
    const vale: string = org.json.id;
    const xan = await signUpByPasskey("xan");
    const yul = await signUpByPasskey("yul");
    const abe = await signUpByPasskey("abe");
    await signUpByPasskey("wes");
    await signUpByPasskey("zia");
    const sent = async (handle: string) => {
      const [answer, row] = await adding("invitation", () => invite(owner.jar, vale, handle));
      answered(answer, 200);
      return row.id;
    };
    const lapsed = await sent("wes");
    const accepted = await sent("xan");
    const rejected = await sent("yul");
    const canceled = await sent("zia");
    const pending = await sent("abe");
    await lapse("invitation", lapsed);
    answered(
      await call("/organization/accept-invitation", {
        body: { invitationId: accepted },
        jar: xan.jar,
      }),
      200,
    );
    answered(
      await call("/organization/reject-invitation", {
        body: { invitationId: rejected },
        jar: yul.jar,
      }),
      200,
    );
    answered(
      await call("/organization/cancel-invitation", {
        body: { invitationId: canceled },
        jar: owner.jar,
      }),
      200,
    );
    refused(await getInvitation(xan.jar, accepted), 400, "INVITATION_ANSWERED");

    expect((await purge()).invitations).toBe(4);
    expect(await stillThere("invitation", [lapsed, accepted, rejected, canceled, pending])).toEqual(
      [pending],
    );
    // Deliberate: once purged, an answered invitation reads as one that never existed.
    refused(await getInvitation(xan.jar, accepted), 400, "INVITATION_NOT_FOUND");
    answered(await getInvitation(abe.jar, pending), 200);
  });
});
