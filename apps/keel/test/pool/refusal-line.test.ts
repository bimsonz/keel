import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The refusal lines `console.warn` was given; any other line is someone else's. */
const refusals = (calls: readonly (readonly unknown[])[]) =>
  calls.flatMap((line): unknown[] => {
    try {
      const parsed: unknown = JSON.parse(String(line[0]));
      return typeof parsed === "object" &&
        parsed !== null &&
        "ops" in parsed &&
        parsed.ops === "refused"
        ? [parsed]
        : [];
    } catch {
      return [];
    }
  });

describe("the line a refused request leaves at Keel's door", () => {
  it("[http.refusal-wired] names the refusal's status and code under the request id the caller was answered with", async () => {
    const warned = vi.spyOn(console, "warn");
    const response = await exports.default.fetch(
      `${BASE}/v1/namespaces/nobody-${crypto.randomUUID().slice(0, 8)}`,
    );
    expect(response.status).toBe(404);
    const body = await response.json<{ code: string; requestId: string }>();
    expect(refusals(warned.mock.calls)).toEqual([
      { ops: "refused", requestId: body.requestId, status: 404, code: body.code },
    ]);

    const fine = await exports.default.fetch(`${BASE}/healthz`);
    expect(fine.status).toBe(200);
    expect(refusals(warned.mock.calls)).toHaveLength(1);
  });
});
