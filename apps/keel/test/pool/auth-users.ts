/**
 * People on keel.town for the auth pool tests: signed up by an email code or a
 * passkey, through keel.town's own entry or the same app with a mail sender.
 */
import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { type Answer, Authenticator, caller, Jar } from "./auth-harness.ts";

/** The codes Keel "sent", read back as an inbox would. */
export const outbox: { to: string; otp: string; type: string }[] = [];

/** keel.town as deployed: no mail sender yet, so no email codes. */
export const site = caller((request) => exports.default.fetch(request));

/** The same app with a mail sender, for the email-code sign-up. */
const mailing = makeIsolate(env, isolateLayer(env), {
  sendOtp: async (message) => {
    outbox.push(message);
  },
});
export const call = caller(async (request) =>
  mailing.app.fetch(request, env, createExecutionContext()),
);

/** Signs a new person up and in by an email code; the user has no handle yet. */
export async function signUpByCode(email: string, via = call) {
  const jar = new Jar();
  const sent = await via("/email-otp/send-verification-otp", { body: { email, type: "sign-in" } });
  answered(sent, 200);
  const otp = outbox.findLast((m) => m.to === email)?.otp;
  expect(otp).toMatch(/^\d{6}$/);
  const signed = await via("/sign-in/email-otp", { body: { email, otp }, jar });
  answered(signed, 200);
  const session = await via("/get-session", { jar });
  const userId: unknown = session.json.user.id;
  if (typeof userId !== "string") throw new Error(`no user in ${session.text}`);
  return { jar, signed, userId };
}

/** Signs up by email code and chooses a handle, which makes the personal org. */
export async function handled(email: string, handle: string) {
  const user = await signUpByCode(email);
  const set = await call("/update-user", { body: { username: handle }, jar: user.jar });
  answered(set, 200);
  return user;
}

/** Passkey-first sign-up through keel.town's own entry: the handle, then the passkey. */
export async function signUpByPasskey(handle: string) {
  const jar = new Jar();
  const device = new Authenticator();
  const options = await site(
    `/passkey/generate-register-options?context=${encodeURIComponent(handle)}`,
    { jar },
  );
  answered(options, 200);
  const registered = await site("/passkey/verify-registration", {
    body: { response: await device.create(options.json.challenge), createSession: true },
    jar,
  });
  answered(registered, 200);
  return { jar, device, registered };
}

/** The status, with the body beside it so a failure says why. */
export function answered(answer: Answer, status: number) {
  expect([answer.status, answer.text]).toEqual([status, expect.anything()]);
}
