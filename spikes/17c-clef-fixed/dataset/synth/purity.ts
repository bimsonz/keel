// Purity families: pure < idempotent < non-idempotent.
import { b, code, type Block, type Family } from "./types.ts";

const ALL = ["pure", "idempotent", "non-idempotent"];

// ---------- TypeScript: quote computation ----------
function tsQuote(fn: string, table: string, v: string): Block {
  const lines = [
    `export async function ${fn}(env: Env, input: QuoteInput): Promise<Quote> {`,
    `  const subtotal = input.lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);`,
    `  const quote = { subtotal, tax: Math.round(subtotal * input.taxRate), currency: input.currency };`,
  ];
  if (v === "idempotent") lines.push(`  await env.QUOTES.put(\`${table}:\${await digest(input)}\`, JSON.stringify(quote));`);
  if (v === "non-idempotent") lines.push(`  await env.DB.prepare("INSERT INTO ${table} (subtotal, tax, currency, created_at) VALUES (?, ?, ?, ?)").bind(quote.subtotal, quote.tax, quote.currency, Date.now()).run();`);
  lines.push("  return quote;", "}");
  return b(lines.join("\n"), [fn, "function"]);
}

const puTs: Family = {
  id: "pu-ts",
  predicate: "purity",
  language: "typescript",
  subject: "pricing.compute-quote",
  scope: "worker:pricing",
  anchor: "computeQuote",
  values: ALL,
  sibValues: ALL,
  baseline: "pure",
  mech: {
    pure: "computeQuote only computes from its input",
    idempotent: "computeQuote also writes the quote to KV under a key derived from a digest of its input, so repeating it rewrites the same entry",
    "non-idempotent": "computeQuote also INSERTs a new quotes row with created_at on every call",
  },
  render({ s, sib }) {
    return [{
      path: "src/pricing/quote.ts",
      blocks: [
        b(`import { digest } from "./digest.ts";\nimport type { Quote, QuoteInput } from "./types.ts";`),
        tsQuote("computeQuote", "quotes", s),
        tsQuote("previewQuote", "previews", sib),
      ],
    }];
  },
};

// ---------- Python: credit handler ----------
function pyCredit(fn: string, v: string, trap?: string): Block {
  const head = [`def ${fn}(conn, event: dict) -> Decimal:`, `    amount = Decimal(event["amount"]) * CREDIT_RATE`];
  const ins = {
    idempotent: [
      "    conn.execute(",
      '        text("INSERT INTO credits (event_id, account_id, amount) VALUES (:e, :a, :m) ON CONFLICT (event_id) DO NOTHING"),',
      '        {"e": event["id"], "a": event["account_id"], "m": amount},',
      "    )",
    ],
    "non-idempotent": [
      "    conn.execute(",
      '        text("UPDATE accounts SET credit = credit + :m WHERE id = :a"),',
      '        {"a": event["account_id"], "m": amount},',
      "    )",
    ],
    pure: [],
  }[v]!;
  const body = trap === "insert-on-conflict"
    ? [
        "    conn.execute(",
        '        text("INSERT INTO credits (event_id, account_id, amount) VALUES (:e, :a, :m) ON CONFLICT (event_id) DO NOTHING"),',
        '        {"e": event["id"], "a": event["account_id"], "m": amount},',
        "    )",
        "    conn.execute(",
        '        text("INSERT INTO credit_audit (event_id, seen_at) VALUES (:e, now()) ON CONFLICT (event_id) DO NOTHING"),',
        '        {"e": event["id"]},',
        "    )",
      ]
    : ins;
  return b([...head, ...body, "    return amount"].join("\n"), [fn, "function"]);
}

const puPy: Family = {
  id: "pu-py",
  predicate: "purity",
  language: "python",
  subject: "billing.invoice-paid-credit",
  scope: "service:billing",
  anchor: "apply_credit",
  values: ALL,
  sibValues: ALL,
  baseline: "idempotent",
  mech: {
    pure: "apply_credit only computes the credit amount and returns it",
    idempotent: "apply_credit inserts the credit keyed by event_id with ON CONFLICT DO NOTHING",
    "non-idempotent": "apply_credit adds the amount to accounts.credit with UPDATE ... credit = credit + :m on every call",
  },
  traps: [
    {
      name: "insert-on-conflict", value: "idempotent", premise: "idempotent",
      before: { s: "idempotent", sib: "idempotent" }, after: { s: "idempotent", sib: "idempotent", trap: "insert-on-conflict" },
      why: "A second INSERT is added, but it is also keyed by event_id with ON CONFLICT DO NOTHING, so a redelivered event changes nothing: idempotent.",
    },
  ],
  render({ s, sib, trap }) {
    return [{
      path: "billing/credits.py",
      blocks: [
        b("from decimal import Decimal\n\nfrom sqlalchemy import text\n\nCREDIT_RATE = Decimal(\"0.05\")"),
        pyCredit("apply_credit", s, trap),
        pyCredit("apply_referral_credit", sib),
      ],
    }];
  },
};

// ---------- Go: inventory reservation ----------
function goReserve(name: string, table: string, v: string): Block {
  if (v === "pure") {
    return b(code`
      func ${name}(order Order, stock map[string]int) []Line {
          var out []Line
          for _, l := range order.Lines {
              if stock[l.SKU] >= l.Qty {
                  out = append(out, l)
              }
          }
          return out
      }`, [name, "function"]);
  }
  const q = v === "idempotent"
    ? `INSERT INTO ${table} (order_id, sku, qty) VALUES ($1, $2, $3) ON CONFLICT (order_id, sku) DO UPDATE SET qty = EXCLUDED.qty`
    : `INSERT INTO ${table} (order_id, sku, qty, created_at) VALUES ($1, $2, $3, now())`;
  return b(code`
    func ${name}(ctx context.Context, tx *sql.Tx, order Order) error {
        for _, l := range order.Lines {
            if _, err := tx.ExecContext(ctx, "${q}", order.ID, l.SKU, l.Qty); err != nil {
                return err
            }
        }
        return nil
    }`, [name, "function"]);
}

const puGo: Family = {
  id: "pu-go",
  predicate: "purity",
  language: "go",
  subject: "inventory.reserve",
  scope: "service:inventory",
  anchor: "Reserve",
  values: ALL,
  sibValues: ALL,
  baseline: "idempotent",
  mech: {
    pure: "Reserve only filters the order lines against a stock map it is given",
    idempotent: "Reserve upserts one row per (order_id, sku) with ON CONFLICT DO UPDATE SET qty = EXCLUDED.qty",
    "non-idempotent": "Reserve INSERTs a new reservation row per line with created_at on every call",
  },
  render({ s, sib }) {
    return [{
      path: "internal/inventory/reserve.go",
      blocks: [
        b('package inventory\n\nimport (\n    "context"\n    "database/sql"\n)'),
        goReserve("Reserve", "reservations", s),
        goReserve("Hold", "holds", sib),
      ],
    }];
  },
};

// ---------- C: key-value command handlers ----------
function cHandler(fn: string, v: string): Block {
  const body =
    v === "pure" ? ["    return crc32(req->value, req->len);"]
    : v === "idempotent" ? ["    table_put(db, req->key, req->value, req->len);", "    return 0;"]
    : ["    log_append(db->wal, req->key, req->value, req->len);", "    db->version++;", "    return 0;"];
  return b([`int ${fn}(struct db *db, const struct request *req)`, "{", ...body, "}"].join("\n"), [fn, "function"]);
}

const puC: Family = {
  id: "pu-c",
  predicate: "purity",
  language: "c",
  subject: "kvd.command-handler",
  scope: "daemon:kvd",
  anchor: "handle_command",
  values: ALL,
  sibValues: ALL,
  baseline: "pure",
  mech: {
    pure: "handle_command only returns a checksum of the request value",
    idempotent: "handle_command overwrites the key in the table with table_put",
    "non-idempotent": "handle_command appends to the write-ahead log and increments db->version on every call",
  },
  render({ s, sib }) {
    return [{
      path: "src/handlers.c",
      blocks: [b('#include "db.h"\n#include "request.h"\n#include "util.h"'), cHandler("handle_command", s), cHandler("handle_probe", sib)],
    }];
  },
};

export const PURITY: Family[] = [puTs, puPy, puGo, puC];
