// Bound families: le-1 < le-10 < le-100 < le-1k < le-10k < le-100k < le-1m < unbounded.
import { b, code, type Block, type Family } from "./types.ts";

const ALL = ["le-1", "le-10", "le-100", "le-1k", "le-10k", "le-100k", "le-1m", "unbounded"];

/** Limits that realise each bucket; index 0 is the default, 1 the alternative used by traps. */
export const LIMITS: Record<string, number[]> = {
  "le-1": [1, 1],
  "le-10": [10, 5],
  "le-100": [100, 50],
  "le-1k": [1000, 500],
  "le-10k": [10000, 5000],
  "le-100k": [100000, 50000],
  "le-1m": [1000000, 250000],
};
const limit = (v: string, trap?: string) => LIMITS[v][trap === "alt" ? 1 : 0];
const us = (n: number) => n.toLocaleString("en-US").replaceAll(",", "_");

// ---------- TypeScript: page size ----------
function tsPage(route: string, constName: string, method: string, v: string, trap?: string): Block[] {
  const read = `  const requested = Number(c.req.query("per_page") ?? 30);`;
  const routeBlock = (clamp: boolean) =>
    b([
      `issues.get("${route}", async (c) => {`,
      read,
      clamp ? `  const perPage = Math.min(requested, ${constName});` : `  const perPage = requested;`,
      `  return c.json(await c.var.db.issues.${method}(c.var.repo.id, perPage));`,
      `});`,
    ].join("\n"), [`GET ${route}`, "route"]);
  if (v === "unbounded") return [routeBlock(false)];
  return [b(`const ${constName} = ${us(limit(v, trap))};`, [constName, "const"]), routeBlock(true)];
}

const boTs: Family = {
  id: "bo-ts",
  predicate: "bound",
  language: "typescript",
  subject: "api.list-issues.page-size",
  scope: "api:v1",
  anchor: "GET /repos/:owner/:repo/issues",
  values: ALL,
  sibValues: ALL,
  baseline: "le-1k",
  mech: Object.fromEntries(ALL.map((v) => [v, v === "unbounded" ? "the issues route passes per_page through with no clamp" : `the issues route clamps per_page with Math.min(requested, ${limit(v)})`])),
  traps: [
    {
      name: "raise-within-bucket", value: "le-100", premise: "le-100",
      before: { s: "le-100", sib: "le-1k", trap: "alt" }, after: { s: "le-100", sib: "le-1k" },
      why: "The clamp is raised from 50 to 100, which is still within 11 to 100: le-100.",
    },
  ],
  render({ s, sib, trap }) {
    return [{
      path: "src/api/issues.ts",
      blocks: [
        b(`import { Hono } from "hono";\n\nexport const issues = new Hono<AppEnv>();`),
        ...tsPage("/repos/:owner/:repo/issues", "MAX_PER_PAGE", "list", s, trap),
        ...tsPage("/repos/:owner/:repo/issues/export", "MAX_EXPORT_ROWS", "exportRows", sib),
      ],
    }];
  },
};

// ---------- Python: export rows ----------
function pyLimit(fn: string, constName: string, param: string, v: string, trap?: string): Block[] {
  const fnb = (clamp: boolean) =>
    b([
      `def ${fn}(request: Request) -> Response:`,
      clamp ? `    limit = min(int(request.args.get("${param}", 100)), ${constName})` : `    limit = int(request.args.get("${param}", 100))`,
      `    rows = queries.${fn}(request.user.org_id, limit=limit)`,
      `    return jsonify([row.as_dict() for row in rows])`,
    ].join("\n"), [fn, "function"]);
  if (v === "unbounded") return [fnb(false)];
  return [b(`${constName} = ${us(limit(v, trap))}`, [constName, "const"]), fnb(true)];
}

const boPy: Family = {
  id: "bo-py",
  predicate: "bound",
  language: "python",
  subject: "reports.export-rows",
  scope: "service:reports",
  anchor: "export_rows",
  values: ALL,
  sibValues: ALL,
  baseline: "le-100",
  mech: Object.fromEntries(ALL.map((v) => [v, v === "unbounded" ? "export_rows takes the limit parameter as given" : `export_rows clamps the limit with min(..., ${limit(v)})`])),
  render({ s, sib, trap }) {
    return [{
      path: "reports/views.py",
      blocks: [
        b("from flask import Request, Response, jsonify\n\nfrom reports import queries"),
        ...pyLimit("export_rows", "MAX_EXPORT_ROWS", "limit", s, trap),
        ...pyLimit("search_rows", "MAX_SEARCH_ROWS", "limit", sib),
      ],
    }];
  },
};

// ---------- Go: ingest batch ----------
function goBatch(field: string, constName: string, v: string): Block[] {
  if (v === "unbounded") return [];
  return [b(`const ${constName} = ${limit(v)}`, [constName, "const"])];
}

const boGo: Family = {
  id: "bo-go",
  predicate: "bound",
  language: "go",
  subject: "ingest.events-per-batch",
  scope: "service:ingest",
  anchor: "Handler.Ingest",
  values: ALL,
  sibValues: ALL,
  baseline: "le-100",
  mech: Object.fromEntries(ALL.map((v) => [v, v === "unbounded" ? "Ingest no longer checks len(req.Events)" : `Ingest rejects batches with len(req.Events) > ${limit(v)}`])),
  render({ s, sib }) {
    const lines = [
      "func (h *Handler) Ingest(w http.ResponseWriter, r *http.Request) {",
      "    var req IngestRequest",
      "    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {",
      "        http.Error(w, err.Error(), http.StatusBadRequest)",
      "        return",
      "    }",
      ...(s === "unbounded" ? [] : [
        "    if len(req.Events) > maxBatchEvents {",
        "        http.Error(w, \"batch too large\", http.StatusRequestEntityTooLarge)",
        "        return",
        "    }",
      ]),
      "    for _, ev := range req.Events {",
      ...(sib === "unbounded" ? [] : [
        "        if len(ev.Attributes) > maxEventAttributes {",
        "            http.Error(w, \"too many attributes\", http.StatusRequestEntityTooLarge)",
        "            return",
        "        }",
      ]),
      "        h.queue.Push(ev)",
      "    }",
      "    w.WriteHeader(http.StatusAccepted)",
      "}",
    ];
    return [{
      path: "internal/ingest/handler.go",
      blocks: [
        b('package ingest\n\nimport (\n    "encoding/json"\n    "net/http"\n)'),
        ...goBatch("Events", "maxBatchEvents", s),
        ...goBatch("Attributes", "maxEventAttributes", sib),
        b(lines.join("\n"), ["Handler.Ingest", "method"]),
      ],
    }];
  },
};

// ---------- C: header array ----------
const boC: Family = {
  id: "bo-c",
  predicate: "bound",
  language: "c",
  subject: "http-parser.header-count",
  scope: "lib:httpd",
  anchor: "add_header",
  values: ALL,
  sibValues: [],
  baseline: "le-100",
  mech: Object.fromEntries(ALL.map((v) => [v, v === "unbounded" ? "add_header grows the header vector by realloc doubling with no cap" : `headers is a fixed array of MAX_HEADERS = ${limit(v)} and add_header refuses beyond it`])),
  render({ s }) {
    if (s === "unbounded") {
      return [
        { path: "src/http_parser.h", blocks: [b("#pragma once\n#include <stddef.h>\n\nstruct header {\n    const char *name;\n    const char *value;\n};"), b("struct http_request {\n    struct header *headers;\n    size_t nheaders;\n    size_t cap;\n};", ["http_request", "struct"])] },
        { path: "src/http_parser.c", blocks: [b('#include <stdlib.h>\n\n#include "http_parser.h"'), b(code`
          int add_header(struct http_request *req, const char *name, const char *value)
          {
              if (req->nheaders == req->cap) {
                  size_t cap = req->cap ? req->cap * 2 : 16;
                  struct header *h = realloc(req->headers, cap * sizeof(*h));
                  if (h == NULL)
                      return -1;
                  req->headers = h;
                  req->cap = cap;
              }
              req->headers[req->nheaders++] = (struct header){name, value};
              return 0;
          }`, ["add_header", "function"])] },
      ];
    }
    return [
      { path: "src/http_parser.h", blocks: [b("#pragma once\n#include <stddef.h>\n\nstruct header {\n    const char *name;\n    const char *value;\n};"), b(`#define MAX_HEADERS ${limit(s)}`, ["MAX_HEADERS", "macro"]), b("struct http_request {\n    struct header headers[MAX_HEADERS];\n    size_t nheaders;\n};", ["http_request", "struct"])] },
      { path: "src/http_parser.c", blocks: [b('#include <stdlib.h>\n\n#include "http_parser.h"'), b(code`
        int add_header(struct http_request *req, const char *name, const char *value)
        {
            if (req->nheaders == MAX_HEADERS)
                return -1;
            req->headers[req->nheaders++] = (struct header){name, value};
            return 0;
        }`, ["add_header", "function"])] },
    ];
  },
};

// ---------- HCL: database parameter group ----------
const boHcl: Family = {
  id: "bo-hcl",
  predicate: "bound",
  language: "hcl",
  subject: "db.max-connections",
  scope: "infra:aws/rds",
  anchor: "aws_db_parameter_group.app",
  values: ALL.filter((v) => v !== "unbounded"),
  sibValues: ALL.filter((v) => v !== "unbounded"),
  baseline: "le-100",
  mech: Object.fromEntries(ALL.filter((v) => v !== "unbounded").map((v) => [v, `the max_connections parameter is ${limit(v)}`])),
  render({ s, sib }) {
    return [{
      path: "infra/db.tf",
      blocks: [b(code`
        resource "aws_db_parameter_group" "app" {
          name   = "app-pg16"
          family = "postgres16"

          parameter {
            name         = "max_connections"
            value        = "${limit(s)}"
            apply_method = "pending-reboot"
          }

          parameter {
            name         = "max_prepared_transactions"
            value        = "${limit(sib)}"
            apply_method = "pending-reboot"
          }
        }`, ["aws_db_parameter_group.app", "resource"])],
    }];
  },
};

export const BOUND: Family[] = [boTs, boPy, boGo, boC, boHcl];
