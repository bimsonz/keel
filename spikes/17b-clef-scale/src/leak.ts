// Leak check: Clef must see what the production adapter would send (diff
// hunks and code facts), never the answer. An item leaks when its state, or
// the subject/scope in its question, contains its own ground-truth lattice
// value or an obvious synonym of it.
//
// Text is normalised before matching: camelCase and snake_case are split, case
// is folded and punctuation becomes a space, so "perSessionCache",
// "PER_SESSION" and "per-session" all read "per session".
//
// Two classes of term:
//   anywhere - lattice ids and prose phrases. Matched against the whole
//              state: code, comments, string literals, symbol names, paths.
//   prose    - words that are also ordinary code (a Go `string`, zod
//              `.optional()`, a role literal "admin", a TTLCache `ttl=`).
//              In code they are the fact itself, which production sends, so
//              they are matched only in comments, symbol kinds and the
//              question's subject and scope.
import { LATTICES, type Predicate } from "./lattice.ts";

export interface LeakInput {
  id: string;
  predicate: Predicate;
  effect: string;
  subject: string;
  scope: string;
  hunks: { file: string; language: string; diff: string }[];
  symbols: { name: string; kind: string; file: string; status: string }[];
}

interface Terms {
  anywhere: string[];
  prose: string[];
}

const t = (anywhere: string[], prose: string[] = []): Terms => ({ anywhere, prose });

// Single-word lattice values that are ordinary code vocabulary.
const CODE_NATIVE_VALUES = new Set([
  "integer", "number", "string", "boolean", "array", "object",
  "owner", "admin", "maintainer", "member", "authenticated",
  "static", "required", "optional", "ttl", "many",
]);

export const SYNONYMS: Record<Predicate, Record<string, Terms>> = {
  freshness: {
    "per-call": t(["every call", "on every request", "each call", "per invocation", "every invocation", "each invocation", "not cached", "uncached", "no cache", "never cached", "without caching", "recomputed each", "recompute each", "always fresh"]),
    "per-request": t(["once per request", "each request", "every request", "request scoped", "request local", "request lifetime", "lifetime of the request", "dies with the request", "duration of the request", "within the request", "within a request", "within one request", "same request"]),
    "per-session": t(["session scoped", "for the session", "whole session", "lifetime of the session", "session lifetime", "until the session ends", "until logout", "logs out", "until sign out", "as long as the session", "session lives", "session cache", "session wide", "across requests", "warm session", "keyed by session"]),
    ttl: t(["time to live", "expires after", "expire after", "refresh every", "refreshed every", "refreshes every", "stale after", "cached for"], ["max age", "expiry", "expiration", "expires"]),
    static: t(["never refreshed", "never reloaded", "never refresh", "loaded once", "load once", "computed once", "once at startup", "at startup", "at boot", "at import", "import time", "life of the process", "lifetime of the process", "process lifetime", "until restart", "until the process restarts", "immutable snapshot"]),
  },
  cardinality: {
    "exactly-one": t(["exactly one", "always one", "precisely one", "one and only one", "always exactly", "never zero", "singleton"]),
    "at-most-one": t(["at most one", "zero or one", "no more than one", "only one", "single instance", "one at a time", "never two", "never more than one", "singleton", "mutual exclusion", "mutually exclusive"]),
    many: t(["any number", "multiple instances", "several instances", "more than one", "multiple replicas", "several replicas", "duplicates allowed", "allow duplicates", "no uniqueness", "not unique"]),
  },
  ordering: {
    fifo: t(["first in first out", "in order", "in the order", "total order", "strict order", "preserve order", "preserves order", "preserving order", "order preserved", "keeps order", "keep order", "ordered delivery", "sequentially", "one by one", "one at a time"]),
    "per-key-fifo": t(["per key", "per partition", "within a key", "within a partition", "within each partition", "within each key", "same key", "per aggregate", "per tenant", "partition order", "keyed order", "order per", "ordered per", "in order per"], ["ordering key"]),
    unordered: t(["out of order", "any order", "no order", "no ordering", "not ordered", "order not preserved", "order is not preserved", "without order", "arbitrary order", "random order"]),
  },
  consistency: {
    strong: t(["strongly", "linearizable", "linearisable", "never stale", "always current", "always up to date", "latest committed", "latest write", "always fresh", "read from the primary", "reads the primary"]),
    "read-your-writes": t(["read your own writes", "read after write", "own writes", "sees its own", "see its own", "see their own", "sees their own", "session consistency", "monotonic read"]),
    eventual: t(["eventually", "stale", "staleness", "lag", "lags", "lagging", "replication delay", "out of date", "may be behind", "catch up", "catches up"]),
  },
  presence: {
    required: t(["mandatory", "always present", "must be present", "never null", "never missing", "never absent", "non null", "not nullable", "cannot be null", "must be set", "must be provided"]),
    optional: t(["may be missing", "may be omitted", "may be null", "can be null", "can be omitted", "may be absent", "if present", "when present", "if provided", "when provided", "not required", "no longer required"], ["nullable", "omitempty"]),
    absent: t(["removed", "no longer", "deleted", "dropped", "deprecated", "gone"]),
  },
  authority: {
    owner: t(["only the owner", "owner only", "owners only"], ["owners", "owned"]),
    admin: t(["admins only", "admin only", "admins and owners", "owners and admins", "owner or admin", "admin or owner"], ["admins", "administrator", "administrators"]),
    maintainer: t(["maintainers and above", "maintainer or above", "maintainers only"], ["maintainers", "maintain"]),
    member: t(["any member", "all members", "every member", "members only", "whatever their role", "any role"], ["members", "membership"]),
    authenticated: t(["any authenticated", "any signed in", "any logged in", "any user", "anyone signed in", "anyone logged in", "non members"], ["logged in", "signed in"]),
    anyone: t(["everyone", "open to all", "no auth required", "without authentication", "no authentication", "no login required", "world readable", "world writable"], ["allow any", "all users", "public", "anonymous", "unauthenticated"]),
  },
  purity: {
    pure: t(["purely", "no side effect", "no side effects", "side effect free", "without side effects", "stateless", "referentially transparent", "deterministic"]),
    idempotent: t(["safe to retry", "safe to repeat", "retry safe", "exactly once", "at most once", "dedupe", "deduplicate", "dedup", "same end state", "no duplicates", "only once", "applied once"], ["idempotency"]),
    "non-idempotent": t(["not idempotent", "nonidempotent", "double charge", "charged twice", "charges twice", "twice", "duplicate", "duplicates", "each retry", "every retry", "again and again"]),
  },
  bound: Object.fromEntries(
    LATTICES.bound.values.map((v) => [v, v === "unbounded" ? t(["unlimited", "no limit", "no cap", "no maximum", "without limit", "without a limit", "uncapped", "limitless", "infinite", "grows without", "any size"]) : t([])]),
  ),
  shape: {
    integer: t(["whole number"], ["int", "int32", "int64", "uint", "uint64", "bigint", "i64", "long"]),
    number: t(["fractional", "floating point"], ["float", "float64", "double", "decimal", "numeric", "real"]),
    string: t(["stringified", "string encoded", "encoded as text"], ["str", "text", "varchar"]),
    boolean: t(["true or false"], ["bool"]),
    array: t([], ["list", "slice", "list of"]),
    object: t(["nested object", "key value"], ["map", "dict", "struct", "record", "hash"]),
  },
};

/** camelCase/snake_case split, case folded, punctuation to spaces, padded so " x " matches whole words. */
export function normalise(s: string): string {
  const split = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return ` ${split} `;
}

function contains(haystack: string, phrase: string): boolean {
  const p = normalise(phrase);
  return p.trim() !== "" && haystack.includes(p);
}

/** Comment text from a unified diff, by language. String literals count as code. */
export function commentText(diff: string, language: string): string {
  const out: string[] = [];
  const cStyle = ["typescript", "javascript", "go", "c", "hcl"].includes(language);
  const hash = ["python", "hcl"].includes(language);
  const dashDash = language === "sql";
  let inBlock = false;
  let inTriple: string | null = null;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("@@")) continue;
    const line = raw.slice(1);
    let quote: string | null = null;
    let buf = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const two = line.slice(i, i + 2);
      const three = line.slice(i, i + 3);
      if (inBlock) {
        if (two === "*/") { inBlock = false; i++; out.push(buf); buf = ""; continue; }
        buf += ch;
        continue;
      }
      if (inTriple) {
        if (three === inTriple) { inTriple = null; i += 2; out.push(buf); buf = ""; continue; }
        buf += ch;
        continue;
      }
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (language === "python" && (three === '"""' || three === "'''")) { inTriple = three; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (cStyle && two === "/*") { inBlock = true; i++; continue; }
      if ((cStyle && two === "//") || (hash && ch === "#") || (dashDash && two === "--")) {
        out.push(line.slice(i));
        break;
      }
    }
    if ((inBlock || inTriple) && buf) out.push(buf);
  }
  return out.join("\n");
}

const NUM_PHRASE = /(at most|no more than|up to|maximum of|max of|capped at|cap of|cap at|limit of|limited to|limit to|clamp to|clamped to)\s+(\d[\d,_]*)\s*(k|thousand|m|million)?\b/g;

function bucketOf(n: number): string {
  const edges: [number, string][] = [[1, "le-1"], [10, "le-10"], [100, "le-100"], [1_000, "le-1k"], [10_000, "le-10k"], [100_000, "le-100k"], [1_000_000, "le-1m"]];
  for (const [edge, v] of edges) if (n <= edge) return v;
  return "unbounded";
}

/** Every leak found for an item; empty means the item is clean. */
export function leaks(item: LeakInput): string[] {
  const found: string[] = [];
  const code = item.hunks.map((h) => h.diff).join("\n");
  const comments = item.hunks.map((h) => commentText(h.diff, h.language)).join("\n");
  const symbolCode = item.symbols.map((s) => `${s.name} ${s.file}`).join("\n");
  const symbolProse = item.symbols.map((s) => s.kind).join("\n");
  const question = `${item.subject}\n${item.scope}`;
  const anywhere = normalise([code, symbolCode, symbolProse, question].join("\n"));
  const prose = normalise([comments, symbolProse, question].join("\n"));

  // The lattice id itself (multi-word ids in every spelling, by normalisation).
  const native = CODE_NATIVE_VALUES.has(item.effect);
  if (contains(native ? prose : anywhere, item.effect)) {
    found.push(`${item.id}: ${native ? "comment/question" : "state"} contains the ground-truth value "${item.effect}"`);
  }
  const terms = SYNONYMS[item.predicate][item.effect];
  if (!terms) throw new Error(`${item.id}: no synonym list for ${item.predicate}=${item.effect}`);
  for (const phrase of terms.anywhere) {
    if (contains(anywhere, phrase)) found.push(`${item.id}: state contains "${phrase}", a synonym of ${item.effect}`);
  }
  for (const phrase of terms.prose) {
    if (contains(prose, phrase)) found.push(`${item.id}: comment/question contains "${phrase}", a synonym of ${item.effect}`);
  }
  if (item.predicate === "bound") {
    const proseRaw = [comments, question].join("\n").toLowerCase();
    for (const m of proseRaw.matchAll(NUM_PHRASE)) {
      let n = Number(m[2].replace(/[,_]/g, ""));
      if (m[3] === "k" || m[3] === "thousand") n *= 1_000;
      if (m[3] === "m" || m[3] === "million") n *= 1_000_000;
      if (bucketOf(n) === item.effect) found.push(`${item.id}: comment/question states the bound ("${m[0].trim()}")`);
    }
  }
  return found;
}
