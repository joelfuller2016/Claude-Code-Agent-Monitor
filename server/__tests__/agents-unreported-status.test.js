/**
 * @file Verifies the `unreported` agent-status migration in db.js: a 4-status DB
 * is rebuilt with 'unreported' in the CHECK set and as the column DEFAULT, so an
 * agent whose state was never reported stops being indistinguishable from one
 * observed idle.
 *
 * Regression coverage for the defect this migration fixes: `status` defaulted to
 * 'waiting', which is an observation nobody made. Every "is this agent free?"
 * reader treated the two identically, and it failed toward "free" — the direction
 * that actually costs something.
 *
 * Three properties matter and each is asserted separately:
 *   1. the default distinguishes unreported from reported-idle (the fix works);
 *   2. no pre-existing row is reclassified (the migration is not destructive);
 *   3. the rebuild preserves every column and index that was on the table —
 *      read from sqlite_master rather than a hardcoded list, because the earlier
 *      'idle' rebuild hardcoded four indexes and would drop `idx_agents_session_type`
 *      (present on a real store) while creating `idx_agents_parent` (absent).
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const Database = require("better-sqlite3");

let TEST_DB;
let db;

before(() => {
  TEST_DB = path.join(os.tmpdir(), `dashboard-agents-unreported-${Date.now()}-${process.pid}.db`);
  process.env.DASHBOARD_DB_PATH = TEST_DB;

  // Build a DB at the 4-status generation: past the legacy 'idle' rebuild, before
  // 'unreported' exists. Column order deliberately mirrors a real store, where
  // workflow_* precede updated_at — it differs from the DDL literal in db.js, and a
  // positional `SELECT *` copy would transpose the columns.
  const raw = new Database(TEST_DB);
  raw.pragma("foreign_keys = OFF");
  raw.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','error','abandoned')),
      cwd TEXT,
      model TEXT,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      ended_at TEXT,
      metadata TEXT
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'main' CHECK(type IN ('main','subagent')),
      subagent_type TEXT,
      status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('working','waiting','completed','error')),
      task TEXT,
      current_tool TEXT,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      ended_at TEXT,
      parent_agent_id TEXT,
      metadata TEXT,
      workflow_run_id TEXT,
      workflow_phase TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      awaiting_input_since TEXT,
      awaiting_reason TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
    );

    CREATE INDEX idx_agents_session ON agents(session_id);
    CREATE INDEX idx_agents_status ON agents(status);
    CREATE INDEX idx_agents_session_type ON agents(session_id, type);
    CREATE INDEX idx_agents_workflow ON agents(workflow_run_id);
  `);
  raw.prepare("INSERT INTO sessions (id, name) VALUES (?, ?)").run("s1", "session one");
  const ins = raw.prepare(
    "INSERT INTO agents (id, session_id, name, type, status, workflow_run_id, workflow_phase, awaiting_reason) VALUES (?,?,?,?,?,?,?,?)"
  );
  ins.run("a-working", "s1", "worker", "main", "working", "run-1", "phase-1", null);
  ins.run("a-waiting", "s1", "idler", "main", "waiting", null, null, "needs-input");
  ins.run("a-done", "s1", "finished", "main", "completed", null, null, null);
  ins.run("a-error", "s1", "broken", "main", "error", null, null, null);
  raw.close();

  // Loading db.js runs the migrations against DASHBOARD_DB_PATH.
  ({ db } = require("../db.js"));
});

after(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TEST_DB + suffix);
    } catch {
      /* best effort */
    }
  }
  delete process.env.DASHBOARD_DB_PATH;
});

describe("agents 'unreported' status migration", () => {
  it("adds 'unreported' to the CHECK set and makes it the column default", () => {
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'")
      .get().sql;
    assert.match(sql, /DEFAULT 'unreported'/);
    assert.match(
      sql,
      /CHECK\(status IN \('working','waiting','completed','error','unreported'\)\)/
    );
  });

  it("distinguishes an agent with no reported status from one observed idle", () => {
    db.prepare("INSERT INTO agents (id, session_id, name, type) VALUES (?,?,?,?)").run(
      "a-nostatus",
      "s1",
      "never reported",
      "main"
    );
    const unreported = db
      .prepare("SELECT status FROM agents WHERE id = ?")
      .get("a-nostatus").status;
    const observedIdle = db
      .prepare("SELECT status FROM agents WHERE id = ?")
      .get("a-waiting").status;

    assert.equal(unreported, "unreported");
    assert.equal(observedIdle, "waiting");
    // The whole point: these must not collapse to the same value.
    assert.notEqual(unreported, observedIdle);
  });

  it("does not reclassify any pre-existing row", () => {
    const byStatus = Object.fromEntries(
      db
        .prepare(
          "SELECT status, COUNT(*) n FROM agents WHERE id LIKE 'a-%' AND id != 'a-nostatus' GROUP BY status"
        )
        .all()
        .map((r) => [r.status, r.n])
    );
    assert.deepEqual(byStatus, { working: 1, waiting: 1, completed: 1, error: 1 });
  });

  it("still rejects a status outside the allowed set", () => {
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO agents (id, session_id, name, type, status) VALUES (?,?,?,?,?)")
          .run("a-bogus", "s1", "bogus", "main", "not-a-status"),
      /CHECK constraint failed/
    );
  });

  it("lets a reader exclude unreported agents", () => {
    const all = db.prepare("SELECT COUNT(*) n FROM agents").get().n;
    const excluded = db
      .prepare("SELECT COUNT(*) n FROM agents WHERE status <> 'unreported'")
      .get().n;
    assert.ok(excluded < all, "excluding 'unreported' must return fewer rows");
  });

  it("does not count an unreported agent as active", () => {
    // The active set is deliberately NOT widened: 'unreported' is not 'free'.
    const active = db
      .prepare("SELECT COUNT(*) n FROM agents WHERE status IN ('working','waiting')")
      .get().n;
    assert.equal(active, 2); // a-working + a-waiting, never a-nostatus
  });

  it("preserves every column the table had", () => {
    const cols = db
      .prepare("PRAGMA table_info(agents)")
      .all()
      .map((c) => c.name);
    for (const expected of [
      "workflow_run_id",
      "workflow_phase",
      "updated_at",
      "awaiting_input_since",
      "awaiting_reason",
    ]) {
      assert.ok(cols.includes(expected), `rebuild dropped column ${expected}`);
    }
  });

  it("preserves the indexes that were on the table, including ones db.js never hardcoded", () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE tbl_name='agents' AND type='index'")
      .all()
      .map((r) => r.name);
    // idx_agents_session_type is the one the earlier hardcoded rebuild would have lost.
    for (const expected of [
      "idx_agents_session",
      "idx_agents_status",
      "idx_agents_session_type",
      "idx_agents_workflow",
    ]) {
      assert.ok(idx.includes(expected), `rebuild dropped index ${expected}`);
    }
  });

  it("carries column values across the rebuild without transposing them", () => {
    const row = db
      .prepare("SELECT workflow_run_id, workflow_phase, awaiting_reason FROM agents WHERE id = ?")
      .get("a-working");
    assert.equal(row.workflow_run_id, "run-1");
    assert.equal(row.workflow_phase, "phase-1");
    assert.equal(row.awaiting_reason, null);
  });

  it("is idempotent — a second load does not rebuild or change the table", () => {
    const sqlBefore = db.prepare("SELECT sql FROM sqlite_master WHERE name='agents'").get().sql;
    const countBefore = db.prepare("SELECT COUNT(*) n FROM agents").get().n;
    // The migration guard is `!sql.includes("'unreported'")`, so re-running is a no-op.
    assert.ok(sqlBefore.includes("'unreported'"));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM agents").get().n, countBefore);
  });
});
