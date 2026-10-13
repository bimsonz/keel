import { readFileSync } from "node:fs";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  checkPinnedName,
  jsoncToJson,
  parseDeploySpec,
  previewAlias,
  UNCARRIED_KEYS,
  WorkerName,
  wranglerFacts,
} from "../../../src/domain/delivery/index.ts";
import { ChangeId } from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

const fixture = (path: string): string =>
  readFileSync(new URL(`../../../../../fixtures/worker-lite/${path}`, import.meta.url), "utf8");

const SPEC = {
  target: "production",
  worker: "worker-lite",
  smoke: [{ path: "/health", status: 200, contains: "ok" }],
};
const parse = (spec: unknown) => parseDeploySpec(JSON.stringify(spec));
const reason = <A, E extends { readonly reason: string }>(r: Result.Result<A, E>): string =>
  Result.isFailure(r) ? r.failure.reason : "ok";

const CONFIG = `{
  // the Worker
  "name": "worker-lite", /* its entry */ "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "vars": { "GREETING": "hi // not a comment", "URL": "https://x.example/*y*/", },
}`;

describe("a project's deploy spec", () => {
  it("[deploy-spec.parse] reads the fields Keel deploys by and refuses anything else", () => {
    expect(Result.isSuccess(parse(SPEC))).toBe(true);
    expect(Result.isSuccess(parse({ ...SPEC, path: "apps/console" }))).toBe(true);
    for (const bad of [
      { ...SPEC, smoke: [] },
      { ...SPEC, smoke: Array.from({ length: 9 }, () => SPEC.smoke[0]) },
      { ...SPEC, smoke: [{ path: "health", status: 200 }] },
      { ...SPEC, smoke: [{ path: "/health", status: 99 }] },
      { ...SPEC, smoke: [{ path: "/health", status: 200.5 }] },
      { ...SPEC, worker: "Worker-Lite" },
      { ...SPEC, worker: "-worker" },
      { ...SPEC, target: "Production" },
      { ...SPEC, path: "../elsewhere" },
      { ...SPEC, path: "/abs" },
      { ...SPEC, path: "apps/../.." },
      { target: SPEC.target, smoke: SPEC.smoke },
    ])
      expect([bad, Result.isFailure(parse(bad))]).toEqual([bad, true]);
    expect(Result.isFailure(parseDeploySpec("{"))).toBe(true);
  });

  it("[deploy-spec.fixture] worker-lite's spec pins the Worker its wrangler config names", () => {
    const spec = Result.getOrThrow(parseDeploySpec(fixture(".keel/deploy.json")));
    const facts = Result.getOrThrow(wranglerFacts("wrangler.jsonc", fixture("wrangler.jsonc")));
    expect(Result.isSuccess(checkPinnedName(spec, facts))).toBe(true);
    expect(facts).toEqual({
      name: "worker-lite",
      main: "src/index.ts",
      compatibilityDate: "2026-10-01",
      compatibilityFlags: [],
      vars: { GREETING: "hello from worker-lite" },
    });
  });
});

describe("a Worker's wrangler config", () => {
  it("[wrangler.jsonc] drops comments and trailing commas and leaves strings as written", () => {
    expect(JSON.parse(jsoncToJson(CONFIG))).toEqual({
      name: "worker-lite",
      main: "src/index.ts",
      compatibility_date: "2026-10-01",
      vars: { GREETING: "hi // not a comment", URL: "https://x.example/*y*/" },
    });
    expect(JSON.parse(jsoncToJson(`{"a": "say \\"hi\\", // still text", "b": [1, 2,],}`))).toEqual({
      a: 'say "hi", // still text',
      b: [1, 2],
    });
  });

  it("[wrangler.refuses-bindings] a config naming a binding Keel does not send is refused, naming it", () => {
    for (const key of UNCARRIED_KEYS) {
      const config = `{"name": "w", "main": "i.js", "compatibility_date": "2026-10-01", "${key}": []}`;
      const facts = wranglerFacts("wrangler.jsonc", config);
      expect([key, reason(facts)]).toEqual([key, "uncarried-binding"]);
      expect(Result.isFailure(facts) && facts.failure.detail.includes(key)).toBe(true);
    }
    expect(reason(wranglerFacts("wrangler.jsonc", CONFIG))).toBe("ok");
  });

  it("[wrangler.incomplete] a config without a name, an entry or a compatibility date is refused, and TOML is not read yet", () => {
    expect(
      reason(
        wranglerFacts("wrangler.jsonc", `{"main": "i.js", "compatibility_date": "2026-10-01"}`),
      ),
    ).toBe("incomplete");
    expect(
      reason(wranglerFacts("wrangler.jsonc", `{"name": "w", "compatibility_date": "2026-10-01"}`)),
    ).toBe("incomplete");
    expect(reason(wranglerFacts("wrangler.jsonc", `{"name": "w", "main": "i.js"}`))).toBe(
      "incomplete",
    );
    expect(reason(wranglerFacts("wrangler.jsonc", "[1]"))).toBe("unreadable");
    expect(reason(wranglerFacts("wrangler.toml", `name = "w"`))).toBe("toml-not-yet");
  });

  it("[deploy-spec.pinned-name] a candidate whose config names another Worker is refused", () => {
    const spec = Result.getOrThrow(parse(SPEC));
    const facts = Result.getOrThrow(wranglerFacts("wrangler.jsonc", CONFIG));
    expect(Result.isSuccess(checkPinnedName(spec, facts))).toBe(true);
    const renamed = checkPinnedName(spec, { ...facts, name: "billing-api" });
    expect(Result.isFailure(renamed) && renamed.failure).toMatchObject({
      pinned: "worker-lite",
      named: "billing-api",
    });
  });
});

describe("a change's preview alias", () => {
  const workerName = Schema.decodeUnknownSync(WorkerName);
  const changeId = Schema.decodeUnknownSync(ChangeId);
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const changeArb = fc
    .array(fc.constantFrom(...crockford.split("")), { minLength: 26, maxLength: 26 })
    .map((chars) => changeId(`chg_${chars.join("")}`));
  const workerArb = fc
    .integer({ min: 1, max: 63 })
    .map((length) => workerName(length === 1 ? "w" : `w${"x".repeat(length - 2)}1`));

  it("[alias.dns-label] fits one DNS label beside its Worker's name, or there is none", () => {
    fc.assert(
      fc.property(changeArb, workerArb, (change, worker) => {
        const alias = previewAlias(change, worker);
        const fits = 3 + 10 + 1 + worker.length <= 63;
        expect({
          given: alias !== undefined,
          shaped: alias === undefined || /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(alias),
          label: alias === undefined ? 0 : alias.length + 1 + worker.length,
          stable: previewAlias(change, worker) === alias,
        }).toEqual({
          given: fits,
          shaped: true,
          label: fits ? 3 + 10 + 1 + worker.length : 0,
          stable: true,
        });
      }),
    );
  });

  it("[alias.per-change] two changes get two aliases", () => {
    const worker = workerName("worker-lite");
    const a = previewAlias(changeId(`chg_${"0".repeat(25)}1`), worker);
    const b = previewAlias(changeId(`chg_${"0".repeat(25)}2`), worker);
    expect(a).toBe("ch-0000000001");
    expect(b).toBe("ch-0000000002");
  });
});
