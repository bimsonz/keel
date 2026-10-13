import { DeployTargetCheck } from "@keeltown/core/ports";
import { Effect, Exit, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_API,
  DeployTargetCheckCloudflare,
  type Fetcher,
} from "../../src/adapters/driven/deploy/cloudflare-api.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SECRET = "cf-token-that-must-stay-in-the-header";

/** Cloudflare's v4 envelope, as the account's subdomain read answers it. */
const envelope = (
  status: number,
  fields: { readonly codes?: readonly number[]; readonly subdomain?: string | null },
) =>
  Response.json(
    {
      success: status === 200,
      errors: (fields.codes ?? []).map((code) => ({ code, message: `error ${code}` })),
      messages: [],
      result: status === 200 ? { subdomain: fields.subdomain ?? null } : null,
    },
    { status },
  );

/** The adapter over a fetch that answers `answer` and records every request it was sent. */
function over(answer: () => Promise<Response>) {
  const sent: { readonly url: string; readonly init: RequestInit }[] = [];
  const fetch: Fetcher = (url, init) => {
    sent.push({ url, init });
    return answer();
  };
  const reach = DeployTargetCheck.use((check) => check.reach(ACCOUNT, Redacted.make(SECRET))).pipe(
    Effect.provide(DeployTargetCheckCloudflare({ fetch })),
  );
  return { sent, reach: () => Effect.runPromiseExit(reach) };
}

/** What a reach came to: the subdomain, or the refusal's reason and code. */
const outcomeOf = (exit: Awaited<ReturnType<ReturnType<typeof over>["reach"]>>) =>
  Exit.isSuccess(exit)
    ? { workersDev: exit.value.workersDev }
    : Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
      ? { reason: exit.cause.reasons[0].error.reason, code: exit.cause.reasons[0].error.code }
      : { defect: String(exit.cause) };

describe("the Cloudflare API's DeployTargetCheck", () => {
  it.each([
    {
      named: "200 with a subdomain",
      answer: () => envelope(200, { subdomain: "acme" }),
      outcome: { workersDev: "acme.workers.dev" },
    },
    {
      named: "404 with code 10007",
      answer: () => envelope(404, { codes: [10_007] }),
      outcome: { reason: "no-workers-dev", code: 10_007 },
    },
    {
      named: "200 with no subdomain",
      answer: () => envelope(200, { subdomain: null }),
      outcome: { reason: "no-workers-dev", code: undefined },
    },
    {
      named: "401 with no code",
      answer: () => envelope(401, {}),
      outcome: { reason: "token-invalid", code: undefined },
    },
    {
      named: "401 with code 9106",
      answer: () => envelope(401, { codes: [9106] }),
      outcome: { reason: "token-invalid", code: 9106 },
    },
    {
      named: "400 with code 10000",
      answer: () => envelope(400, { codes: [10_000] }),
      outcome: { reason: "token-invalid", code: 10_000 },
    },
    {
      named: "400 with code 9109",
      answer: () => envelope(400, { codes: [9109] }),
      outcome: { reason: "token-invalid", code: 9109 },
    },
    {
      named: "400 with codes 6003 and 6111",
      answer: () => envelope(400, { codes: [6003, 6111] }),
      outcome: { reason: "token-invalid", code: 6003 },
    },
    {
      named: "400 with code 6111",
      answer: () => envelope(400, { codes: [6111] }),
      outcome: { reason: "token-invalid", code: 6111 },
    },
    {
      named: "403 with code 10001",
      answer: () => envelope(403, { codes: [10_001] }),
      outcome: { reason: "account-unreachable", code: 10_001 },
    },
    {
      named: "403 with no code",
      answer: () => envelope(403, {}),
      outcome: { reason: "account-unreachable", code: undefined },
    },
    {
      named: "500 with code 10013",
      answer: () => envelope(500, { codes: [10_013] }),
      outcome: { reason: "account-unreachable", code: 10_013 },
    },
    {
      named: "502 with no envelope",
      answer: async () => new Response("<html>bad gateway</html>", { status: 502 }),
      outcome: { reason: "account-unreachable", code: undefined },
    },
    {
      named: "a failed request",
      answer: () => Promise.reject(new TypeError("network connection lost")),
      outcome: { reason: "account-unreachable", code: undefined },
    },
  ])("[cf-api.reach-codes] $named reads as the account answers it", async ({ answer, outcome }) => {
    const { reach } = over(async () => answer());
    expect(outcomeOf(await reach())).toEqual(outcome);
  });

  it("[cf-api.reach-codes] asks for the account's subdomain once, with the secret in the authorization header alone", async () => {
    const { sent, reach } = over(async () => envelope(200, { subdomain: "acme" }));
    await reach();
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe(`${CLOUDFLARE_API}/accounts/${ACCOUNT}/workers/subdomain`);
    expect(request?.init.method).toBe("GET");
    const headers = new Headers(request?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(request?.init.body).toBeUndefined();
    expect(request?.url.includes(SECRET)).toBe(false);
  });
});
