// Consistency families: strong < read-your-writes < eventual.
import { b, code, type Block, type Family } from "./types.ts";

const ALL = ["strong", "read-your-writes", "eventual"];

// ---------- TypeScript: D1 with read replication ----------
function tsRead(route: string, sql: string, v: string, trap?: string): Block {
  const open =
    trap === "first-primary" ? `c.env.DB.withSession("first-primary")`
    : v === "strong" ? `c.env.DB`
    : v === "read-your-writes" ? `c.env.DB.withSession(c.req.header("x-d1-bookmark") ?? "first-unconstrained")`
    : `c.env.DB.withSession("first-unconstrained")`;
  return b(code`
    app.get("${route}", async (c) => {
      const db = ${open};
      const row = await db.prepare("${sql}").bind(c.req.param("id")).first();
      return row ? c.json(row) : c.notFound();
    });`, [`GET ${route}`, "route"]);
}

function tsWrite(v: string): Block {
  const bookmark = v === "read-your-writes";
  const lines = [
    `app.post("/orders/:id/cancel", async (c) => {`,
    bookmark ? `  const db = c.env.DB.withSession("first-primary");` : `  const db = c.env.DB;`,
    `  await db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").bind(c.req.param("id")).run();`,
    ...(bookmark ? [`  c.header("x-d1-bookmark", db.getBookmark() ?? "");`] : []),
    `  return c.body(null, 204);`,
    `});`,
  ];
  return b(lines.join("\n"), ["POST /orders/:id/cancel", "route"]);
}

const coTs: Family = {
  id: "co-ts",
  predicate: "consistency",
  language: "typescript",
  subject: "orders.status-read",
  scope: "worker:orders",
  anchor: "GET /orders/:id",
  values: ALL,
  sibValues: ALL,
  baseline: "strong",
  mech: {
    strong: "GET /orders/:id queries env.DB without the Sessions API, which D1 sends to the primary",
    "read-your-writes": "the cancel route returns the D1 session bookmark and GET /orders/:id continues the caller's session from it",
    eventual: "GET /orders/:id uses withSession(\"first-unconstrained\") with no bookmark, so any replica may answer",
  },
  traps: [
    {
      name: "first-primary", value: "strong", premise: "strong",
      before: { s: "strong", sib: "strong" }, after: { s: "strong", sib: "strong", trap: "first-primary" },
      why: "The read moves to the D1 Sessions API, but with \"first-primary\": its only query goes to the primary, so it still sees the latest write: strong.",
    },
  ],
  render({ s, sib, trap }) {
    return [{
      path: "src/orders/routes.ts",
      blocks: [
        b(`import { Hono } from "hono";\n\nexport const app = new Hono<{ Bindings: Env }>();`),
        tsWrite(s),
        tsRead("/orders/:id", "SELECT id, status, updated_at FROM orders WHERE id = ?", s, trap),
        tsRead("/orders/:id/items", "SELECT sku, qty FROM order_items WHERE order_id = ?", sib),
      ],
    }];
  },
};

// ---------- Python: primary / replica routing ----------
function pyRead(fn: string, sql: string, v: string, trap?: string): Block {
  if (trap === "wait-for-replay") {
    return b(code`
      def ${fn}(account_id: int, written_lsn: str | None = None) -> Decimal:
          if written_lsn is not None:
              wait_for_replay(replica, written_lsn, timeout=2.0)
          with replica.connect() as conn:
              return conn.execute(text("${sql}"), {"id": account_id}).scalar_one()`, [fn, "function"]);
  }
  const body =
    v === "strong" ? [`    with primary.connect() as conn:`]
    : v === "eventual" ? [`    with replica.connect() as conn:`]
    : [
        `    engine = replica`,
        `    if written_lsn is not None and not replayed(replica, written_lsn):`,
        `        engine = primary`,
        `    with engine.connect() as conn:`,
      ];
  const sig = v === "read-your-writes" ? `def ${fn}(account_id: int, written_lsn: str | None = None) -> Decimal:` : `def ${fn}(account_id: int) -> Decimal:`;
  return b([sig, ...body, `        return conn.execute(text("${sql}"), {"id": account_id}).scalar_one()`].join("\n"), [fn, "function"]);
}

const coPy: Family = {
  id: "co-py",
  predicate: "consistency",
  language: "python",
  subject: "ledger.balance-read",
  scope: "service:ledger",
  anchor: "get_balance",
  values: ALL,
  sibValues: ALL,
  baseline: "strong",
  mech: {
    strong: "get_balance reads from the primary engine",
    "read-your-writes": "get_balance reads the replica unless the caller passes the LSN of its own last write and the replica has not replayed it, in which case it reads the primary",
    eventual: "get_balance reads from the asynchronous replica engine",
  },
  traps: [
    {
      name: "wait-for-replay", value: "read-your-writes", premise: "read-your-writes",
      before: { s: "read-your-writes", sib: "strong" }, after: { s: "read-your-writes", sib: "strong", trap: "wait-for-replay" },
      why: "Reads now always go to the replica, but first wait until it has replayed the caller's last-write LSN; the writer sees its writes, other readers may not: read-your-writes.",
    },
  ],
  render({ s, sib, trap }) {
    return [{
      path: "ledger/queries.py",
      blocks: [
        b("from decimal import Decimal\n\nfrom sqlalchemy import text\n\nfrom ledger.db import primary, replayed, replica, wait_for_replay"),
        pyRead("get_balance", "SELECT balance FROM accounts WHERE id = :id", s, trap),
        pyRead("get_credit_limit", "SELECT credit_limit FROM accounts WHERE id = :id", sib),
      ],
    }];
  },
};

// ---------- Go: settings reads ----------
function goRead(name: string, query: string, v: string): Block[] {
  const sig = `func (s *Store) ${name}(ctx context.Context, repoID int64) (string, error)`;
  if (v === "read-your-writes") {
    return [b(code`
      ${sig} {
          db := s.replica
          if w, ok := writtenAt(ctx, repoID); ok && time.Since(w) < s.replicaDelay {
              db = s.primary
          }
          var out string
          err := db.QueryRowContext(ctx, "${query}", repoID).Scan(&out)
          return out, err
      }`, [`Store.${name}`, "method"])];
  }
  return [b(code`
    ${sig} {
        var out string
        err := s.${v === "strong" ? "primary" : "replica"}.QueryRowContext(ctx, "${query}", repoID).Scan(&out)
        return out, err
    }`, [`Store.${name}`, "method"])];
}

const coGo: Family = {
  id: "co-go",
  predicate: "consistency",
  language: "go",
  subject: "repo.default-branch-read",
  scope: "service:forge",
  anchor: "Store.DefaultBranch",
  values: ALL,
  sibValues: ALL,
  baseline: "strong",
  mech: {
    strong: "DefaultBranch queries s.primary",
    "read-your-writes": "DefaultBranch reads s.replica unless this caller wrote the repo within the replica delay (writtenAt from its context), then s.primary",
    eventual: "DefaultBranch queries s.replica, an asynchronous follower",
  },
  render({ s, sib }) {
    return [{
      path: "internal/repos/store.go",
      blocks: [
        b(code`
          package repos

          import (
              "context"
              "database/sql"
              "time"
          )

          type Store struct {
              primary      *sql.DB
              replica      *sql.DB
              replicaDelay time.Duration
          }`),
        ...goRead("DefaultBranch", "SELECT default_branch FROM repos WHERE id = $1", s),
        ...goRead("Description", "SELECT description FROM repos WHERE id = $1", sib),
      ],
    }];
  },
};

export const CONSISTENCY: Family[] = [coTs, coPy, coGo];
