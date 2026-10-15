import { afterEach, describe, expect, it, vi } from "vitest";
import { readWhy } from "../../../src/source/why.ts";

/** Keel's answer to `why` on S-2's require-permission.ts, cut to one decision and one record that is not one. */
const ANSWER = {
  ok: true,
  summary: "1 active decision explains src/authz/require-permission.ts, newest first: 2 records.",
  result: {
    chain: [
      {
        summary:
          "D-1 ruled premise-holds: The premise holds: authz.permission-evaluation freshness at-most per-request",
        record: {
          id: "dec_2F82DH6DE0PGDTFTXNR1BZ3SXC",
          at: "2026-10-14T15:15:24.350Z",
          message: { kind: "decision", chosen: "premise-holds" },
        },
      },
      {
        summary:
          "chg_01M4XFJS1QQJ5PTJJGD3Z9EZBV relies on authz.permission-evaluation freshness at-most per-request",
        record: { id: "cfl_5EER6ZGVV8CV1YZ1VR93612EM0.premise", at: "2026-10-14T15:13:14.000Z" },
      },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("why on a file", () => {
  it("[why.decisions] keeps the decisions Keel names for a path, and no other record of its chain", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(ANSWER), { status: 200 });
    });
    const decisions = await readWhy("prj_1", "src/authz/require-permission.ts");
    expect(asked).toEqual(["/v1/why?project=prj_1&path=src%2Fauthz%2Frequire-permission.ts"]);
    expect(decisions).toEqual([
      {
        id: "dec_2F82DH6DE0PGDTFTXNR1BZ3SXC",
        at: "2026-10-14T15:15:24.350Z",
        summary: ANSWER.result.chain[0]?.summary,
      },
    ]);
  });

  it("[why.none] names none where Keel answers no chain", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    expect(await readWhy("prj_1", "README.md")).toEqual([]);
  });
});
