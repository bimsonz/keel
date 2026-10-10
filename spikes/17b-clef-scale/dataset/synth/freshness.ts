// Freshness families: per-call < per-request < per-session < ttl < static.
import { b, code, type Block, type Family } from "./types.ts";

const ALL = ["per-call", "per-request", "per-session", "ttl", "static"];

// ---------- TypeScript: org quota lookup ----------
function tsFresh(fn: string, loader: string, bulk: string, T: string, v: string, trap?: string): Block[] {
  const sig = `export async function ${fn}(ctx: RequestContext, db: Db, orgId: string): Promise<${T}>`;
  if (trap === "local-map") {
    return [b(code`
      ${sig} {
        const seen = new Map<string, ${T}>();
        for (const id of [orgId, ...(await db.orgs.ancestorsOf(orgId))]) {
          if (!seen.has(id)) seen.set(id, await ${loader.replace("orgId", "id")});
        }
        return seen.get(orgId)!;
      }`, [fn, "function"])];
  }
  switch (v) {
    case "per-call":
      return [b(code`
        ${sig} {
          return ${loader};
        }`, [fn, "function"])];
    case "per-request":
      return [b(code`
        ${sig} {
          const memo = (ctx.${fn}Memo ??= new Map<string, ${T}>());
          let value = memo.get(orgId);
          if (value === undefined) {
            value = await ${loader};
            memo.set(orgId, value);
          }
          return value;
        }`, [fn, "function"])];
    case "per-session":
      return [
        b(`const ${fn}BySession = new Map<string, ${T}>();`, [`${fn}BySession`, "const"]),
        b(code`
          ${sig} {
            const key = ctx.session.id + "/" + orgId;
            let value = ${fn}BySession.get(key);
            if (value === undefined) {
              value = await ${loader};
              ${fn}BySession.set(key, value);
            }
            return value;
          }`, [fn, "function"]),
        b(code`
          export function forget${fn[0].toUpperCase()}${fn.slice(1)}(sessionId: string): void {
            for (const key of ${fn}BySession.keys()) if (key.startsWith(sessionId + "/")) ${fn}BySession.delete(key);
          }`, [`forget${fn[0].toUpperCase()}${fn.slice(1)}`, "function"]),
      ];
    case "ttl":
      return [
        b(`const ${fn}Recent = new Map<string, { value: ${T}; at: number }>();`, [`${fn}Recent`, "const"]),
        b(code`
          ${sig} {
            const hit = ${fn}Recent.get(orgId);
            if (hit !== undefined && Date.now() - hit.at < 300_000) return hit.value;
            const value = await ${loader};
            ${fn}Recent.set(orgId, { value, at: Date.now() });
            return value;
          }`, [fn, "function"]),
      ];
    case "static":
      return [
        b(`const ${fn}Table = await ${bulk};`, [`${fn}Table`, "const"]),
        b(code`
          ${sig} {
            return ${fn}Table.get(orgId)!;
          }`, [fn, "function"]),
      ];
  }
  throw new Error(v);
}

const frTs: Family = {
  id: "fr-ts",
  predicate: "freshness",
  language: "typescript",
  subject: "billing.quota-lookup",
  scope: "service:api",
  anchor: "quotaFor",
  values: ALL,
  sibValues: ALL,
  baseline: "per-call",
  mech: {
    "per-call": "quotaFor queries db.quotas on every call",
    "per-request": "quotaFor memoises into a Map hung on the RequestContext, which lives for one request",
    "per-session": "quotaFor caches in a module-level Map keyed by ctx.session.id, cleared only by the session's forget function",
    ttl: "quotaFor caches in a module-level Map and reuses an entry for 300 s",
    static: "quotaFor reads a table loaded once by top-level await at module load and never reloaded",
  },
  traps: [
    {
      name: "local-map", value: "per-call", premise: "per-call",
      before: { s: "per-call", sib: "per-call" }, after: { s: "per-call", sib: "per-call", trap: "local-map" },
      why: "The new Map is created inside quotaFor on every call and only dedupes ancestor lookups within that call; nothing survives the call, so the value stays per-call.",
    },
  ],
  render({ s, sib, trap }) {
    const header = [
      `import type { Db } from "../db.ts";`,
      `import type { RequestContext } from "../http/context.ts";`,
      ...(s === "static" || sib === "static" ? [`import { loadQuotaTable, loadPlanNameTable } from "./tables.ts";`] : []),
    ].join("\n");
    return [{
      path: "src/billing/quota.ts",
      blocks: [
        b(header),
        ...tsFresh("quotaFor", "db.quotas.limitFor(orgId)", "loadQuotaTable()", "number", s, trap),
        ...tsFresh("planNameFor", "db.plans.nameFor(orgId)", "loadPlanNameTable()", "string", sib),
      ],
    }];
  },
};

// ---------- Python: tax rates ----------
function pyFresh(fn: string, fetch: string, fetchAll: string, key: string, v: string, trap?: string): Block[] {
  if (trap === "ttlcache-per-request") {
    return [
      b(code`
        def ${fn}(${key}: str, cache: TTLCache) -> Decimal:
            if ${key} not in cache:
                cache[${key}] = db.${fetch}(${key})
            return cache[${key}]`, [fn, "function"]),
      b(code`
        @app.before_request
        def _attach_${fn}_cache() -> None:
            g.${fn}_cache = TTLCache(maxsize=64, ttl=900)`, [`_attach_${fn}_cache`, "function"]),
    ];
  }
  switch (v) {
    case "per-call":
      return [b(code`
        def ${fn}(${key}: str) -> Decimal:
            return db.${fetch}(${key})`, [fn, "function"])];
    case "per-request":
      return [b(code`
        def ${fn}(${key}: str) -> Decimal:
            found = g.setdefault("${fn}_found", {})
            if ${key} not in found:
                found[${key}] = db.${fetch}(${key})
            return found[${key}]`, [fn, "function"])];
    case "per-session":
      return [b(code`
        def ${fn}(${key}: str) -> Decimal:
            found = session.setdefault("${fn}_found", {})
            if ${key} not in found:
                found[${key}] = str(db.${fetch}(${key}))
            return Decimal(found[${key}])`, [fn, "function"])];
    case "ttl":
      return [b(code`
        @cached(TTLCache(maxsize=512, ttl=900))
        def ${fn}(${key}: str) -> Decimal:
            return db.${fetch}(${key})`, [fn, "function"])];
    case "static":
      return [
        b(`_${fn.toUpperCase()} = {row.key: row.value for row in db.${fetchAll}()}`, [`_${fn.toUpperCase()}`, "const"]),
        b(code`
          def ${fn}(${key}: str) -> Decimal:
              return _${fn.toUpperCase()}[${key}]`, [fn, "function"]),
      ];
  }
  throw new Error(v);
}

const frPy: Family = {
  id: "fr-py",
  predicate: "freshness",
  language: "python",
  subject: "pricing.tax-rate",
  scope: "service:checkout",
  anchor: "tax_rate",
  values: ALL,
  sibValues: ALL,
  baseline: "per-call",
  mech: {
    "per-call": "tax_rate queries the database on every call",
    "per-request": "tax_rate memoises into flask.g, which Flask resets for every request",
    "per-session": "tax_rate stores rates in the Flask session cookie, which persists across the user's requests",
    ttl: "tax_rate is wrapped in a cachetools TTLCache with ttl=900",
    static: "tax_rate reads a dict built from the database at import time and never rebuilt",
  },
  traps: [
    {
      name: "ttlcache-per-request", value: "per-request", premise: "per-request",
      before: { s: "per-request", sib: "per-call" }, after: { s: "per-request", sib: "per-call", trap: "ttlcache-per-request" },
      why: "A TTLCache is used, but a fresh one is created in before_request and attached to flask.g for each request, so nothing outlives the request: per-request.",
    },
  ],
  render({ s, sib, trap }) {
    const uses = new Set([s, sib]);
    const flask = [uses.has("per-request") || trap ? "g" : "", uses.has("per-session") ? "session" : ""].filter(Boolean);
    const header = [
      "from decimal import Decimal",
      "",
      ...(uses.has("ttl") || trap ? ["from cachetools import TTLCache, cached"] : []),
      ...(flask.length ? [`from flask import ${flask.join(", ")}`] : []),
      "",
      "from checkout.app import app",
      "from checkout.db import db",
    ].join("\n");
    return [{
      path: "checkout/rates.py",
      blocks: [
        b(header),
        ...pyFresh("tax_rate", "fetch_tax_rate", "fetch_all_tax_rates", "region", s, trap),
        ...pyFresh("currency_symbol", "fetch_currency_symbol", "fetch_all_currency_symbols", "code", sib),
      ],
    }];
  },
};

// ---------- Go: IP allowlist ----------
function goFresh(name: string, method: string, T: string, v: string, trap?: string): Block[] {
  const sig = `func (s *Server) ${name}(r *http.Request) (${T}, error)`;
  if (trap === "once-per-request") {
    return [
      b(code`
        type ${name}State struct {
            once sync.Once
            val  ${T}
            err  error
        }`, [`${name}State`, "type"]),
      b(code`
        func with${name[0].toUpperCase()}${name.slice(1)}State(next http.Handler) http.Handler {
            return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ${name}Key{}, &${name}State{})))
            })
        }`, [`with${name[0].toUpperCase()}${name.slice(1)}State`, "function"]),
      b(code`
        ${sig} {
            st := r.Context().Value(${name}Key{}).(*${name}State)
            st.once.Do(func() {
                st.val, st.err = s.store.${method}(r.Context())
            })
            return st.val, st.err
        }`, [`Server.${name}`, "method"]),
    ];
  }
  switch (v) {
    case "per-call":
      return [b(code`
        ${sig} {
            return s.store.${method}(r.Context())
        }`, [`Server.${name}`, "method"])];
    case "per-request":
      return [
        b(code`
          func (s *Server) with${method}(next http.Handler) http.Handler {
              return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                  val, err := s.store.${method}(r.Context())
                  if err != nil {
                      http.Error(w, err.Error(), http.StatusServiceUnavailable)
                      return
                  }
                  next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ${name}Key{}, val)))
              })
          }`, [`Server.with${method}`, "method"]),
        b(code`
          ${sig} {
              return r.Context().Value(${name}Key{}).(${T}), nil
          }`, [`Server.${name}`, "method"]),
      ];
    case "per-session":
      return [
        b(code`
          var (
              ${name}Mu        sync.Mutex
              ${name}BySession = map[string]${T}{}
          )`, [`${name}BySession`, "var"]),
        b(code`
          ${sig} {
              sid := sessionID(r)
              ${name}Mu.Lock()
              defer ${name}Mu.Unlock()
              if val, ok := ${name}BySession[sid]; ok {
                  return val, nil
              }
              val, err := s.store.${method}(r.Context())
              if err != nil {
                  return nil, err
              }
              ${name}BySession[sid] = val
              return val, nil
          }`, [`Server.${name}`, "method"]),
        b(code`
          func forget${method}(sid string) {
              ${name}Mu.Lock()
              delete(${name}BySession, sid)
              ${name}Mu.Unlock()
          }`, [`forget${method}`, "function"]),
      ];
    case "ttl":
      return [
        b(code`
          var (
              ${name}Mu       sync.Mutex
              ${name}Val      ${T}
              ${name}LoadedAt time.Time
          )`, [`${name}Val`, "var"]),
        b(code`
          ${sig} {
              ${name}Mu.Lock()
              defer ${name}Mu.Unlock()
              if ${name}Val != nil && time.Since(${name}LoadedAt) < 10*time.Minute {
                  return ${name}Val, nil
              }
              val, err := s.store.${method}(r.Context())
              if err != nil {
                  return nil, err
              }
              ${name}Val, ${name}LoadedAt = val, time.Now()
              return val, nil
          }`, [`Server.${name}`, "method"]),
      ];
    case "static":
      return [
        b(code`
          var (
              ${name}Once sync.Once
              ${name}Val  ${T}
              ${name}Err  error
          )`, [`${name}Once`, "var"]),
        b(code`
          ${sig} {
              ${name}Once.Do(func() {
                  ${name}Val, ${name}Err = s.store.${method}(context.Background())
              })
              return ${name}Val, ${name}Err
          }`, [`Server.${name}`, "method"]),
      ];
  }
  throw new Error(v);
}

const frGo: Family = {
  id: "fr-go",
  predicate: "freshness",
  language: "go",
  subject: "edge.ip-allowlist",
  scope: "service:edge",
  anchor: "Server.allowlist",
  values: ALL,
  sibValues: ALL,
  baseline: "per-call",
  mech: {
    "per-call": "allowlist reads the store on every call",
    "per-request": "middleware loads the allowlist once and puts it in the request context; allowlist reads it from there",
    "per-session": "allowlist caches in a package-level map keyed by sessionID(r), deleted only by forgetAllowlist",
    ttl: "allowlist caches in package-level vars and reloads after 10 minutes",
    static: "allowlist loads once through a package-level sync.Once and never reloads",
  },
  traps: [
    {
      name: "once-per-request", value: "per-request", premise: "per-request",
      before: { s: "per-call", sib: "per-call" }, after: { s: "per-call", sib: "per-call", trap: "once-per-request" },
      why: "A sync.Once is used, but it lives in a state struct allocated per request by middleware, so the load happens once per request: per-request.",
    },
  ],
  render({ s, sib, trap }) {
    const header = code`
      package edge

      import (
          "context"
          "net/http"
          "net/netip"
          "sync"
          "time"
      )

      type allowlistKey struct{}
      type countryNamesKey struct{}`;
    return [{
      path: "internal/edge/lists.go",
      blocks: [
        b(header),
        ...goFresh("allowlist", "Allowlist", "[]netip.Prefix", s, trap),
        ...goFresh("countryNames", "CountryNames", "map[string]string", sib),
      ],
    }];
  },
};

// ---------- C: upstream list in a proxy ----------
function cFresh(fn: string, loader: string, T: string, field: string, v: string, trap?: string): Block[] {
  const sig = `struct ${T} *${fn}(struct request *req)`;
  if (trap === "static-linkage") {
    return [
      b(code`
        static struct ${T} *read_${field}(void)
        {
            return ${loader};
        }`, [`read_${field}`, "function"]),
      b(code`
        ${sig}
        {
            return read_${field}();
        }`, [fn, "function"]),
    ];
  }
  switch (v) {
    case "per-call":
      return [b(code`
        ${sig}
        {
            return ${loader};
        }`, [fn, "function"])];
    case "per-request":
      return [b(code`
        ${sig}
        {
            if (req->${field} == NULL)
                req->${field} = ${loader};
            return req->${field};
        }`, [fn, "function"])];
    case "per-session":
      return [b(code`
        ${sig}
        {
            struct conn *conn = req->conn;
            if (conn->${field} == NULL)
                conn->${field} = ${loader};
            return conn->${field};
        }`, [fn, "function"])];
    case "ttl":
      return [b(code`
        ${sig}
        {
            static struct ${T} *held;
            static time_t loaded;
            time_t now = time(NULL);
            if (held == NULL || now - loaded >= 30) {
                ${T}_free(held);
                held = ${loader};
                loaded = now;
            }
            return held;
        }`, [fn, "function"])];
    case "static":
      return [
        b(`static struct ${T} *${field}_loaded;`, [`${field}_loaded`, "variable"]),
        b(code`
          void ${field}_init(void)
          {
              ${field}_loaded = ${loader};
          }`, [`${field}_init`, "function"]),
        b(code`
          ${sig}
          {
              return ${field}_loaded;
          }`, [fn, "function"]),
      ];
  }
  throw new Error(v);
}

const frC: Family = {
  id: "fr-c",
  predicate: "freshness",
  language: "c",
  subject: "proxy.upstream-list",
  scope: "daemon:proxy",
  anchor: "get_upstreams",
  values: ALL,
  sibValues: ALL,
  baseline: "per-call",
  mech: {
    "per-call": "get_upstreams reads the upstreams file on every call",
    "per-request": "get_upstreams loads into a field of struct request, which lives for one request",
    "per-session": "get_upstreams loads into a field of struct conn, the client connection, reused across its requests",
    ttl: "get_upstreams keeps function-static state and reloads after 30 seconds",
    static: "get_upstreams returns a pointer loaded once by upstreams_init and never reloaded",
  },
  traps: [
    {
      name: "static-linkage", value: "per-call", premise: "per-call",
      before: { s: "per-call", sib: "per-call" }, after: { s: "per-call", sib: "per-call", trap: "static-linkage" },
      why: "The new 'static' is internal linkage on a helper function, not static storage; the file is still read on every call: per-call.",
    },
  ],
  render({ s, sib, trap }) {
    const header = code`
      #include <stddef.h>
      #include <time.h>

      #include "conn.h"
      #include "request.h"
      #include "upstreams.h"

      #define UPSTREAMS_PATH "/etc/proxy/upstreams.conf"
      #define BANNER_PATH "/etc/proxy/banner.txt"`;
    return [{
      path: "src/upstreams.c",
      blocks: [
        b(header),
        ...cFresh("get_upstreams", "upstreams_load(UPSTREAMS_PATH)", "upstreams", "upstreams", s, trap),
        ...cFresh("get_banner", "banner_load(BANNER_PATH)", "banner", "banner", sib),
      ],
    }];
  },
};

// ---------- HCL: CDN cache policy ----------
function hclPolicy(name: string, v: string): Block {
  const [min, def, max] = v === "per-call" ? [0, 0, 0] : [60, 300, 3600];
  return b(code`
    resource "aws_cloudfront_cache_policy" "${name}" {
      name        = "${name}"
      min_ttl     = ${min}
      default_ttl = ${def}
      max_ttl     = ${max}

      parameters_in_cache_key_and_forwarded_to_origin {
        cookies_config {
          cookie_behavior = "none"
        }
        headers_config {
          header_behavior = "none"
        }
        query_strings_config {
          query_string_behavior = "all"
        }
      }
    }`, [`aws_cloudfront_cache_policy.${name}`, "resource"]);
}

const frHcl: Family = {
  id: "fr-hcl",
  predicate: "freshness",
  language: "hcl",
  subject: "cdn.api-responses",
  scope: "infra:cdn",
  anchor: "aws_cloudfront_cache_policy.api",
  values: ["per-call", "ttl"],
  sibValues: ["per-call", "ttl"],
  baseline: "per-call",
  mech: {
    "per-call": "the api cache policy has min/default/max ttl 0, so every request goes to the origin",
    ttl: "the api cache policy caches responses for 300 s by default, up to 3600 s",
  },
  render({ s, sib }) {
    return [{ path: "infra/cdn.tf", blocks: [hclPolicy("api", s), hclPolicy("downloads", sib)] }];
  },
};

export const FRESHNESS: Family[] = [frTs, frPy, frGo, frC, frHcl];
