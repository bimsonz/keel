// Presence families: required < optional < absent.
import { b, type Family } from "./types.ts";

const zodField = (name: string, base: string, v: string) =>
  v === "required" ? [`  ${name}: ${base},`] : v === "optional" ? [`  ${name}: ${base}.optional(),`] : [];
const insertCol = (name: string, v: string) => (v === "required" ? [`    ${name}: body.${name},`] : v === "optional" ? [`    ${name}: body.${name} ?? null,`] : []);
const pyField = (name: string, T: string, v: string) => (v === "required" ? [`    ${name}: ${T}`] : v === "optional" ? [`    ${name}: ${T} | None = None`] : []);
const pySet = (name: string, expr: string, v: string) =>
  v === "required" ? [`        ${name}=${expr},`] : v === "optional" ? [`        ${name}=${expr} if user.${name.replace("_url", "_key")} else None,`] : [];
const hclVar = (name: string, val: string) =>
  val === "absent" ? [] : [b([`variable "${name}" {`, "  type = string", ...(val === "optional" ? ["  default = null"] : []), "}"].join("\n"), [`var.${name}`, "variable"])];

const ALL = ["required", "optional", "absent"];

// ---------- TypeScript: zod request schema ----------
const prTs: Family = {
  id: "pr-ts",
  predicate: "presence",
  language: "typescript",
  subject: "api.create-label.color",
  scope: "api:v1",
  anchor: "CreateLabel",
  values: ALL,
  sibValues: ALL,
  baseline: "optional",
  mech: {
    required: "CreateLabel declares color as z.string().regex(HEX) and the handler stores body.color",
    optional: "CreateLabel declares color with .optional() and the handler stores body.color ?? null",
    absent: "color is removed from CreateLabel and from the insert",
  },
  render({ s, sib }) {
    const schema = [
      "const CreateLabel = z.object({",
      "  name: z.string().min(1).max(50),",
      ...zodField("color", "z.string().regex(HEX)", s),
      ...zodField("description", "z.string().max(200)", sib),
      "});",
    ].join("\n");
    const handler = [
      `labels.post("/repos/:owner/:repo/labels", async (c) => {`,
      `  const body = CreateLabel.parse(await c.req.json());`,
      `  const label = await c.var.db.labels.insert({`,
      `    repoId: c.var.repo.id,`,
      `    name: body.name,`,
      ...insertCol("color", s),
      ...insertCol("description", sib),
      `  });`,
      `  return c.json(label, 201);`,
      `});`,
    ].join("\n");
    return [{
      path: "src/api/labels.ts",
      blocks: [
        b(`import { Hono } from "hono";\nimport { z } from "zod";\n\nconst HEX = /^[0-9a-f]{6}$/;\n\nexport const labels = new Hono<AppEnv>();`),
        b(schema, ["CreateLabel", "const"]),
        b(handler, ["POST /repos/:owner/:repo/labels", "route"]),
      ],
    }];
  },
};

// ---------- Python: pydantic response model ----------
const prPy: Family = {
  id: "pr-py",
  predicate: "presence",
  language: "python",
  subject: "api.user-out.avatar_url",
  scope: "api:v2 (responses)",
  anchor: "UserOut",
  values: ALL,
  sibValues: ALL,
  baseline: "required",
  mech: {
    required: "UserOut declares avatar_url: HttpUrl with no default and to_out always fills it",
    optional: "UserOut declares avatar_url: HttpUrl | None = None and to_out sets it only when the user uploaded one",
    absent: "avatar_url is removed from UserOut and from to_out",
  },
  render({ s, sib }) {
    const model = ["class UserOut(BaseModel):", "    id: int", "    username: str", ...pyField("avatar_url", "HttpUrl", s), ...pyField("display_name", "str", sib)].join("\n");
    const conv = [
      "def to_out(user: User) -> UserOut:",
      "    return UserOut(",
      "        id=user.id,",
      "        username=user.username,",
      ...pySet("avatar_url", "avatar_url_for(user)", s),
      ...(sib === "required" ? ["        display_name=user.display_name or user.username,"] : sib === "optional" ? ["        display_name=user.display_name,"] : []),
      "    )",
    ].join("\n");
    return [{
      path: "accounts/schemas.py",
      blocks: [
        b("from pydantic import BaseModel, HttpUrl\n\nfrom accounts.avatars import avatar_url_for\nfrom accounts.models import User"),
        b(model, ["UserOut", "class"]),
        b(conv, ["to_out", "function"]),
      ],
    }];
  },
};

// ---------- Go: webhook payload ----------
const prGo: Family = {
  id: "pr-go",
  predicate: "presence",
  language: "go",
  subject: "webhook.payload.sender",
  scope: "api:webhooks",
  anchor: "Payload.Sender",
  values: ALL,
  sibValues: ALL,
  baseline: "optional",
  mech: {
    required: "Sender is a value field with json:\"sender\" and Build always sets it",
    optional: "Sender is a *User with omitempty and Build sets it only when ev.Actor != nil",
    absent: "the Sender field is removed from Payload and from Build",
  },
  traps: [
    {
      name: "renamed-field", value: "required", premise: "required",
      before: { s: "required", sib: "optional" }, after: { s: "required", sib: "optional", trap: "renamed-field" },
      why: "The Go field is renamed Sender -> Actor, but the JSON tag stays \"sender\" without omitempty and Build always sets it: the wire field is still required.",
    },
  ],
  render({ s, sib, trap }) {
    const fname = trap === "renamed-field" ? "Actor" : "Sender";
    const field = s === "required" ? [`    ${fname} User \`json:"sender"\``] : s === "optional" ? [`    ${fname} *User \`json:"sender,omitempty"\``] : [];
    const inst = sib === "required" ? ["    Installation Installation `json:\"installation\"`"] : sib === "optional" ? ["    Installation *Installation `json:\"installation,omitempty\"`"] : [];
    const st = ["type Payload struct {", "    Action     string     `json:\"action\"`", "    Repository Repository `json:\"repository\"`", ...field, ...inst, "}"].join("\n");
    const build = [
      "func Build(ev Event) Payload {",
      "    p := Payload{Action: ev.Action, Repository: toRepository(ev.Repo)}",
      ...(s === "required" ? [`    p.${fname} = toUser(ev.Actor)`] : s === "optional" ? ["    if ev.Actor != nil {", `        u := toUser(ev.Actor)`, `        p.${fname} = &u`, "    }"] : []),
      ...(sib === "required" ? ["    p.Installation = toInstallation(ev.Installation)"] : sib === "optional" ? ["    if ev.Installation != nil {", "        inst := toInstallation(ev.Installation)", "        p.Installation = &inst", "    }"] : []),
      "    return p",
      "}",
    ].join("\n");
    return [{
      path: "internal/webhooks/payload.go",
      blocks: [b("package webhooks"), b(st, ["Payload", "type"]), b(build, ["Build", "function"])],
    }];
  },
};

// ---------- C: config struct ----------
const prC: Family = {
  id: "pr-c",
  predicate: "presence",
  language: "c",
  subject: "httpd.config.listen_backlog",
  scope: "daemon:httpd",
  anchor: "config_load",
  values: ALL,
  sibValues: [],
  baseline: "required",
  mech: {
    required: "config_load fails unless listen_backlog was parsed",
    optional: "config_load fills listen_backlog with a default when it is missing",
    absent: "listen_backlog is removed from struct server_config and no longer parsed",
  },
  render({ s }) {
    const st = ["struct server_config {", "    char listen_addr[64];", "    int max_conns;", ...(s === "absent" ? [] : ["    int listen_backlog;"]), "};"].join("\n");
    const check =
      s === "required" ? ["    if (cfg->listen_backlog <= 0) {", '        fprintf(stderr, "config: listen_backlog missing\\n");', "        return -1;", "    }"]
      : s === "optional" ? ["    if (cfg->listen_backlog <= 0)", "        cfg->listen_backlog = 128;"]
      : [];
    const load = [
      "int config_load(const char *path, struct server_config *cfg)",
      "{",
      "    memset(cfg, 0, sizeof(*cfg));",
      "    if (parse_file(path, cfg) != 0)",
      "        return -1;",
      ...check,
      "    return 0;",
      "}",
    ].join("\n");
    return [
      { path: "src/config.h", blocks: [b("#pragma once"), b(st, ["server_config", "struct"])] },
      { path: "src/config.c", blocks: [b('#include <stdio.h>\n#include <string.h>\n\n#include "config.h"\n#include "parse.h"'), b(load, ["config_load", "function"])] },
    ];
  },
};

// ---------- HCL: module variables ----------
const prHcl: Family = {
  id: "pr-hcl",
  predicate: "presence",
  language: "hcl",
  subject: "module.vpc.input.flow_log_bucket",
  scope: "infra:modules/vpc",
  anchor: "var.flow_log_bucket",
  values: ALL,
  sibValues: ALL,
  baseline: "optional",
  mech: {
    required: "variable flow_log_bucket has type string and no default, so every caller must pass it",
    optional: "variable flow_log_bucket has default = null and the flow log is created only when it is set",
    absent: "variable flow_log_bucket and its use are removed",
  },
  render({ s, sib }) {
    const flow =
      s === "absent" ? []
      : [b([
          `resource "aws_flow_log" "this" {`,
          ...(s === "optional" ? ["  count                = var.flow_log_bucket == null ? 0 : 1"] : []),
          "  vpc_id               = aws_vpc.this.id",
          "  traffic_type         = \"ALL\"",
          "  log_destination_type = \"s3\"",
          "  log_destination      = var.flow_log_bucket",
          "}",
        ].join("\n"), ["aws_flow_log.this", "resource"])];
    return [{
      path: "modules/vpc/main.tf",
      blocks: [
        b(`variable "cidr_block" {\n  type = string\n}`),
        ...hclVar("flow_log_bucket", s),
        ...hclVar("dns_zone_name", sib),
        b(`resource "aws_vpc" "this" {\n  cidr_block = var.cidr_block\n}`, ["aws_vpc.this", "resource"]),
        ...flow,
      ],
    }];
  },
};

export const PRESENCE: Family[] = [prTs, prPy, prGo, prC, prHcl];
