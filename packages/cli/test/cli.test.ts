import { describe, expect, it } from "vitest";
import { run } from "../src/run.ts";

/** A fake Keel that records requests; `respond` scripts each non-token answer. */
function fakeKeel(respond: (url: string, init: RequestInit) => Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    env: {
      KEEL_URL: "https://keel.test",
      KEEL_CLIENT_ID: "client-a",
      KEEL_CLIENT_SECRET: "secret-a",
    },
    stdout: (line: string) => void out.push(line),
    stderr: (line: string) => void err.push(line),
    fetch: async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/oauth/token"))
        return Response.json({
          access_token: "t",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "agent:work",
        });
      requests.push({ url, init });
      return respond(url, init);
    },
  };
  return { io, requests, out, err };
}

const envelope = {
  ok: true,
  summary: "Submission chg_1 is verifying.",
  result: { state: "verifying" },
};

describe("keeltown", () => {
  it("[cli.status] waits as asked and prints Keel's answer as JSON with --json", async () => {
    const keel = fakeKeel(() => Response.json(envelope));
    expect(await run(["status", "chg_1", "--wait", "20", "--json"], keel.io)).toBe(0);
    expect(keel.requests.map((r) => r.url)).toEqual([
      "https://keel.test/v1/changes/chg_1/submission?wait=20",
    ]);
    expect(JSON.parse(keel.out.join("\n"))).toEqual(envelope);
  });

  it("[cli.declare] declares with the goal, footprint and key given, and prints the summary", async () => {
    const keel = fakeKeel(() => Response.json({ ...envelope, summary: "Declared chg_2." }));
    const code = await run(
      [
        "declare",
        "--goal",
        "Cache lookups",
        "--footprint",
        "src/authz.ts",
        "--footprint",
        "src/new.ts:create",
        "--key",
        "key-0003",
      ],
      keel.io,
    );
    expect(code).toBe(0);
    const [declare] = keel.requests;
    expect(new Headers(declare?.init.headers).get("idempotency-key")).toBe("key-0003");
    const body = declare?.init.body;
    expect(JSON.parse(typeof body === "string" ? body : "null")).toEqual({
      goal: "Cache lookups",
      footprint: [
        { path: "src/authz.ts", op: "edit" },
        { path: "src/new.ts", op: "create" },
      ],
      premises: [],
    });
    expect(keel.out).toEqual(["Declared chg_2."]);
  });

  it("[cli.problem] prints a refusal's code and next actions and exits 1", async () => {
    const keel = fakeKeel(
      () =>
        new Response(
          JSON.stringify({
            type: "urn:keel:problem:change.lease_stale",
            title: "stale",
            status: 409,
            code: "change.lease_stale",
            detail: "The lease is not the change's active lease.",
            requestId: "req-9",
            nextActions: [{ kind: "call", title: "Adopt the change", operationId: "adopt" }],
          }),
          { status: 409, headers: { "content-type": "application/problem+json" } },
        ),
    );
    const code = await run(
      ["submit", "--change", "chg_1", "--commit", "a".repeat(40), "--lease", "lse_old"],
      keel.io,
    );
    expect(code).toBe(1);
    expect(keel.err.join("\n")).toContain("change.lease_stale");
    expect(keel.err.join("\n")).toContain("next: Adopt the change [adopt]");
  });

  it("refuses a command line it cannot read with usage and exit 2, before calling Keel", async () => {
    const keel = fakeKeel(() => Response.json(envelope));
    expect(await run(["submit", "--change", "chg_1"], keel.io)).toBe(2);
    expect(await run(["frobnicate"], keel.io)).toBe(2);
    expect(keel.requests).toEqual([]);
  });
});
