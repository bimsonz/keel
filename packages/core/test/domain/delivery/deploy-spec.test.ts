import { readFileSync } from "node:fs";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  checkPinnedName,
  jsoncToJson,
  parseDeploySpec,
  PreviewOrigin,
  previewAlias,
  type SmokeCheck,
  smokeUrl,
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

const check = (path: string): SmokeCheck => ({ path, status: 200 });
const pathOf = (path: string) => parse({ ...SPEC, smoke: [check(path)] });

// Written out here, not read from the module, so a key moved between the lists is caught.
const TAKEN = [
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "vars",
  "account_id",
  "compliance_region",
  "dev",
  "env",
  "logpush",
  "observability",
  "preview_urls",
  "route",
  "routes",
  "send_metrics",
  "triggers",
  "upload_source_maps",
  "workers_dev",
];

// wrangler 4.149's other top-level keys: each declares a binding or resource, is carried by a version, or changes the bundle.
const WRANGLER_REFUSED = [
  // Settings a version carries that Keel's upload does not yet, and one that changes the bundle.
  "keep_vars",
  "limits",
  "minify",
  "placement",
  "access",
  "addresses",
  "agent_memory",
  "ai",
  "ai_search",
  "ai_search_namespaces",
  "alias",
  "analytics",
  "analytics_engine_datasets",
  "artifacts",
  "assets",
  "base_dir",
  "browser",
  "build",
  "cache",
  "cloudchamber",
  "connect",
  "containers",
  "d1_databases",
  "data_blobs",
  "define",
  "dependencies_instrumentation",
  "dispatch_namespaces",
  "durable_objects",
  "exports",
  "find_additional_modules",
  "first_party_worker",
  "flagship",
  "hyperdrive",
  "images",
  "jsx_factory",
  "jsx_fragment",
  "k2",
  "keep_names",
  "kv_namespaces",
  "logfwdr",
  "media",
  "migrations",
  "mtls_certificates",
  "no_bundle",
  "pages_build_output_dir",
  "pipelines",
  "preserve_file_names",
  "previews",
  "python_modules",
  "queues",
  "r2_buckets",
  "ratelimits",
  "rules",
  "secrets",
  "secrets_store_secrets",
  "send_email",
  "services",
  "site",
  "stream",
  "streaming_tail_consumers",
  "tail_consumers",
  "text_blobs",
  "tsconfig",
  "unsafe",
  "unsafe_hello_world",
  "vectorize",
  "version_metadata",
  "vpc_networks",
  "vpc_services",
  "wasm_modules",
  "worker_loaders",
  "workflows",
];

const withKey = (key: string) =>
  wranglerFacts(
    "wrangler.jsonc",
    JSON.stringify({ name: "w", main: "i.js", compatibility_date: "2026-10-01", [key]: [] }),
  );

const factsWith = (fields: object) =>
  wranglerFacts(
    "wrangler.jsonc",
    JSON.stringify({ name: "w", main: "i.js", compatibility_date: "2026-10-01", ...fields }),
  );

const refusedNaming = (key: string): boolean => {
  const facts = withKey(key);
  const named = Result.isFailure(facts) ? /declares (.*), which/.exec(facts.failure.detail) : null;
  return reason(facts) === "uncarried-key" && (named?.[1]?.split(", ") ?? []).includes(key);
};

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

  it("[deploy-spec.bounds] each limit takes its last value and refuses the next", () => {
    const smoke = (fields: object) => ({
      ...SPEC,
      smoke: [{ path: "/health", status: 200, ...fields }],
    });
    const cases: readonly (readonly [string, unknown, boolean])[] = [
      ["worker of 63", { ...SPEC, worker: `w${"x".repeat(61)}1` }, true],
      ["worker of 64", { ...SPEC, worker: `w${"x".repeat(62)}1` }, false],
      ["worker of 1", { ...SPEC, worker: "w" }, true],
      ["worker ending in a hyphen", { ...SPEC, worker: "worker-" }, false],
      ["worker starting upper-case", { ...SPEC, worker: "Worker-lite" }, false],
      ["worker with an underscore", { ...SPEC, worker: "my_worker" }, false],
      ["8 smoke checks", { ...SPEC, smoke: Array.from({ length: 8 }, () => SPEC.smoke[0]) }, true],
      ["9 smoke checks", { ...SPEC, smoke: Array.from({ length: 9 }, () => SPEC.smoke[0]) }, false],
      ["status 100", smoke({ status: 100 }), true],
      ["status 599", smoke({ status: 599 }), true],
      ["status 600", smoke({ status: 600 }), false],
      ["contains of 1", smoke({ contains: "o" }), true],
      ["contains empty", smoke({ contains: "" }), false],
      ["contains of 200", smoke({ contains: "x".repeat(200) }), true],
      ["contains of 201", smoke({ contains: "x".repeat(201) }), false],
      ["smoke path of 256", smoke({ path: `/${"a".repeat(255)}` }), true],
      ["smoke path of 257", smoke({ path: `/${"a".repeat(256)}` }), false],
      ["path of 200", { ...SPEC, path: "a".repeat(200) }, true],
      ["path of 201", { ...SPEC, path: "a".repeat(201) }, false],
      ["path a dotted name", { ...SPEC, path: "apps/.config" }, true],
      ["path ..", { ...SPEC, path: ".." }, false],
      ["path ending in ..", { ...SPEC, path: "apps/.." }, false],
      ["path .", { ...SPEC, path: "." }, false],
      ["path through .", { ...SPEC, path: "apps/./console" }, false],
      ["path empty", { ...SPEC, path: "" }, false],
    ];
    expect(cases.map(([name, spec]) => [name, Result.isSuccess(parse(spec))])).toEqual(
      cases.map(([name, , ok]) => [name, ok]),
    );
  });

  it("[deploy-spec.unknown-keys] a key Keel does not read is refused, naming it, not dropped", () => {
    for (const [bad, key] of [
      [{ ...SPEC, Path: "apps/console" }, "Path"],
      [{ ...SPEC, smoke: [{ path: "/health", status: 200, contians: "ok" }] }, "contians"],
    ] as const) {
      const read = parse(bad);
      expect([key, Result.isFailure(read) && read.failure.detail.includes(key)]).toEqual([
        key,
        true,
      ]);
    }
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

describe("a smoke check's address", () => {
  const PREVIEW = Schema.decodeUnknownSync(PreviewOrigin)(
    "https://ch-0000000001-worker-lite.owner.workers.dev",
  );
  const host = new URL(PREVIEW).host;

  it("[smoke.same-host] a path that would leave the preview's host is refused, by the spec and again where its address is made", () => {
    for (const path of [
      "//evil.example/x",
      "/\\evil.example/x",
      "/\\/evil.example",
      "/\\\\evil.example",
      "/a\\b",
      "/\t/evil.example/x",
    ])
      expect([path, Result.isFailure(pathOf(path))]).toEqual([path, true]);
    for (const path of ["@evil.example/x", ".evil.example", ":443@evil.example", "evil.example"]) {
      const url = smokeUrl(PREVIEW, check(path));
      expect([path, Result.isFailure(url) && url.failure._tag]).toEqual([path, "SmokePathOffHost"]);
    }
    expect(Result.getOrThrow(smokeUrl(PREVIEW, check("/health?x=1")))).toBe(
      `${PREVIEW}/health?x=1`,
    );
  });

  it("[smoke.preview-origin] a preview's address is a bare https origin: no trailing slash, path, user or port", () => {
    const takes = (url: string) => Result.isSuccess(Schema.decodeUnknownResult(PreviewOrigin)(url));
    const cases: readonly (readonly [string, boolean])[] = [
      [PREVIEW, true],
      ["https://abcd1234-worker-lite.owner.workers.dev", true],
      [`${PREVIEW}/`, false],
      [`${PREVIEW}/x`, false],
      ["http://worker-lite.owner.workers.dev", false],
      ["https://user@worker-lite.owner.workers.dev", false],
      ["https://worker-lite.owner.workers.dev:8443", false],
      ["https://localhost", false],
    ];
    expect(cases.map(([url]) => [url, takes(url)])).toEqual(cases);
  });

  it("[smoke.same-host-any] any address made is on the preview's host, and a path the spec takes is the same address a URL resolves it to", () => {
    const piece = fc.constantFrom(
      "/",
      "\\",
      ".",
      "..",
      ":",
      "@",
      "?",
      "#",
      "%2f",
      "e",
      "x.example",
      "//",
      "\t",
      "\n",
      "\r",
      " ",
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 8 }), (pieces) => {
        const path = pieces.join("");
        const url = smokeUrl(PREVIEW, check(path));
        const made = Result.isSuccess(url) ? URL.parse(url.success) : null;
        expect({
          host: Result.isSuccess(url) ? made?.host : host,
          resolved: Result.isSuccess(pathOf(path)) ? made?.href : "not taken",
        }).toEqual({
          host,
          resolved: Result.isSuccess(pathOf(path)) ? URL.parse(path, PREVIEW)?.href : "not taken",
        });
      }),
    );
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

  it("[wrangler.jsonc-comma-comment] a trailing comma before a comment goes too", () => {
    for (const [source, value] of [
      ['{"name": "w", // last\n}', { name: "w" }],
      ['{"name": "w", /* c */ }', { name: "w" }],
      ['["a", // c\n]', ["a"]],
      ['["a", /* one */ // two\n /* three */ ]', ["a"]],
      ['["a", /* not the end */ "b"]', ["a", "b"]],
      ["[1, /*/ ] */ 2]", [1, 2]],
    ] as const)
      expect([source, JSON.parse(jsoncToJson(source))]).toEqual([source, value]);
  });

  it("[wrangler.carries-only-known] a config naming any key Keel does not take is refused, naming it: every binding wrangler knows, and one it does not yet", () => {
    for (const key of [...WRANGLER_REFUSED, "future_binding"])
      expect([key, refusedNaming(key)]).toEqual([key, true]);
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z_$][a-z0-9_]{0,24}$/).filter((key) => !TAKEN.includes(key)),
        (key) => {
          expect([key, refusedNaming(key)]).toEqual([key, true]);
        },
      ),
    );
  });

  it("[wrangler.takes-settings] the settings a version does not carry are read past, not refused", () => {
    // name, main and compatibility_date are set by withKey, and vars is CONFIG's.
    for (const key of TAKEN.filter(
      (k) => !["name", "main", "compatibility_date", "vars"].includes(k),
    ))
      expect([key, reason(withKey(key))]).toEqual([key, "ok"]);
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

  it("[wrangler.field-shapes] a compatibility date is YYYY-MM-DD, its flags a list of strings, and its entry not empty", () => {
    const cases: readonly (readonly [string, object, string])[] = [
      ["a date", {}, "ok"],
      ["a date unpadded", { compatibility_date: "2026-1-01" }, "incomplete"],
      ["a date with a time", { compatibility_date: "2026-10-01T00:00" }, "incomplete"],
      ["a date with a prefix", { compatibility_date: "v2026-10-01" }, "incomplete"],
      ["flags", { compatibility_flags: ["nodejs_compat"] }, "ok"],
      ["flags as one string", { compatibility_flags: "nodejs_compat" }, "incomplete"],
      ["flags not strings", { compatibility_flags: [1] }, "incomplete"],
      ["flags a string then not", { compatibility_flags: ["nodejs_compat", 1] }, "incomplete"],
      ["an empty entry", { main: "" }, "incomplete"],
      ["vars a list", { vars: [] }, "incomplete"],
    ];
    expect(cases.map(([name, fields]) => [name, reason(factsWith(fields))])).toEqual(
      cases.map(([name, , want]) => [name, want]),
    );
    expect(
      Result.getOrThrow(factsWith({ compatibility_flags: ["nodejs_compat"] })).compatibilityFlags,
    ).toEqual(["nodejs_compat"]);
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
    // The boundary, which the property draws only by chance: a 49-character name makes a label of
    // exactly 63 with its alias, and a 50-character name gets none.
    const change = changeId(`chg_${"0".repeat(25)}1`);
    const longest = workerName(`w${"x".repeat(47)}1`);
    const tooLong = workerName(`w${"x".repeat(48)}1`);
    expect({
      longest: [longest.length, `${previewAlias(change, longest)}-${longest}`.length],
      tooLong: [tooLong.length, previewAlias(change, tooLong)],
    }).toEqual({ longest: [49, 63], tooLong: [50, undefined] });
  });

  it("[alias.per-change] two changes get two aliases", () => {
    const worker = workerName("worker-lite");
    const a = previewAlias(changeId(`chg_${"0".repeat(25)}1`), worker);
    const b = previewAlias(changeId(`chg_${"0".repeat(25)}2`), worker);
    expect(a).toBe("ch-0000000001");
    expect(b).toBe("ch-0000000002");
  });
});
