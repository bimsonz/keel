// Spike 27: Better Auth on D1 in workerd, with passkeys, the device grant and email OTP.
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, bearer, deviceAuthorization, emailOTP, organization } from "better-auth/plugins";

export interface Env {
  readonly DB: D1Database;
  readonly AUTH_SECRET: string;
}

/** OTPs "sent" by email, read back by the test (a spike stands in for Cloudflare Email Service). */
export const outbox: { email: string; otp: string; type: string }[] = [];

export const ORIGIN = "http://localhost";

export function options(env: Env) {
  return {
    database: env.DB,
    secret: env.AUTH_SECRET,
    baseURL: ORIGIN,
    basePath: "/v1/auth",
    trustedOrigins: [ORIGIN],
    plugins: [
      emailOTP({
        async sendVerificationOTP({ email, otp, type }) {
          outbox.push({ email, otp, type });
        },
      }),
      passkey({ rpID: "localhost", rpName: "Keel", origin: ORIGIN }),
      deviceAuthorization({ verificationUri: `${ORIGIN}/device` }),
      bearer(),
      organization(),
      admin(),
    ],
  } satisfies Parameters<typeof betterAuth>[0];
}

export const auth = (env: Env) => betterAuth(options(env));

export async function migrate(env: Env) {
  const { runMigrations, toBeCreated } = await getMigrations(options(env));
  await runMigrations();
  return toBeCreated.map((t) => t.table);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return auth(env).handler(request);
  },
} satisfies ExportedHandler<Env>;
