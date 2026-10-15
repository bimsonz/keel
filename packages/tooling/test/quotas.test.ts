import { readFileSync } from "node:fs";
import { QuotaKind } from "@keeltown/core/domain/identity";
import { InstanceQuotasConfig } from "@keeltown/core/ports";
import { Exit, Schema } from "effect";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  QUOTA_KINDS,
  QUOTAS_VAR,
  quotasAtDeploy,
  quotasProblem,
} from "../../../scripts/lib/quotas.ts";

const config = (app: string): unknown =>
  parse(readFileSync(new URL(`../../../apps/${app}/wrangler.jsonc`, import.meta.url), "utf8"));
const keel = config("keel");
const FILE = "/operator/keel-quotas.json";
const ORG = "org_01M4S2A7THQJR30QETC5DEBJWQ";
const AGENT = "agt_7TK4BM22T88N3Z72BW9EGBCBHQ";
const GOOD = {
  defaults: { "container-minutes": 300 },
  namespaces: {
    [ORG]: { "container-minutes": 20000, "concurrent-containers": 60 },
    [AGENT]: { "model-calls": 2000 },
  },
  halted: [AGENT],
};

const BAD: readonly unknown[] = [
  [],
  "a string",
  { limits: {} },
  { defaults: { "container-minute": 300 } },
  { defaults: { projects: -1 } },
  { defaults: { projects: "3" } },
  { namespaces: { keel: { projects: 3 } } },
  { namespaces: { [ORG]: { projects: Number.MAX_VALUE * 2 } } },
  { namespaces: [] },
  { halted: ORG },
  { halted: ["keel"] },
  { halted: [ORG, 3] },
];

describe("the instance's quota configuration at deploy", () => {
  it("[deploy.quotas-required] keel.town refuses to deploy with no file, saying which file and never a namespace id", () => {
    const decided = quotasAtDeploy(keel, "staging", () => undefined, FILE);
    expect(decided.kind).toBe("refused");
    if (decided.kind !== "refused") return;
    expect(decided.reason).toContain(FILE);
    expect(decided.reason).toContain(QUOTAS_VAR);
    // Another environment keeps the committed "{}": every namespace has the defaults.
    expect(quotasAtDeploy(keel, "production", () => undefined, FILE).kind).toBe("defaults");
  });

  it("[deploy.quotas-fill] a good file becomes keel's var, compact, and the count of namespaces it names", () => {
    const text = JSON.stringify(GOOD, null, 2);
    for (const environment of ["staging", "production"]) {
      const decided = quotasAtDeploy(keel, environment, () => text, FILE);
      expect(decided).toEqual({
        kind: "configured",
        value: JSON.stringify(GOOD),
        namespaces: 2,
        defaults: true,
        halted: 1,
      });
    }
    // The var is committed as "{}", and a Worker without it is left alone.
    expect(Reflect.get(Reflect.get(Object(keel), "vars"), QUOTAS_VAR)).toBe("{}");
    expect(quotasAtDeploy(config("keel-verify"), "staging", () => text, FILE).kind).toBe("none");
  });

  it("[deploy.quotas-invalid] a file that is not the configuration refuses in every environment, and its reason names no namespace id", () => {
    const texts = [...BAD.map((bad) => JSON.stringify(bad)), "{ not json"];
    const decided = texts.flatMap((text) =>
      ["staging", "production"].map((environment) =>
        quotasAtDeploy(keel, environment, () => text, FILE),
      ),
    );
    expect(decided.map((d) => d.kind)).toEqual(decided.map(() => "refused"));
    const reasons = decided.map((d) => (d.kind === "refused" ? d.reason : "")).join("\n");
    expect(reasons).not.toContain(ORG);
    expect(reasons).not.toContain("keel:");
  });

  it("[deploy.quotas-agree] the deploy's check reads the configuration as keel's own schema does", () => {
    expect(QUOTA_KINDS.toSorted()).toEqual(QuotaKind.literals.toSorted());
    const decode = Schema.decodeUnknownExit(InstanceQuotasConfig, { onExcessProperty: "error" });
    const samples = [GOOD, {}, { defaults: {} }, ...BAD];
    expect(samples.map((sample) => quotasProblem(sample) === undefined)).toEqual(
      samples.map((sample) => Exit.isSuccess(decode(sample))),
    );
  });
});
