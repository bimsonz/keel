import { describe, expect, it } from "vitest";
import { type Io, run } from "../src/run.ts";

const D1 = "dec_01HZY8D1D1D1D1D1D1D1D1D1D1";
const G1 = "grd_01HZY8G1G1G1G1G1G1G1G1G1G1";
const AT = "2026-10-14T00:57:21.555Z";

/** One decision's chain as `why` answers it: the ruling, then the guard holding it, each an MFP 0.2 message in Keel's record. */
const chain = [
  {
    summary:
      "D-1 ruled premise-holds: The premise holds: authz.permission-evaluation freshness at-most per-request",
    record: {
      id: D1,
      author: { kind: "human", id: "user:usr_01HZY8R1R1R1R1R1R1R1R1R1R1" },
      at: AT,
      evidenceClass: "ruling",
      message: {
        mfp: "0.2",
        kind: "decision",
        profile: "https://keel.town/mfp/profile/1",
        chosen: "premise-holds",
        rationale: "The premise holds",
        alternatives: [],
        reversible: true,
        cites: [{ kind: "record", ref: G1 }],
      },
    },
  },
  {
    summary: "G-1 holds D-1: probe prb_01HZY8P1P1P1P1P1P1P1P1P1P1 told the worlds apart in 3 runs",
    record: {
      id: G1,
      author: { kind: "platform", id: "keel" },
      at: AT,
      evidenceClass: "proof",
      message: {
        mfp: "0.2",
        kind: "observation",
        profile: "https://keel.town/mfp/profile/1",
        category: "guard",
        importance: "high",
        summary: `Guard ${G1} upholds D-1`,
        cites: [{ kind: "record", ref: "prb_01HZY8P1P1P1P1P1P1P1P1P1P1" }],
      },
    },
  },
];

describe("keeltown why", () => {
  it("[why.cli] prints each decision's chain Keel answers, the next action to read it, and Keel's record of each MFP message", async () => {
    const asked: URL[] = [];
    const out: string[] = [];
    const io: Io = {
      env: {
        KEEL_URL: "https://keel.test",
        KEEL_CLIENT_ID: "client-a",
        KEEL_CLIENT_SECRET: "secret-a",
      },
      stdout: (line) => void out.push(line),
      stderr: () => {},
      fetch: async (url) => {
        if (url.endsWith("/v1/oauth/token"))
          return Response.json({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
        asked.push(new URL(url));
        return Response.json({
          ok: true,
          summary:
            "1 active decision explains authz.permission-evaluation, newest first: 2 records.",
          result: { chain },
          findings: [],
          next: [
            {
              kind: "read",
              title: `Read decision ${D1}`,
              operationId: "Memory_getDecision",
              args: { decisionId: D1 },
            },
          ],
          notices: [],
          cost: {},
        });
      },
    };

    expect(await run(["why", "--subject", "authz.permission-evaluation"], io)).toBe(0);

    expect(asked.map((url) => [url.pathname, url.searchParams.get("subject")])).toEqual([
      ["/v1/why", "authz.permission-evaluation"],
    ]);
    const printed = out.join("\n");
    expect(printed).toContain("D-1 ruled premise-holds");
    expect(printed).toContain("- G-1 holds D-1");
    expect(printed).toContain(
      `next: Read decision ${D1} [Memory_getDecision {"decisionId":"${D1}"}]`,
    );
    expect(printed).toContain(JSON.stringify(chain[1]?.record));
  });
});
