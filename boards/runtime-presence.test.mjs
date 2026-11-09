import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

import { signupAgent } from "./agents.mjs";
import {
  FADING_MS,
  LIVE_MS,
  TERMINAL_RETENTION_MS,
  RuntimePresenceConflictError,
  RuntimePresenceValidationError,
  dropRuntimePresence,
  listRuntimePresence,
  upsertRuntimePresence,
} from "./runtime-presence.mjs";
import { SCHEMA_VERSION, openRegistry, upsertBoard } from "./registry.mjs";

const tmp_root = fs.mkdtempSync(
  path.join(os.tmpdir(), "feads-runtime-presence-"),
);
let db_seq = 0;

function freshDb() {
  db_seq += 1;
  const db = openRegistry({
    path: path.join(tmp_root, `runtime-${db_seq}.db`),
  });
  upsertBoard(db, {
    id: "main",
    name: "Main",
    board_dir: path.join(tmp_root, `board-${db_seq}`),
  });
  return db;
}

function row(overrides = {}) {
  return {
    session_id: "session-1",
    runtime_id: "runtime-1",
    run_id: "runtime-1",
    parent_run_id: "",
    kind: "main",
    handle: "main",
    display_name: "Runtime session",
    status: "working",
    model: "example/sol",
    activity: "thinking",
    context_percent: 37.2,
    started_at: 1_000,
    ...overrides,
  };
}

function agent(db, display_name) {
  return signupAgent(db, {
    board_id: "main",
    display_name,
    actor: display_name,
  }).agent;
}

beforeEach(() => {
  // Keep each test independent while using the shared temp root for cleanup.
});

after(() => fs.rmSync(tmp_root, { recursive: true, force: true }));

describe("registry v7 schema", () => {
  test("creates the exact additive runtime table and indexes", () => {
    const db = freshDb();

    const columns = db
      .prepare(
        'SELECT name, type, "notnull" AS nn, dflt_value FROM pragma_table_info(?) ORDER BY cid',
      )
      .all("agent_runtime_presence")
      .map((column) => ({
        name: column.name,
        type: column.type,
        notnull: column.nn,
        dflt_value: column.dflt_value,
      }));
    assert.deepEqual(columns, [
      { name: "agent_id", type: "TEXT", notnull: 1, dflt_value: null },
      { name: "session_id", type: "TEXT", notnull: 1, dflt_value: null },
      { name: "runtime_id", type: "TEXT", notnull: 1, dflt_value: null },
      { name: "run_id", type: "TEXT", notnull: 1, dflt_value: null },
      { name: "parent_run_id", type: "TEXT", notnull: 1, dflt_value: "''" },
      { name: "kind", type: "TEXT", notnull: 1, dflt_value: null },
      { name: "handle", type: "TEXT", notnull: 1, dflt_value: "''" },
      { name: "display_name", type: "TEXT", notnull: 1, dflt_value: "''" },
      { name: "status", type: "TEXT", notnull: 1, dflt_value: null },
      { name: "model", type: "TEXT", notnull: 1, dflt_value: "''" },
      { name: "activity", type: "TEXT", notnull: 1, dflt_value: "''" },
      { name: "context_percent", type: "REAL", notnull: 1, dflt_value: "0" },
      { name: "started_at", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "ended_at", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "heartbeat_at", type: "INTEGER", notnull: 1, dflt_value: null },
      { name: "client", type: "TEXT", notnull: 1, dflt_value: "''" },
    ]);
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'agent_runtime_presence_%'
         ORDER BY name`,
      )
      .all()
      .map((item) => item.name);
    assert.deepEqual(indexes, [
      "agent_runtime_presence_agent_idx",
      "agent_runtime_presence_expiry_idx",
    ]);
    assert.equal(
      Number(db.prepare("SELECT version FROM schema_meta").get().version),
      SCHEMA_VERSION,
    );

    db.close();
  });

  test("reopens a v6 registry idempotently and preserves unknown tables", () => {
    const db_path = path.join(tmp_root, "v6-reopen.db");
    const first = openRegistry({ path: db_path });
    first.exec("CREATE TABLE preserved_by_migration (value TEXT NOT NULL)");
    first
      .prepare("INSERT INTO preserved_by_migration (value) VALUES (?)")
      .run("kept");
    first.exec("DROP TABLE agent_runtime_presence");
    first.prepare("UPDATE schema_meta SET version = 6").run();
    first.close();

    const reopened = openRegistry({ path: db_path });

    assert.equal(
      reopened.prepare("SELECT version FROM schema_meta").get().version,
      SCHEMA_VERSION,
    );
    assert.equal(
      reopened.prepare("SELECT value FROM preserved_by_migration").get().value,
      "kept",
    );
    assert.ok(
      reopened
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runtime_presence'",
        )
        .get(),
    );
    reopened.close();
  });
});

describe("registry client column migration", () => {
  test("adds client to a pre-client runtime table idempotently", () => {
    const db_path = path.join(tmp_root, "pre-client.db");
    const first = openRegistry({ path: db_path });
    upsertBoard(first, {
      id: "main",
      name: "Main",
      board_dir: path.join(tmp_root, "board-pre-client"),
    });
    const owner = agent(first, "legacy-owner");
    upsertRuntimePresence(first, owner, [row()], 1_000);
    first.exec("ALTER TABLE agent_runtime_presence DROP COLUMN client");
    first.close();

    const reopened = openRegistry({ path: db_path });
    const has_client = () =>
      reopened
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all("agent_runtime_presence")
        .filter((column) => column.name === "client").length;
    assert.equal(has_client(), 1);
    const [existing] = listRuntimePresence(reopened, { now: 1_000 });
    assert.equal(existing.client, "");
    reopened.close();

    const again = openRegistry({ path: db_path });
    assert.equal(
      again
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all("agent_runtime_presence")
        .filter((column) => column.name === "client").length,
      1,
    );
    again.close();
  });
});

describe("runtime presence storage", () => {
  let db;

  beforeEach(() => {
    db = freshDb();
  });

  test("advances the owner's last_seen_at in the same transaction", () => {
    const owner = agent(db, "owner-one");
    const before = db
      .prepare("SELECT last_seen_at FROM agents WHERE id = ?")
      .get(owner.id).last_seen_at;

    upsertRuntimePresence(db, owner, [row()], 1_000_000);

    const after = db
      .prepare("SELECT last_seen_at FROM agents WHERE id = ?")
      .get(owner.id).last_seen_at;
    assert.equal(after, 1_000_000);
    assert.notEqual(after, before);
  });

  test("stores multiple sessions, incarnations, and children under one owner", () => {
    const owner = agent(db, "owner-one");
    const now = 1_000_000;
    upsertRuntimePresence(
      db,
      owner,
      [
        row({
          session_id: "session-a",
          runtime_id: "runtime-a",
          run_id: "runtime-a",
        }),
        row({
          session_id: "session-a",
          runtime_id: "runtime-a",
          run_id: "child-a",
          parent_run_id: "runtime-a",
          kind: "subagent",
          handle: "report-ui",
        }),
        row({
          session_id: "session-a",
          runtime_id: "runtime-b",
          run_id: "runtime-b",
          display_name: "Resumed session",
        }),
        row({
          session_id: "session-b",
          runtime_id: "runtime-c",
          run_id: "runtime-c",
          display_name: "Second transcript",
        }),
      ],
      now,
    );

    const listed = listRuntimePresence(db, { now });

    assert.equal(listed.length, 4);
    assert.deepEqual(listed.map((item) => item.run_id).sort(), [
      "child-a",
      "runtime-a",
      "runtime-b",
      "runtime-c",
    ]);
    assert.ok(listed.every((item) => item.actor === "owner-one"));
    assert.equal(
      listed.find((item) => item.run_id === "child-a").parent_run_id,
      "runtime-a",
    );
  });

  test("refreshes the same owner tuple without changing its first start time", () => {
    const owner = agent(db, "owner-one");
    upsertRuntimePresence(db, owner, [row({ started_at: 10 })], 1_000);
    const result = upsertRuntimePresence(
      db,
      owner,
      [row({ display_name: "Updated", context_percent: 101, started_at: 900 })],
      2_000,
    );

    const listed = listRuntimePresence(db, { now: 2_000 });

    assert.equal(result.accepted, 1);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].heartbeat_at, 2_000);
    assert.equal(listed[0].started_at, 10);
    assert.equal(listed[0].display_name, "Updated");
    assert.equal(listed[0].context_percent, 100);
  });

  test("keeps owners isolated for update and deletion", () => {
    const first = agent(db, "owner-one");
    const second = agent(db, "owner-two");
    upsertRuntimePresence(db, first, [row()], 1_000);
    upsertRuntimePresence(db, second, [row()], 2_000);

    const removed = dropRuntimePresence(db, second, "runtime-1", ["runtime-1"]);
    const listed = listRuntimePresence(db, { now: 2_000 });

    assert.equal(removed, 1);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].agent_id, first.id);
    assert.equal(
      dropRuntimePresence(db, second, "runtime-1", ["runtime-1"]),
      0,
    );
  });

  test("rejects a runtime session change and preserves the transaction", () => {
    const owner = agent(db, "owner-one");
    upsertRuntimePresence(db, owner, [row()], 1_000);

    assert.throws(
      () =>
        upsertRuntimePresence(db, owner, [row({ session_id: "other" })], 2_000),
      RuntimePresenceConflictError,
    );
    assert.equal(
      listRuntimePresence(db, { now: 2_000 })[0].session_id,
      "session-1",
    );
    assert.equal(
      db.prepare("SELECT last_seen_at FROM agents WHERE id = ?").get(owner.id)
        .last_seen_at,
      1_000,
      "a rejected heartbeat must roll back the durable-agent activity update",
    );
  });

  test("progresses active rows to terminal and makes terminal status final", () => {
    const owner = agent(db, "owner-one");
    upsertRuntimePresence(db, owner, [row()], 1_000);
    upsertRuntimePresence(db, owner, [row({ status: "done" })], 2_000);

    const terminal = listRuntimePresence(db, { now: 2_000 })[0];
    assert.equal(terminal.status, "done");
    assert.equal(terminal.ended_at, 2_000);
    assert.equal(terminal.heartbeat_at, 2_000);
    assert.equal(terminal.liveness, "terminal");

    assert.throws(
      () =>
        upsertRuntimePresence(db, owner, [row({ status: "working" })], 3_000),
      RuntimePresenceConflictError,
    );
    assert.equal(listRuntimePresence(db, { now: 3_000 })[0].status, "done");
  });

  test("uses server heartbeat time for live, fading, and crash expiry", () => {
    const owner = agent(db, "owner-one");
    upsertRuntimePresence(db, owner, [row()], 1_000);

    assert.equal(
      listRuntimePresence(db, { now: 1_000 + LIVE_MS - 1 })[0].liveness,
      "live",
    );
    assert.equal(
      listRuntimePresence(db, { now: 1_000 + LIVE_MS })[0].liveness,
      "fading",
    );
    assert.equal(
      listRuntimePresence(db, { now: 1_000 + FADING_MS }).length,
      1,
      "the exact 90-second boundary remains fading",
    );
    assert.equal(
      listRuntimePresence(db, { now: 1_000 + FADING_MS + 1 }).length,
      0,
    );
  });

  test("retains terminal history for five minutes and then purges it", () => {
    const owner = agent(db, "owner-one");
    upsertRuntimePresence(db, owner, [row({ status: "failed" })], 1_000);

    assert.equal(
      listRuntimePresence(db, { now: 1_000 + TERMINAL_RETENTION_MS }).length,
      1,
    );
    assert.equal(
      listRuntimePresence(db, { now: 1_000 + TERMINAL_RETENTION_MS + 1 })
        .length,
      0,
    );
  });

  test("removes only active rows and is idempotent", () => {
    const owner = agent(db, "owner-one");
    upsertRuntimePresence(
      db,
      owner,
      [
        row(),
        row({
          run_id: "child",
          parent_run_id: "runtime-1",
          kind: "subagent",
          status: "aborted",
        }),
      ],
      1_000,
    );

    assert.equal(dropRuntimePresence(db, owner, "runtime-1"), 1);
    assert.equal(dropRuntimePresence(db, owner, "runtime-1"), 0);
    assert.deepEqual(
      listRuntimePresence(db, { now: 1_000 }).map((item) => item.run_id),
      ["child"],
    );
  });

  test("excludes revoked, archived, and expired owners", () => {
    const revoked = agent(db, "revoked-owner");
    const archived = agent(db, "archived-owner");
    const expired = agent(db, "expired-owner");
    upsertRuntimePresence(
      db,
      revoked,
      [row({ runtime_id: "revoked", run_id: "revoked" })],
      1_000,
    );
    upsertRuntimePresence(
      db,
      archived,
      [row({ runtime_id: "archived", run_id: "archived" })],
      1_000,
    );
    upsertRuntimePresence(
      db,
      expired,
      [row({ runtime_id: "expired", run_id: "expired" })],
      1_000,
    );
    db.prepare("UPDATE agents SET revoked_at = ? WHERE id = ?").run(
      2_000,
      revoked.id,
    );
    db.prepare("UPDATE agents SET archived_at = ? WHERE id = ?").run(
      2_000,
      archived.id,
    );
    db.prepare("UPDATE agents SET expires_at = ? WHERE id = ?").run(
      1_001,
      expired.id,
    );

    assert.equal(listRuntimePresence(db, { now: 2_000 }).length, 0);
  });
});

describe("runtime presence validation", () => {
  let db;

  beforeEach(() => {
    db = freshDb();
  });

  test("requires a valid lineage and rejects unknown or control fields", () => {
    const owner = agent(db, "owner-one");
    assert.throws(
      () =>
        upsertRuntimePresence(
          db,
          owner,
          [row({ kind: "main", parent_run_id: "child" })],
          1_000,
        ),
      RuntimePresenceValidationError,
    );
    assert.throws(
      () =>
        upsertRuntimePresence(
          db,
          owner,
          [row({ kind: "subagent", parent_run_id: "" })],
          1_000,
        ),
      RuntimePresenceValidationError,
    );
    assert.throws(
      () =>
        upsertRuntimePresence(db, owner, [row({ unknown: "secret" })], 1_000),
      RuntimePresenceValidationError,
    );
    assert.throws(
      () =>
        upsertRuntimePresence(
          db,
          owner,
          [row({ activity: "tool\nargument" })],
          1_000,
        ),
      RuntimePresenceValidationError,
    );
  });

  test("accepts an optional launcher client and defaults it to empty", () => {
    const owner = agent(db, "owner-one");
    upsertRuntimePresence(
      db,
      owner,
      [
        row({ client: "p3" }),
        row({ runtime_id: "runtime-2", run_id: "runtime-2" }),
        row({ runtime_id: "runtime-3", run_id: "runtime-3", client: "" }),
      ],
      1_000,
    );
    const by_runtime = Object.fromEntries(
      listRuntimePresence(db, { now: 1_000 }).map((item) => [
        item.runtime_id,
        item.client,
      ]),
    );
    assert.deepEqual(by_runtime, {
      "runtime-1": "p3",
      "runtime-2": "",
      "runtime-3": "",
    });

    upsertRuntimePresence(db, owner, [row({ client: "forca" })], 2_000);
    assert.equal(
      listRuntimePresence(db, { now: 2_000 }).find(
        (item) => item.runtime_id === "runtime-1",
      ).client,
      "forca",
    );

    for (const client of [
      "P3 Code",
      "-p3",
      "p3_code",
      "a".repeat(33),
      3,
      null,
    ]) {
      assert.throws(
        () => upsertRuntimePresence(db, owner, [row({ client })], 3_000),
        RuntimePresenceValidationError,
        `client ${JSON.stringify(client)} should be rejected`,
      );
    }
    assert.doesNotThrow(() =>
      upsertRuntimePresence(
        db,
        owner,
        [row({ client: "a".repeat(32) })],
        3_000,
      ),
    );
  });

  test("requires exact lineage and rejects the malformed three-row probe", () => {
    const owner = agent(db, "owner-one");
    const child = row({
      run_id: "child",
      parent_run_id: "runtime-1",
      kind: "subagent",
    });
    const malformed_main = row({ run_id: "not-runtime-1" });
    const valid_main = row({ run_id: "runtime-1" });

    assert.throws(
      () =>
        upsertRuntimePresence(
          db,
          owner,
          [child, malformed_main, valid_main],
          1_000,
        ),
      RuntimePresenceValidationError,
    );
    assert.equal(listRuntimePresence(db, { now: 1_000 }).length, 0);

    assert.throws(
      () =>
        upsertRuntimePresence(
          db,
          owner,
          [row({ run_id: "runtime-1" }), row({ run_id: "runtime-1" })],
          1_000,
        ),
      RuntimePresenceConflictError,
    );
  });

  test("accepts a child before its valid main row arrives", () => {
    const owner = agent(db, "owner-one");
    upsertRuntimePresence(
      db,
      owner,
      [
        row({
          run_id: "child",
          parent_run_id: "runtime-1",
          kind: "subagent",
        }),
      ],
      1_000,
    );
    assert.deepEqual(
      listRuntimePresence(db, { now: 1_000 }).map((item) => item.run_id),
      ["child"],
    );

    upsertRuntimePresence(db, owner, [row({ run_id: "runtime-1" })], 2_000);
    assert.deepEqual(
      listRuntimePresence(db, { now: 2_000 })
        .map((item) => item.run_id)
        .sort(),
      ["child", "runtime-1"],
    );
  });

  test("enforces row and deletion limits without leaking arbitrary metadata", () => {
    const owner = agent(db, "owner-one");
    assert.throws(
      () =>
        upsertRuntimePresence(
          db,
          owner,
          Array.from({ length: 65 }, () => row()),
          1_000,
        ),
      RuntimePresenceValidationError,
    );
    assert.throws(
      () =>
        dropRuntimePresence(
          db,
          owner,
          "runtime-1",
          Array.from({ length: 65 }, () => "run"),
        ),
      RuntimePresenceValidationError,
    );
    assert.throws(
      () =>
        upsertRuntimePresence(
          db,
          owner,
          [row({ display_name: "x".repeat(81) })],
          1_000,
        ),
      RuntimePresenceValidationError,
    );
    assert.throws(
      () =>
        upsertRuntimePresence(
          db,
          owner,
          [row({ model: "x".repeat(129) })],
          1_000,
        ),
      RuntimePresenceValidationError,
    );
  });

  test("caps client start time while keeping server time authoritative", () => {
    const owner = agent(db, "owner-one");
    upsertRuntimePresence(db, owner, [row({ started_at: 9_999_999 })], 1_000);

    const listed = listRuntimePresence(db, { now: 1_000 });

    assert.equal(listed[0].started_at, 301_000);
    assert.equal(listed[0].heartbeat_at, 1_000);
    assert.equal(listed[0].ended_at, 0);
  });
});
