// Automation accounts on a Keel, each made by the passkey sign-up any visitor
// does. A session goes to ~/.keel/<x>-session.json and its passkey to
// ~/.keel/<x>-passkey.json (both 0600; <x> is the handle without a leading
// `keel-`), so a lapsed session is signed in to again instead of losing the
// handle. It prints handles, ids, statuses and dates only: never a cookie, a
// token or a key. KEEL_URL overrides the site URL.
//   node scripts/accounts.ts <env> <handle…>                  sign up, or sign in again, whoever lacks a working session
//   node scripts/accounts.ts <env> --check <handle…>          read each session back through the gate
//   node scripts/accounts.ts <env> --renew <handle…>          a new session from the kept passkey
//   node scripts/accounts.ts <env> --invited <handle…>        each account's pending invitations
//   node scripts/accounts.ts <env> --accept <org> <handle…>   accept the one into <org>, as the account itself
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SavedPasskey } from "../packages/testing/src/passkey.ts";
import { siteHost } from "./env.ts";
import {
  type AccountSession,
  type SignedIn,
  signedIn,
  signIn,
  signUp,
  whoIs,
} from "./lib/account.ts";

const USAGE =
  "usage: node scripts/accounts.ts <env> [--check | --renew | --invited | --accept <org>] <handle…>";
const [environment = "", ...rest] = process.argv.slice(2);
const flag = rest[0]?.startsWith("--") ? rest.shift() : undefined;
const into = flag === "--accept" ? rest.shift() : undefined;
const handles = rest;
if (
  !/^[a-z][a-z0-9-]*$/.test(environment) ||
  handles.length === 0 ||
  handles.some((handle) => handle.startsWith("-")) ||
  ![undefined, "--check", "--renew", "--invited", "--accept"].includes(flag) ||
  (flag === "--accept" && into === undefined)
) {
  console.error(USAGE);
  process.exit(2);
}

const keelUrl = process.env["KEEL_URL"] ?? `https://${siteHost(environment)}`;
const dir = join(homedir(), ".keel");
const short = (handle: string) => handle.replace(/^keel-/, "");
const sessionFile = (handle: string) => join(dir, `${short(handle)}-session.json`);
const passkeyFile = (handle: string) => join(dir, `${short(handle)}-passkey.json`);

function writePrivate(file: string, value: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const readSession = (handle: string): AccountSession =>
  JSON.parse(readFileSync(sessionFile(handle), "utf8"));
const readPasskey = (handle: string): SavedPasskey =>
  JSON.parse(readFileSync(passkeyFile(handle), "utf8"));

function keep(handle: string, session: AccountSession): void {
  writePrivate(sessionFile(handle), session);
  console.log(
    `ok   ${handle}: ${session.userId}, org ${session.org}, session until ${session.expiresAt} in ${sessionFile(handle)}`,
  );
}

async function renew(handle: string): Promise<boolean> {
  const account = await signIn(keelUrl, handle, readPasskey(handle));
  writePrivate(passkeyFile(handle), account.passkey);
  keep(handle, account.session);
  return true;
}

async function ensure(handle: string): Promise<boolean> {
  if (existsSync(sessionFile(handle))) {
    const kept = readSession(handle);
    const gate = await whoIs(keelUrl, kept.token);
    if (gate.status === 200 && gate.handle === handle) {
      console.log(`ok   ${handle}: ${kept.userId} (session kept)`);
      return true;
    }
  }
  // A passkey with no working session is an account already made: sign in to it.
  if (existsSync(passkeyFile(handle))) return renew(handle);
  const account = await signUp(keelUrl, handle, {
    keep: (passkey) => writePrivate(passkeyFile(handle), passkey),
  });
  keep(handle, account.session);
  return true;
}

/** Each file read back through the gate, and a spoiled copy of its token refused. */
async function check(handle: string): Promise<boolean> {
  const { token } = readSession(handle);
  const real = await whoIs(keelUrl, token);
  const spoiled = await whoIs(keelUrl, `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`);
  const ok = real.status === 200 && real.handle === handle && spoiled.status === 401;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${handle}: its token reads ${real.status} ${real.handle ?? ""}, a spoiled token reads ${spoiled.status}; passkey ${existsSync(passkeyFile(handle)) ? "kept" : "MISSING"}`,
  );
  return ok;
}

interface Invitation {
  readonly id: string;
  readonly org: string;
  readonly role: string;
  readonly inviter: string;
}

/** A browser signed in to the account, the sign-in counted in its passkey file. */
async function browserFor(handle: string): Promise<SignedIn> {
  const browser = await signedIn(keelUrl, readPasskey(handle));
  writePrivate(passkeyFile(handle), browser.passkey);
  return browser;
}

/** The account's pending invitations, each read as the account reads it. */
async function pending({ site, jar }: SignedIn): Promise<Invitation[]> {
  const listed = await site("/organization/list-user-invitations", { jar });
  if (listed.status !== 200) throw new Error(`its invitations answered ${listed.status}`);
  const found: Invitation[] = [];
  for (const row of Array.isArray(listed.json) ? listed.json : []) {
    if (row?.status !== "pending") continue;
    const one = await site(`/organization/get-invitation?id=${encodeURIComponent(row.id)}`, {
      jar,
    });
    if (one.status !== 200) throw new Error(`an invitation answered ${one.status}`);
    found.push({
      id: String(row.id),
      org: String(one.json.organizationSlug),
      role: String(one.json.role),
      inviter: String(one.json.inviterHandle),
    });
  }
  return found;
}

/** Ends the browser's own session, leaving the account's others alone. */
const signOut = ({ site, jar }: SignedIn) => site("/sign-out", { jar, body: {} });

async function invited(handle: string): Promise<boolean> {
  const browser = await browserFor(handle);
  const waiting = (await pending(browser)).map(
    (invitation) => `${invitation.org} as ${invitation.role} from ${invitation.inviter}`,
  );
  await signOut(browser);
  const { orgs } = await whoIs(keelUrl, readSession(handle).token);
  console.log(
    `ok   ${handle}: ${waiting.length === 0 ? "no pending invitation" : waiting.join("; ")}; orgs ${JSON.stringify(orgs)}`,
  );
  return true;
}

/** Accepts the account's invitation into `org`, and reads its role there through the gate before and after. */
async function accept(handle: string, org: string): Promise<boolean> {
  const { token } = readSession(handle);
  const before = (await whoIs(keelUrl, token)).orgs[org];
  if (before !== undefined) {
    console.log(`ok   ${handle}: already ${before} of ${org}`);
    return true;
  }
  const browser = await browserFor(handle);
  const invitation = (await pending(browser)).find((one) => one.org === org);
  if (invitation === undefined) {
    await signOut(browser);
    throw new Error(`${handle}: no pending invitation into ${org}`);
  }
  const accepted = await browser.site("/organization/accept-invitation", {
    jar: browser.jar,
    body: { invitationId: invitation.id },
  });
  await signOut(browser);
  const after = (await whoIs(keelUrl, token)).orgs[org];
  const ok = accepted.status === 200 && after === invitation.role;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${handle}: invited by ${invitation.inviter} as ${invitation.role}; accept answered ${accepted.status}; the gate read no role in ${org} before and reads ${after ?? "none"} after`,
  );
  return ok;
}

const act: (handle: string) => Promise<boolean> =
  flag === "--check"
    ? check
    : flag === "--renew"
      ? renew
      : flag === "--invited"
        ? invited
        : flag === "--accept"
          ? (handle) => accept(handle, into ?? "")
          : ensure;

let failures = 0;
for (const handle of handles) {
  try {
    if (!(await act(handle))) failures += 1;
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${handle}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
