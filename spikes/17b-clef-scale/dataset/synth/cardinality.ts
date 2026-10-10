// Cardinality families: exactly-one < at-most-one < many.
import { b, code, type Block, type Family } from "./types.ts";

const ALL = ["exactly-one", "at-most-one", "many"];

// ---------- TypeScript: process-wide clients ----------
function tsCard(name: string, cls: string, arg: string, v: string): Block[] {
  switch (v) {
    case "exactly-one":
      return [b(`export const ${name} = new ${cls}(${arg});`, [name, "const"])];
    case "at-most-one":
      return [
        b(`let ${name}Instance: ${cls} | undefined;`, [`${name}Instance`, "variable"]),
        b(code`
          export function ${name}(): ${cls} {
            ${name}Instance ??= new ${cls}(${arg});
            return ${name}Instance;
          }`, [name, "function"]),
      ];
    case "many":
      return [b(code`
        export function ${name}(): ${cls} {
          return new ${cls}(${arg});
        }`, [name, "function"])];
  }
  throw new Error(v);
}

const caTs: Family = {
  id: "ca-ts",
  predicate: "cardinality",
  language: "typescript",
  subject: "search.index-writer",
  scope: "service:search (per process)",
  anchor: "indexWriter",
  values: ALL,
  sibValues: ALL,
  baseline: "exactly-one",
  mech: {
    "exactly-one": "indexWriter is a module-level const constructed eagerly when the module loads",
    "at-most-one": "indexWriter lazily constructs one instance on first call and reuses it (??=)",
    many: "indexWriter constructs a new IndexWriter on every call",
  },
  render({ s, sib }) {
    return [{
      path: "src/search/clients.ts",
      blocks: [
        b(`import { IndexWriter, QueryParser } from "./engine.ts";\n\nconst INDEX_DIR = "/var/lib/search/index";`),
        ...tsCard("indexWriter", "IndexWriter", "INDEX_DIR", s),
        ...tsCard("queryParser", "QueryParser", "{ fuzzy: true }", sib),
      ],
    }];
  },
};

// ---------- Go: process-wide registries ----------
function goCard(name: string, ctor: string, T: string, v: string): Block[] {
  switch (v) {
    case "exactly-one":
      return [b(`var ${name} = ${ctor}`, [name, "var"])];
    case "at-most-one":
      return [
        b(code`
          var (
              ${name}Once sync.Once
              ${name}Val  ${T}
          )`, [`${name}Once`, "var"]),
        b(code`
          func ${name[0].toUpperCase()}${name.slice(1)}() ${T} {
              ${name}Once.Do(func() { ${name}Val = ${ctor} })
              return ${name}Val
          }`, [`${name[0].toUpperCase()}${name.slice(1)}`, "function"]),
      ];
    case "many":
      return [b(code`
        func ${name[0].toUpperCase()}${name.slice(1)}() ${T} {
            return ${ctor}
        }`, [`${name[0].toUpperCase()}${name.slice(1)}`, "function"])];
  }
  throw new Error(v);
}

const caGo: Family = {
  id: "ca-go",
  predicate: "cardinality",
  language: "go",
  subject: "metrics.registry",
  scope: "service:gateway (per process)",
  anchor: "Registry",
  values: ALL,
  sibValues: ALL,
  baseline: "exactly-one",
  mech: {
    "exactly-one": "Registry is a package-level var initialised when the package loads",
    "at-most-one": "Registry() creates the registry lazily inside a sync.Once",
    many: "Registry() returns prometheus.NewRegistry() on every call",
  },
  render({ s, sib }) {
    const reg = goCard("registry", "prometheus.NewRegistry()", "*prometheus.Registry", s);
    // keep the exported name stable for the eager form
    if (s === "exactly-one") reg[0] = b(`var Registry = prometheus.NewRegistry()`, ["Registry", "var"]);
    const cl = goCard("httpClient", "&http.Client{Timeout: 10 * time.Second}", "*http.Client", sib);
    if (sib === "exactly-one") cl[0] = b(`var HTTPClient = &http.Client{Timeout: 10 * time.Second}`, ["HTTPClient", "var"]);
    return [{
      path: "internal/metrics/registry.go",
      blocks: [
        b(code`
          package metrics

          import (
              "net/http"
              "sync"
              "time"

              "github.com/prometheus/client_golang/prometheus"
          )`),
        ...reg,
        ...cl,
      ],
    }];
  },
};

// ---------- Python: primary email per user (SQLAlchemy) ----------
const caPy: Family = {
  id: "ca-py",
  predicate: "cardinality",
  language: "python",
  subject: "accounts.primary-email",
  scope: "db:accounts, per user",
  anchor: "UserEmail",
  values: ALL,
  sibValues: ["at-most-one", "many"],
  baseline: "at-most-one",
  mech: {
    "exactly-one": "User.primary_email_id is a NOT NULL foreign key, so every user has exactly one primary address",
    "at-most-one": "a partial unique index on user_emails(user_id) WHERE is_primary allows zero or one primary address per user",
    many: "is_primary is a plain boolean with no unique index, so a user can have several primary addresses",
  },
  sibMech: {
    "at-most-one": "a partial unique index on user_emails(user_id) WHERE is_recovery",
    many: "is_recovery has no unique index",
  },
  render({ s, sib }) {
    const user = code`
      class User(Base):
          __tablename__ = "users"

          id: Mapped[int] = mapped_column(primary_key=True)
          username: Mapped[str] = mapped_column(String(64), unique=True)`;
    const userFk = `\n    primary_email_id: Mapped[int] = mapped_column(ForeignKey("user_emails.id", use_alter=True), nullable=False)`;
    const idx: string[] = [];
    if (s === "at-most-one") idx.push(`        Index("ix_user_emails_user_primary", "user_id", unique=True, postgresql_where=text("is_primary")),`);
    if (sib === "at-most-one") idx.push(`        Index("ix_user_emails_user_recovery", "user_id", unique=True, postgresql_where=text("is_recovery")),`);
    const emailLines = [
      "class UserEmail(Base):",
      '    __tablename__ = "user_emails"',
      ...(idx.length ? ["    __table_args__ = (", ...idx, "    )"] : []),
      "",
      "    id: Mapped[int] = mapped_column(primary_key=True)",
      '    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)',
      "    address: Mapped[str] = mapped_column(String(320))",
      ...(s === "exactly-one" ? [] : ["    is_primary: Mapped[bool] = mapped_column(default=False)"]),
      "    is_recovery: Mapped[bool] = mapped_column(default=False)",
    ];
    return [{
      path: "accounts/models.py",
      blocks: [
        b("from sqlalchemy import ForeignKey, Index, String, text\nfrom sqlalchemy.orm import Mapped, mapped_column\n\nfrom accounts.db import Base"),
        b(s === "exactly-one" ? user + userFk : user, ["User", "class"]),
        b(emailLines.join("\n"), ["UserEmail", "class"]),
      ],
    }];
  },
};

// ---------- HCL: ECS services ----------
function ecs(name: string, v: string): Block {
  const [count, min, max] = v === "at-most-one" ? [1, 0, 100] : [3, 50, 200];
  return b(code`
    resource "aws_ecs_service" "${name}" {
      name            = "${name}"
      cluster         = aws_ecs_cluster.main.id
      task_definition = aws_ecs_task_definition.${name}.arn
      launch_type     = "FARGATE"

      desired_count                      = ${count}
      deployment_minimum_healthy_percent = ${min}
      deployment_maximum_percent         = ${max}
    }`, [`aws_ecs_service.${name}`, "resource"]);
}

const caHcl: Family = {
  id: "ca-hcl",
  predicate: "cardinality",
  language: "hcl",
  subject: "jobs.cron-runner",
  scope: "infra:ecs",
  anchor: "aws_ecs_service.cron_runner",
  values: ["at-most-one", "many"],
  sibValues: ["at-most-one", "many"],
  baseline: "many",
  mech: {
    "at-most-one": "desired_count 1 with deployment maximum 100% and minimum 0%, so a deploy stops the old task before starting the new one",
    many: "desired_count 3 (deployment maximum 200%), so several runner tasks run at once",
  },
  traps: [
    {
      name: "count-meta", value: "at-most-one", premise: "at-most-one",
      before: { s: "at-most-one", sib: "many" }, after: { s: "at-most-one", sib: "many", trap: "count-meta" },
      why: "A count meta-argument is added, but it is var.cron_enabled ? 1 : 0 and the service keeps desired_count 1 with maximum 100%: still zero or one runner.",
    },
  ],
  render({ s, sib, trap }) {
    let runner = ecs("cron_runner", s);
    if (trap === "count-meta") {
      runner = b(runner.code.replace('resource "aws_ecs_service" "cron_runner" {\n', 'resource "aws_ecs_service" "cron_runner" {\n  count           = var.cron_enabled ? 1 : 0\n'), runner.sym);
    }
    return [{ path: "infra/services.tf", blocks: [runner, ecs("web", sib)] }];
  },
};

// ---------- C: single-instance daemon ----------
const caC: Family = {
  id: "ca-c",
  predicate: "cardinality",
  language: "c",
  subject: "syncd.instance",
  scope: "daemon:syncd (per host)",
  anchor: "main",
  values: ["at-most-one", "many"],
  sibValues: [],
  baseline: "at-most-one",
  mech: {
    "at-most-one": "main takes flock(LOCK_EX | LOCK_NB) on the lock file and exits if it is held",
    many: "main no longer takes the lock, so any number of syncd processes can run",
  },
  render({ s }) {
    const lock = code`
      static int acquire_lock(const char *path)
      {
          int fd = open(path, O_RDWR | O_CREAT, 0644);
          if (fd < 0)
              return -1;
          if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
              close(fd);
              return -1;
          }
          return fd;
      }`;
    const mainLocked = code`
      int main(int argc, char **argv)
      {
          struct options opts;
          if (parse_options(argc, argv, &opts) != 0)
              return 2;
          if (acquire_lock(LOCK_PATH) < 0) {
              fprintf(stderr, "syncd: %s is held\\n", LOCK_PATH);
              return 1;
          }
          return run(&opts);
      }`;
    const mainFree = code`
      int main(int argc, char **argv)
      {
          struct options opts;
          if (parse_options(argc, argv, &opts) != 0)
              return 2;
          return run(&opts);
      }`;
    return [{
      path: "src/main.c",
      blocks: [
        b('#include <fcntl.h>\n#include <stdio.h>\n#include <sys/file.h>\n#include <unistd.h>\n\n#include "options.h"\n#include "run.h"\n\n#define LOCK_PATH "/run/syncd.lock"'),
        ...(s === "at-most-one" ? [b(lock, ["acquire_lock", "function"])] : []),
        b(s === "at-most-one" ? mainLocked : mainFree, ["main", "function"]),
      ],
    }];
  },
};

export const CARDINALITY: Family[] = [caTs, caGo, caPy, caHcl, caC];
