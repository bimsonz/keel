// Migration 0013 through the real path: D1 runs it over agents and credentials
// written before it. It rebuilds `agents`, and a rebuild copies a named list of
// columns, so this holds it to every row, column and index that was there.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** The migration that rebuilds `agents`, by the number its file name starts with. */
const REBUILD = "0013";

const run = (sql: string, ...values: (string | number | null)[]) =>
  env.TEST_BACKFILL_DB.prepare(sql)
    .bind(...values)
    .run();
const all = async <Row = Record<string, unknown>>(sql: string) =>
  (await env.TEST_BACKFILL_DB.prepare(sql).all<Row>()).results;

/** What `agents` and `credentials` are made of: their columns and the indexes written for them. */
const shape = async () => ({
  agents: (await all<{ name: string }>(`PRAGMA table_info(agents)`)).map((column) => column.name),
  credentials: (await all<{ name: string }>(`PRAGMA table_info(credentials)`)).map(
    (column) => column.name,
  ),
  indexes: (
    await all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
       AND tbl_name IN ('agents', 'credentials') ORDER BY name`,
    )
  ).map((index) => index.name),
});

const rows = async () => ({
  agents: await all(`SELECT * FROM agents ORDER BY id`),
  credentials: await all(`SELECT * FROM credentials ORDER BY client_id`),
});

describe("migration 0013 over agents enrolled before it", () => {
  it("[migration.agents-rebuild] keeps every agent, every column and index it had and every credential, and lets an agent have no kind", async () => {
    await applyD1Migrations(
      env.TEST_BACKFILL_DB,
      env.TEST_MIGRATIONS.filter((migration) => migration.name < REBUILD),
    );
    // Each column holds something that is not its default in at least one row: a placed agent
    // with a sponsor a link event wrote, a suspended one, a revoked one, and one from before tenancy.
    await run(
      `INSERT INTO agents (id, name, kind, scopes, state, revocation_epoch, created_at, project_id, on_behalf_of, standing_seq, namespace_id, sponsor_user, sponsor_seq)
       VALUES ('agt_placed', 'placed', 'hosted', '["change:write"]', 'active', 0, 11, 'prj_one', NULL, 0, 'usr_ada', 'usr_ada', 7),
              ('agt_paused', 'paused', 'interactive', '[]', 'suspended', 0, 12, 'prj_one', NULL, 3, 'org_acme', 'usr_bob', 0),
              ('agt_revoked', 'revoked', 'synthetic', '[]', 'revoked', 2, 13, 'prj_two', NULL, 5, 'org_acme', NULL, 0),
              ('agt_legacy', 'legacy', 'human', '[]', 'active', 0, 14, '', 'someone', 0, NULL, NULL, 0)`,
    );
    await run(
      `INSERT INTO credentials (client_id, agent_id, secret_hash)
       VALUES ('kc_placed', 'agt_placed', 'hash-one'), ('kc_paused', 'agt_paused', 'hash-two')`,
    );
    const shapeBefore = await shape();
    const before = await rows();
    expect(before.agents).toHaveLength(4);

    await applyD1Migrations(
      env.TEST_BACKFILL_DB,
      env.TEST_MIGRATIONS.filter((migration) => migration.name.startsWith(REBUILD)),
    );

    const after = await rows();
    expect(after.agents).toEqual(before.agents.map((agent) => ({ ...agent, handle: null })));
    expect(after.credentials).toEqual(before.credentials);
    // Whatever a migration before this one gave the two tables is still there, by name.
    const shapeAfter = await shape();
    expect(shapeAfter.agents).toEqual([...shapeBefore.agents, "handle"]);
    expect(shapeAfter.credentials).toEqual(shapeBefore.credentials);
    expect(shapeAfter.indexes).toEqual(shapeBefore.indexes);
    expect(shapeBefore.indexes).toEqual([
      "agents_by_project",
      "agents_by_sponsor",
      "credentials_by_agent",
    ]);

    // An agent that signed up by key has no kind; a kind is still one of the four.
    await run(
      `INSERT INTO agents (id, name, kind, scopes, state, created_at, handle) VALUES ('agt_keyed', 'keyed', NULL, '[]', 'active', 15, 'agent-keyed')`,
    );
    await expect(
      run(
        `INSERT INTO agents (id, name, kind, scopes, state, created_at) VALUES ('agt_odd', 'odd', 'robot', '[]', 'active', 16)`,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
    // A credential still names an agent that is there.
    await expect(
      run(
        `INSERT INTO credentials (client_id, agent_id, secret_hash) VALUES ('kc_nobody', 'agt_nobody', 'hash')`,
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});
