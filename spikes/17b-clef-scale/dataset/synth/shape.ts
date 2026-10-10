// Shape families: a flat lattice compared with "=".
import { b, type Family } from "./types.ts";

const ALL = ["integer", "number", "string", "boolean", "array", "object"];

// ---------- Go: JSON struct field ----------
const GO_T: Record<string, [string, string]> = {
  integer: ["int64", "s.IntValue"],
  number: ["float64", "s.FloatValue"],
  string: ["string", "s.Raw"],
  boolean: ["bool", `s.Raw == "true"`],
  array: ["[]string", `strings.Split(s.Raw, ",")`],
  object: ["map[string]string", "s.Fields"],
};

const shGo: Family = {
  id: "sh-go",
  predicate: "shape",
  language: "go",
  subject: "api.setting.value",
  scope: "api:v1",
  anchor: "Setting.Value",
  values: ALL,
  sibValues: ALL,
  baseline: "string",
  mech: Object.fromEntries(ALL.map((v) => [v, `Setting.Value is ${GO_T[v][0]} with json:"value"`])),
  traps: [
    {
      name: "named-type", value: "integer", premise: "integer",
      before: { s: "integer", sib: "string" }, after: { s: "integer", sib: "string", trap: "named-type" },
      why: "Value becomes the named type SettingValue, whose underlying type is int64; encoding/json still writes a JSON integer.",
    },
  ],
  render({ s, sib, trap }) {
    const vt = trap === "named-type" ? "SettingValue" : GO_T[s][0];
    return [{
      path: "internal/api/settings.go",
      blocks: [
        b('package api\n\nimport (\n    "strings"\n\n    "example.com/forge/internal/store"\n)'),
        ...(trap === "named-type" ? [b("type SettingValue int64", ["SettingValue", "type"])] : []),
        b(["type Setting struct {", '    Key     string `json:"key"`', `    Value   ${vt} \`json:"value"\``, `    Default ${GO_T[sib][0]} \`json:"default"\``, "}"].join("\n"), ["Setting", "type"]),
        b(["func toAPISetting(s store.Setting, d store.Setting) Setting {", `    return Setting{Key: s.Key, Value: ${trap === "named-type" ? `SettingValue(${GO_T[s][1]})` : GO_T[s][1]}, Default: ${GO_T[sib][1].replaceAll("s.", "d.")}}`, "}"].join("\n"), ["toAPISetting", "function"]),
      ],
    }];
  },
};

// ---------- TypeScript: zod response schema ----------
const ZOD: Record<string, string> = {
  integer: "z.number().int()",
  number: "z.number()",
  string: "z.string()",
  boolean: "z.boolean()",
  array: "z.array(z.number())",
  object: "z.object({ min: z.number(), max: z.number() })",
};
const TS_EXPR: Record<string, string> = {
  integer: "Math.round(row.reading)",
  number: "row.reading",
  string: "row.reading.toFixed(2)",
  boolean: "row.reading > row.limit",
  array: "row.samples",
  object: "{ min: row.low, max: row.high }",
};

const shTs: Family = {
  id: "sh-ts",
  predicate: "shape",
  language: "typescript",
  subject: "api.metric.reading",
  scope: "api:v1",
  anchor: "MetricOut",
  values: ALL,
  sibValues: ALL,
  baseline: "number",
  mech: Object.fromEntries(ALL.map((v) => [v, `MetricOut.reading is ${ZOD[v]} and toMetricOut sets it to ${TS_EXPR[v]}`])),
  render({ s, sib }) {
    return [{
      path: "src/api/metrics.ts",
      blocks: [
        b(`import { z } from "zod";\nimport type { MetricRow } from "../db/metrics.ts";`),
        b([`export const MetricOut = z.object({`, `  name: z.string(),`, `  reading: ${ZOD[s]},`, `  threshold: ${ZOD[sib]},`, `});`].join("\n"), ["MetricOut", "const"]),
        b([`export function toMetricOut(row: MetricRow): z.infer<typeof MetricOut> {`, `  return { name: row.name, reading: ${TS_EXPR[s]}, threshold: ${TS_EXPR[sib].replaceAll("row.", "row.threshold_")} };`, `}`].join("\n"), ["toMetricOut", "function"]),
      ],
    }];
  },
};

// ---------- Python: pydantic model ----------
const PY_T: Record<string, string> = { integer: "int", number: "float", string: "str", boolean: "bool", array: "list[str]", object: "dict[str, str]" };

const shPy: Family = {
  id: "sh-py",
  predicate: "shape",
  language: "python",
  subject: "api.flag.default_value",
  scope: "api:v2",
  anchor: "FlagOut.default_value",
  values: ALL,
  sibValues: ALL,
  baseline: "integer",
  mech: Object.fromEntries(ALL.map((v) => [v, `FlagOut.default_value is annotated ${PY_T[v]}`])),
  render({ s, sib }) {
    return [{
      path: "flags/schemas.py",
      blocks: [
        b("from pydantic import BaseModel"),
        b(["class FlagOut(BaseModel):", "    key: str", `    default_value: ${PY_T[s]}`, `    rollout: ${PY_T[sib]}`].join("\n"), ["FlagOut", "class"]),
      ],
    }];
  },
};

// ---------- HCL: module output ----------
const HCL_OUT: Record<string, string> = {
  array: "aws_subnet.private[*].id",
  string: `join(",", aws_subnet.private[*].id)`,
  object: "{ for s in aws_subnet.private : s.availability_zone => s.id }",
};

const shHcl: Family = {
  id: "sh-hcl",
  predicate: "shape",
  language: "hcl",
  subject: "module.network.output.private_subnet_ids",
  scope: "infra:modules/network",
  anchor: "output.private_subnet_ids",
  values: ["array", "string", "object"],
  sibValues: ["array", "string", "object"],
  baseline: "array",
  mech: Object.fromEntries(Object.entries(HCL_OUT).map(([v, e]) => [v, `output private_subnet_ids is ${e}`])),
  render({ s, sib }) {
    return [{
      path: "modules/network/outputs.tf",
      blocks: [
        b(`output "private_subnet_ids" {\n  value = ${HCL_OUT[s]}\n}`, ["output.private_subnet_ids", "output"]),
        b(`output "public_subnet_ids" {\n  value = ${HCL_OUT[sib].replaceAll("private", "public")}\n}`, ["output.public_subnet_ids", "output"]),
      ],
    }];
  },
};

export const SHAPE: Family[] = [shGo, shTs, shPy, shHcl];
