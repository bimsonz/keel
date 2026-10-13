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

/** The one request a command made: its URL, method, headers and parsed body. */
const only = (requests: { url: string; init: RequestInit }[]) => {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  const body = request?.init.body;
  return {
    url: request?.url,
    method: request?.init.method,
    headers: new Headers(request?.init.headers),
    body: JSON.parse(typeof body === "string" ? body : "null"),
  };
};

describe("keeltown", () => {
  it("[cli.session] a user's session governs: project create sends its namespace under the session as a bearer, and enrol needs its project", async () => {
    const keel = fakeKeel(() =>
      Response.json(
        {
          id: "prj_1",
          namespace: { handle: "keel", kind: "org" },
          name: "forge",
          visibility: "private",
        },
        { status: 201 },
      ),
    );
    const session = { ...keel.io, env: { KEEL_URL: "https://keel.test", KEEL_SESSION: "sess-1" } };
    expect(
      await run(
        [
          "project",
          "create",
          "--namespace",
          "keel",
          "--name",
          "forge",
          "--source",
          "fixture",
          "--json",
        ],
        session,
      ),
    ).toBe(0);
    const sent = only(keel.requests);
    expect([sent.url, sent.headers.get("authorization"), sent.body]).toEqual([
      "https://keel.test/v1/projects",
      "Bearer sess-1",
      { namespace: "keel", name: "forge", source: "fixture" },
    ]);
    expect(await run(["agent", "enrol", "--name", "a1", "--scope", "agent:work"], session)).toBe(2);
    expect(keel.err.join("\n")).toContain("--project");
    expect(
      await run(
        ["agent", "enrol", "--project", "prj_1", "--name", "a1", "--scope", "operator"],
        session,
      ),
    ).toBe(2);
  });

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

  it("[cli.enrol] enrols an agent in the project given", async () => {
    const keel = fakeKeel(() => Response.json({ agent: {}, clientId: "c", clientSecret: "s" }));
    const code = await run(
      [
        "agent",
        "enrol",
        "--name",
        "worker",
        "--scope",
        "agent:work",
        "--project",
        "prj_1",
        "--key",
        "key-0004",
      ],
      keel.io,
    );
    expect(code).toBe(0);
    const body = keel.requests[0]?.init.body;
    expect(JSON.parse(typeof body === "string" ? body : "null")).toEqual({
      name: "worker",
      kind: "interactive",
      scopes: ["agent:work"],
      projectId: "prj_1",
    });
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

  it("[cli.abandon] withdraws under the lease given, with the reason and key; without a lease, prints Keel's refusal and exits 1", async () => {
    const refusal = {
      type: "urn:keel:problem:request.invalid",
      title: "invalid",
      status: 400,
      code: "request.invalid",
      detail: "Only the holder of chg_1's lease, or an operator, may abandon it.",
      requestId: "req-7",
      nextActions: [
        { kind: "call", title: "Abandon again with the keel-lease header", operationId: "abandon" },
      ],
    };
    const keel = fakeKeel((_url, init) =>
      new Headers(init.headers).has("keel-lease")
        ? Response.json({ ...envelope, summary: "Withdrew chg_1; its workspace is released." })
        : new Response(JSON.stringify(refusal), {
            status: 400,
            headers: { "content-type": "application/problem+json" },
          }),
    );
    const withdrawn = await run(
      [
        "abandon",
        "chg_1",
        "--reason",
        "A smaller change does it",
        "--lease",
        "lse_1",
        "--key",
        "key-0005",
      ],
      keel.io,
    );
    const refused = await run(["abandon", "chg_1"], keel.io);
    const [abandon] = keel.requests;
    const headers = new Headers(abandon?.init.headers);
    const body = abandon?.init.body;

    expect(withdrawn).toBe(0);
    expect(abandon?.url).toBe("https://keel.test/v1/changes/chg_1/abandon");
    expect(abandon?.init.method).toBe("POST");
    expect(headers.get("keel-lease")).toBe("lse_1");
    expect(headers.get("idempotency-key")).toBe("key-0005");
    expect(JSON.parse(typeof body === "string" ? body : "null")).toEqual({
      reason: "A smaller change does it",
    });
    expect(keel.out).toEqual(["Withdrew chg_1; its workspace is released."]);
    expect(refused).toBe(1);
    expect(keel.err.join("\n")).toContain("request.invalid");
    expect(keel.err.join("\n")).toContain(
      "next: Abandon again with the keel-lease header [abandon]",
    );
    expect(await run(["abandon"], keel.io)).toBe(2);
    expect(keel.requests).toHaveLength(2);
  });

  const PREMISE = {
    subject: "authz.permissions",
    predicate: "idempotent",
    relation: "is",
    value: true,
  };

  it("[cli.session] opens a session for the harness and model given, under the key", async () => {
    const keel = fakeKeel(() => Response.json({ id: "ses_1" }));
    const code = await run(
      ["session", "open", "--harness", "h", "--model", "m", "--key", "key-0006"],
      keel.io,
    );
    const sent = only(keel.requests);
    expect(code).toBe(0);
    expect(sent).toMatchObject({ url: "https://keel.test/v1/sessions", method: "POST" });
    expect(sent.headers.get("idempotency-key")).toBe("key-0006");
    expect(sent.body).toEqual({ harness: "h", model: "m" });
  });

  it("[cli.revise] revises at the revision given, under the lease, with the premises parsed", async () => {
    const keel = fakeKeel(() => Response.json(envelope));
    const code = await run(
      [
        "revise",
        "chg_1",
        "--lease",
        "lse_1",
        "--if-match",
        "3",
        "--goal",
        "g2",
        "--add-premise",
        JSON.stringify(PREMISE),
      ],
      keel.io,
    );
    const sent = only(keel.requests);
    expect(code).toBe(0);
    expect(sent.url).toBe("https://keel.test/v1/changes/chg_1/revisions");
    expect(sent.headers.get("if-match")).toBe('"3"');
    expect(sent.headers.get("keel-lease")).toBe("lse_1");
    expect(sent.body).toEqual({ goal: "g2", premisesAdded: [PREMISE], premisesRetracted: [] });
    expect(await run(["revise", "chg_1", "--lease", "lse_1"], keel.io)).toBe(2);
    expect(
      await run(
        ["revise", "chg_1", "--lease", "l", "--if-match", "1", "--add-premise", "{"],
        keel.io,
      ),
    ).toBe(2);
    expect(keel.requests).toHaveLength(1);
  });

  it("[cli.rely] relies on the premise given, under the lease", async () => {
    const keel = fakeKeel(() => Response.json(envelope));
    const code = await run(
      ["rely", "chg_1", "--lease", "lse_1", "--premise", JSON.stringify(PREMISE)],
      keel.io,
    );
    const sent = only(keel.requests);
    expect(code).toBe(0);
    expect(sent.url).toBe("https://keel.test/v1/changes/chg_1/premises");
    expect(sent.headers.get("keel-lease")).toBe("lse_1");
    expect(sent.body).toEqual({ premise: PREMISE });
  });

  it("[cli.nearby] reads what is near a change", async () => {
    const keel = fakeKeel(() => Response.json(envelope));
    expect(await run(["nearby", "chg_1"], keel.io)).toBe(0);
    expect(only(keel.requests)).toMatchObject({
      url: "https://keel.test/v1/changes/chg_1/nearby",
      method: "GET",
    });
  });

  it("[cli.rebase] rebases under the lease and key given", async () => {
    const keel = fakeKeel(() => Response.json(envelope));
    const code = await run(["rebase", "chg_1", "--lease", "lse_1", "--key", "key-0007"], keel.io);
    const sent = only(keel.requests);
    expect(code).toBe(0);
    expect(sent).toMatchObject({
      url: "https://keel.test/v1/changes/chg_1/rebase",
      method: "POST",
    });
    expect(sent.headers.get("keel-lease")).toBe("lse_1");
    expect(sent.headers.get("idempotency-key")).toBe("key-0007");
    expect(await run(["rebase", "chg_1"], keel.io)).toBe(2);
  });

  it("[cli.adopt] adopts under the key given, with no lease", async () => {
    const keel = fakeKeel(() => Response.json(envelope));
    const code = await run(["adopt", "chg_1", "--key", "key-0008"], keel.io);
    const sent = only(keel.requests);
    expect(code).toBe(0);
    expect(sent).toMatchObject({ url: "https://keel.test/v1/changes/chg_1/adopt", method: "POST" });
    expect(sent.headers.get("idempotency-key")).toBe("key-0008");
    expect(sent.headers.has("keel-lease")).toBe(false);
  });

  it("refuses a command line it cannot read with usage and exit 2, before calling Keel", async () => {
    const keel = fakeKeel(() => Response.json(envelope));
    expect(await run(["submit", "--change", "chg_1"], keel.io)).toBe(2);
    expect(await run(["frobnicate"], keel.io)).toBe(2);
    expect(keel.requests).toEqual([]);
  });
});
