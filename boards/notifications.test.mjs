/**
 * Tests for the notification store and diff engine.
 *
 * Uses node:test + node:sqlite, both built in. Run with: node --test boards/
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';

import {
  ackNotifications,
  audienceOf,
  computeBoardEvents,
  createRecipientResolver,
  guidanceFor,
  insertNotifications,
  mergeBoardState,
  resolverFromLiveActors,
  unhandledByType,
  listNotifications,
  listUserDirectory,
  liveActorsByLower,
  loadNotifyState,
  NOTIFICATION_TYPES,
  parseExportForNotifications,
  parseIssueRefs,
  parseMentions,
  pruneNotifications,
  saveNotifyState,
  stateFromExport,
  unhandledCount,
  unreadCount
} from './notifications.mjs';
import { aliasMap } from './accounts.mjs';
import { openRegistry } from './registry.mjs';

const tmp_root = fs.mkdtempSync(path.join(os.tmpdir(), 'feads-notify-test-'));
let db_seq = 0;

after(() => {
  fs.rmSync(tmp_root, { recursive: true, force: true });
});

function freshDb() {
  db_seq += 1;
  return openRegistry({ path: path.join(tmp_root, `reg-${db_seq}.db`) });
}

/** @param {import('node:sqlite').DatabaseSync} db */
function seedAgents(db) {
  const now = Date.now();
  const board = db.prepare(
    `INSERT INTO boards (id, name, board_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  board.run('b1', 'Board 1', path.join(tmp_root, `b1-${db_seq}`), now, now);
  board.run('b2', 'Board 2', path.join(tmp_root, `b2-${db_seq}`), now, now);
  const insert = db.prepare(
    `INSERT INTO agents (id, board_id, actor, display_name, role, token_hash,
                         kind, registered_at, last_seen_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run('ag_alice', 'b1', 'alice', 'Alice', 'user', 'h1', 'agent', now, now, 0);
  insert.run('ag_bob', 'b1', 'bob', 'Bob', 'user', 'h2', 'agent', now, now, 0);
  insert.run('ag_carol', 'b2', 'carol', 'Carol', 'admin', 'h3', 'agent', now, now, 0);
  insert.run('ag_gone', 'b1', 'gone', 'Gone', 'user', 'h4', 'agent', now, now, now);
}

const ACTORS = new Map([
  ['alice', 'alice'],
  ['bob', 'bob'],
  ['carol', 'carol']
]);

/**
 * @param {Partial<import('./notifications.mjs').ExportIssue>} overrides
 * @returns {import('./notifications.mjs').ExportIssue}
 */
function issue(overrides) {
  return {
    id: 'ex-1',
    title: 'An issue',
    status: 'open',
    assignee: '',
    created_by: '',
    updated_at: '2026-01-01T00:00:00Z',
    deleted: false,
    comments: [],
    dependencies: [],
    ...overrides
  };
}

function comment(author, text, created_at) {
  return { author, text, created_at };
}

describe('mention and ref parsing', () => {
  test('parseMentions resolves case-insensitively to canonical casing', () => {
    const actors = new Map([['alice', 'Alice']]);
    assert.deepEqual(parseMentions('ping @ALICE and @alice again', actors), [
      'Alice'
    ]);
  });

  test('parseMentions ignores emails and unknown handles', () => {
    assert.deepEqual(parseMentions('mail bob@example.com @nobody', ACTORS), []);
    assert.deepEqual(parseMentions('hey @bob', ACTORS), ['bob']);
  });

  test('parseMentions follows the shared parser: punctuation, email form, code, URLs', () => {
    assert.deepEqual(parseMentions('cc @bob. and (@alice)', ACTORS), ['bob', 'alice']);
    assert.deepEqual(parseMentions('`@bob` https://x.com/@alice', ACTORS), []);
    assert.deepEqual(parseMentions('loop in @carol@example.test', ACTORS), ['carol']);
  });

  test('the engine mints mentions with the shared parser', () => {
    const before = [issue({ id: 'ex-1' })];
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: [
        issue({
          id: 'ex-1',
          comments: [
            comment(
              'carol',
              'cc @alice. — ignore `@bob` and https://x.com/@bob, but @bob@example.test yes',
              '2026-01-02T00:00:00Z'
            )
          ]
        })
      ],
      live_actors: ACTORS,
      board_id: 'b1',
      now: Date.UTC(2026, 0, 2)
    });
    assert.deepEqual(
      notifications
        .filter((n) => n.type === 'mention')
        .map((n) => n.recipient_actor)
        .sort(),
      ['alice', 'bob']
    );
  });

  test('parseIssueRefs extracts ids and drops trailing punctuation', () => {
    assert.deepEqual(parseIssueRefs('see #ex-abc. and #ui-2, not ##x-y'), [
      'ex-abc',
      'ui-2'
    ]);
  });
});

describe('parseExportForNotifications', () => {
  test('keeps comments sorted and tolerates junk lines', () => {
    const lines = [
      JSON.stringify({
        id: 'ex-1',
        title: 'T',
        status: 'open',
        comments: [
          { author: 'b', text: 'second', created_at: '2026-01-02T00:00:00Z' },
          { author: 'a', text: 'first', created_at: '2026-01-01T00:00:00Z' }
        ]
      }),
      'not json',
      JSON.stringify({ title: 'no id' })
    ].join('\n');
    const parsed = parseExportForNotifications(lines);
    assert.equal(parsed.length, 1);
    assert.deepEqual(
      parsed[0].comments.map((c) => c.text),
      ['first', 'second']
    );
  });
});

describe('computeBoardEvents', () => {
  const NOW = Date.parse('2026-02-01T00:00:00Z');

  test('refuses to run without a prior state', () => {
    assert.throws(() =>
      computeBoardEvents({
        prev: null,
        issues: [],
        live_actors: ACTORS,
        board_id: 'b1',
        now: NOW
      })
    );
  });

  test('new comment notifies mention, owner and prior commenters once each', () => {
    const before = [
      issue({
        id: 'ex-1',
        assignee: 'alice',
        created_by: 'alice',
        comments: [comment('carol', 'earlier', '2026-01-01T00:00:00Z')]
      })
    ];
    const prev = stateFromExport(before);
    const after_issues = [
      issue({
        id: 'ex-1',
        assignee: 'alice',
        created_by: 'alice',
        updated_at: '2026-01-03T00:00:00Z',
        comments: [
          comment('carol', 'earlier', '2026-01-01T00:00:00Z'),
          comment('bob', 'hey @carol look at #ex-2', '2026-01-02T00:00:00Z')
        ]
      })
    ];
    const { notifications } = computeBoardEvents({
      prev,
      issues: after_issues,
      live_actors: ACTORS,
      board_id: 'b1',
      now: NOW
    });
    const by_recipient = Object.fromEntries(
      notifications.map((n) => [n.recipient_actor, n])
    );
    assert.equal(notifications.length, 2);
    // carol was mentioned AND is a prior commenter — mention wins.
    assert.equal(by_recipient.carol.type, 'mention');
    assert.equal(by_recipient.carol.actor, 'bob');
    assert.equal(by_recipient.alice.type, 'comment_on_owned');
    assert.equal(by_recipient.alice.url, '#/issues?issue=ex-1');
    // bob wrote it — never self-notified.
    assert.equal(by_recipient.bob, undefined);
  });

  test('an explicit self-mention notifies its author', () => {
    const before = [
      issue({
        id: 'ex-1',
        assignee: 'bob',
        created_by: 'bob',
        comments: []
      })
    ];
    const prev = stateFromExport(before);
    const { notifications } = computeBoardEvents({
      prev,
      issues: [
        issue({
          id: 'ex-1',
          assignee: 'bob',
          created_by: 'bob',
          updated_at: '2026-01-03T00:00:00Z',
          comments: [
            comment('bob', '@bob check the deploy tomorrow', '2026-01-02T00:00:00Z')
          ]
        })
      ],
      live_actors: ACTORS,
      board_id: 'b1',
      now: NOW
    });
    // Typing your own @handle is a deliberate note-to-self: it must mint a
    // mention row even though bob authored the comment and owns the issue —
    // while the implicit comment_on_owned self-notification stays suppressed.
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].recipient_actor, 'bob');
    assert.equal(notifications[0].type, 'mention');
    assert.equal(notifications[0].actor, 'bob');
  });

  test('comments on a brand-new issue still notify', () => {
    const prev = stateFromExport([]);
    const { notifications } = computeBoardEvents({
      prev,
      issues: [
        issue({
          id: 'ex-9',
          assignee: 'alice',
          comments: [comment('bob', 'fresh issue, fyi @carol', '2026-01-01T00:00:00Z')]
        })
      ],
      live_actors: ACTORS,
      board_id: 'b1',
      now: NOW
    });
    const types = new Map(notifications.map((n) => [n.recipient_actor, n.type]));
    assert.equal(types.get('carol'), 'mention');
    assert.equal(types.get('alice'), 'comment_on_owned');
  });

  test('status change notifies commenters; assignee change notifies the new assignee', () => {
    const before = [
      issue({
        id: 'ex-1',
        status: 'open',
        assignee: '',
        comments: [comment('bob', 'watching', '2026-01-01T00:00:00Z')]
      })
    ];
    const after_issues = [
      issue({
        id: 'ex-1',
        status: 'in_progress',
        assignee: 'alice',
        updated_at: '2026-01-05T00:00:00Z',
        comments: [comment('bob', 'watching', '2026-01-01T00:00:00Z')]
      })
    ];
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: after_issues,
      live_actors: ACTORS,
      board_id: 'b1',
      now: NOW
    });
    const by_recipient = Object.fromEntries(
      notifications.map((n) => [n.recipient_actor, n])
    );
    assert.equal(by_recipient.alice.type, 'assigned');
    assert.equal(by_recipient.bob.type, 'update_on_commented');
    assert.match(by_recipient.bob.snippet, /open → in_progress/);
  });

  test('closing a blocker notifies owners of dependent issues', () => {
    const before = [
      issue({ id: 'ex-block', status: 'open' }),
      issue({
        id: 'ex-dep',
        assignee: 'alice',
        created_by: 'bob',
        dependencies: [{ depends_on_id: 'ex-block', type: 'blocks' }]
      })
    ];
    const after_issues = [
      issue({ id: 'ex-block', status: 'closed', title: 'The blocker' }),
      issue({
        id: 'ex-dep',
        assignee: 'alice',
        created_by: 'bob',
        dependencies: [{ depends_on_id: 'ex-block', type: 'blocks' }]
      })
    ];
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: after_issues,
      live_actors: ACTORS,
      board_id: 'b1',
      now: NOW
    });
    const dep_rows = notifications.filter((n) => n.type === 'dependency_completed');
    assert.deepEqual(
      dep_rows.map((n) => n.recipient_actor).sort(),
      ['alice', 'bob']
    );
    assert.equal(dep_rows[0].issue_id, 'ex-dep');
    assert.equal(dep_rows[0].related_issue, 'ex-block');
  });

  test('non-blocking dep types and already-closed dependents stay quiet', () => {
    const before = [
      issue({ id: 'ex-block', status: 'open' }),
      issue({
        id: 'ex-rel',
        assignee: 'alice',
        dependencies: [{ depends_on_id: 'ex-block', type: 'related' }]
      }),
      issue({
        id: 'ex-done',
        status: 'closed',
        assignee: 'bob',
        dependencies: [{ depends_on_id: 'ex-block', type: 'blocks' }]
      })
    ];
    const after_issues = structuredClone(before);
    after_issues[0].status = 'closed';
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: after_issues,
      live_actors: ACTORS,
      board_id: 'b1',
      now: NOW
    });
    assert.deepEqual(
      notifications.filter((n) => n.type === 'dependency_completed'),
      []
    );
  });

  test('unregistered recipients are never minted rows', () => {
    const before = [issue({ id: 'ex-1', assignee: 'randomgituser' })];
    const after_issues = [
      issue({
        id: 'ex-1',
        assignee: 'randomgituser',
        comments: [comment('alice', 'hello', '2026-01-01T00:00:00Z')]
      })
    ];
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: after_issues,
      live_actors: ACTORS,
      board_id: 'b1',
      now: NOW
    });
    assert.deepEqual(notifications, []);
  });

  test('a quiet diff mints nothing and the cursor advances', () => {
    const before = [issue({ id: 'ex-1' })];
    const result = computeBoardEvents({
      prev: stateFromExport(before),
      issues: before,
      live_actors: ACTORS,
      board_id: 'b1',
      now: NOW
    });
    assert.deepEqual(result.notifications, []);
    assert.ok(result.next_state.issues['ex-1']);
  });
});

describe('store round-trip', () => {
  test('insert, list, unread count, ack own rows only, prune', () => {
    const db = freshDb();
    seedAgents(db);
    const now = Date.now();
    const rows = [
      {
        id: 'n_1',
        board_id: 'b1',
        recipient_actor: 'alice',
        type: 'mention',
        issue_id: 'ex-1',
        issue_title: 'T',
        actor: 'bob',
        snippet: 'hi @alice',
        related_issue: '',
        created_at: now,
        read_at: 0,
        url: '#/issues?issue=ex-1'
      },
      {
        id: 'n_2',
        board_id: 'b1',
        recipient_actor: 'bob',
        type: 'comment_on_owned',
        issue_id: 'ex-2',
        issue_title: 'U',
        actor: 'alice',
        snippet: 'yo',
        related_issue: '',
        created_at: now - 10,
        read_at: 0,
        url: '#/issues?issue=ex-2'
      }
    ];
    insertNotifications(db, rows);

    assert.equal(unreadCount(db, 'alice'), 1);
    assert.equal(unhandledCount(db, 'alice'), 1);
    const listed = listNotifications(db, { actor: 'alice' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].url, '#/issues?issue=ex-1');
    assert.equal(listed[0].handled_at, 0);

    // Acking someone else's row does nothing.
    assert.equal(ackNotifications(db, { actor: 'alice', ids: ['n_2'] }), 0);

    // A seen-ack (the default — the bell) clears the badge and nothing else:
    // the agents' queue must keep the row until somebody *acts* on it.
    assert.equal(ackNotifications(db, { actor: 'alice', ids: ['n_1'] }), 1);
    assert.equal(unreadCount(db, 'alice'), 0);
    assert.equal(unhandledCount(db, 'alice'), 1);
    assert.equal(
      listNotifications(db, { actor: 'alice', queue: 'handled' }).length,
      1
    );
    assert.equal(listNotifications(db, { actor: 'alice' }).length, 0);
    assert.equal(
      listNotifications(db, { actor: 'alice', unread_only: false }).length,
      1
    );

    // The handled-ack retires it from both queues and keeps the original
    // seen stamp rather than restamping it.
    const seen_at = listNotifications(db, {
      actor: 'alice',
      unread_only: false
    })[0].read_at;
    assert.equal(
      ackNotifications(db, { actor: 'alice', ids: ['n_1'], mode: 'handled' }),
      1
    );
    assert.equal(unhandledCount(db, 'alice'), 0);
    const alice_row = listNotifications(db, {
      actor: 'alice',
      unread_only: false
    })[0];
    assert.equal(alice_row.read_at, seen_at);
    assert.ok(alice_row.handled_at > 0);

    // A handled-ack on a never-seen row implies seen: both stamps land.
    assert.equal(
      ackNotifications(db, { actor: 'bob', all: true, mode: 'handled' }),
      1
    );
    assert.equal(unreadCount(db, 'bob'), 0);
    assert.equal(unhandledCount(db, 'bob'), 0);

    // prune: handled rows go after the horizon; a row somebody saw but
    // nobody handled survives three times as long; a row nobody has even
    // seen survives forever.
    insertNotifications(db, [
      { ...rows[0], id: 'n_3', recipient_actor: 'carol', created_at: now },
      { ...rows[0], id: 'n_4', recipient_actor: 'carol', created_at: now }
    ]);
    assert.equal(ackNotifications(db, { actor: 'carol', ids: ['n_4'] }), 1);
    const day_ms = 24 * 60 * 60 * 1000;
    assert.equal(pruneNotifications(db, { now: now + 40 * day_ms }), 2);
    assert.equal(unhandledCount(db, 'carol'), 2);
    assert.equal(pruneNotifications(db, { now: now + 100 * day_ms }), 1);
    assert.equal(unreadCount(db, 'carol'), 1);
    db.close();
  });

  test('a pre-split registry migrates: handled_at arrives backfilled from read_at', () => {
    // Build a v3-shaped registry by hand — notifications without handled_at —
    // then let openRegistry migrate it in, exactly as a dashboard upgrade does.
    const db_path = path.join(tmp_root, `reg-legacy-${(db_seq += 1)}.db`);
    const legacy = new DatabaseSync(db_path);
    legacy.exec(`
      CREATE TABLE notifications (
        id              TEXT PRIMARY KEY,
        board_id        TEXT NOT NULL DEFAULT '',
        recipient_actor TEXT NOT NULL,
        type            TEXT NOT NULL,
        issue_id        TEXT NOT NULL,
        issue_title     TEXT NOT NULL DEFAULT '',
        actor           TEXT NOT NULL DEFAULT '',
        snippet         TEXT NOT NULL DEFAULT '',
        related_issue   TEXT NOT NULL DEFAULT '',
        created_at      INTEGER NOT NULL,
        read_at         INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta (version) VALUES (3);
      INSERT INTO notifications (id, recipient_actor, type, issue_id, created_at, read_at)
        VALUES ('n_read', 'alice', 'mention', 'ex-1', 100, 200),
               ('n_unread', 'alice', 'mention', 'ex-2', 100, 0);
    `);
    legacy.close();

    const db = openRegistry({ path: db_path });
    // Read rows predate the split and count as handled — an upgrade must not
    // flood every old row back into agent inboxes. Unread rows stay owed.
    assert.equal(unhandledCount(db, 'alice'), 1);
    assert.equal(unreadCount(db, 'alice'), 1);
    const rows = listNotifications(db, { actor: 'alice', unread_only: false });
    const read_row = rows.find((r) => r.id === 'n_read');
    assert.equal(read_row?.handled_at, 200);
    // Idempotent: reopening (re-running the migration) changes nothing.
    db.close();
    const again = openRegistry({ path: db_path });
    assert.equal(unhandledCount(again, 'alice'), 1);
    again.close();
  });

  test('notify_state round-trips and reports null for unseen boards', () => {
    const db = freshDb();
    assert.equal(loadNotifyState(db, '/board/a'), null);
    saveNotifyState(db, '/board/a', { issues: { 'ex-1': { s: 'open', a: '', u: '', cc: 0, lc: '' } } });
    const state = loadNotifyState(db, '/board/a');
    assert.equal(state?.issues['ex-1'].s, 'open');
    saveNotifyState(db, '/board/a', { issues: {} });
    assert.deepEqual(loadNotifyState(db, '/board/a')?.issues, {});
    db.close();
  });

  test('liveActorsByLower and listUserDirectory exclude the revoked', () => {
    const db = freshDb();
    seedAgents(db);
    const actors = liveActorsByLower(db);
    assert.deepEqual(
      [...actors.values()].sort(),
      ['alice', 'bob', 'carol']
    );
    const directory = listUserDirectory(db);
    assert.deepEqual(
      directory.map((u) => u.actor).sort(),
      ['alice', 'bob', 'carol']
    );
    assert.equal(directory.every((u) => !('host' in u)), true);
    const with_revoked = listUserDirectory(db, { include_revoked: true });
    assert.equal(with_revoked.length, 4);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 2026-10: human vs agent audiences, coordination events, burst collapse.
// ---------------------------------------------------------------------------

/**
 * @param {string} ref
 * @param {string} [intent]
 */
function art(ref, intent = 'editing') {
  return { ref, intent };
}

describe('coordination events (agents)', () => {
  const T0 = Date.UTC(2026, 9, 5);

  test('declaring an overlapping artifact tells both holders, with guidance', () => {
    const before = [
      issue({
        id: 'ex-a',
        status: 'in_progress',
        assignee: 'alice',
        artifacts: [art('example-org/feads:ui/server/')]
      }),
      issue({ id: 'ex-b', status: 'open', assignee: 'bob', artifacts: [] })
    ];
    const after_issues = structuredClone(before);
    after_issues[1].artifacts = [art('example-org/feads:ui/server/ws.js')];
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: after_issues,
      live_actors: ACTORS,
      board_id: 'b1',
      now: T0
    });
    const overlaps = notifications.filter((n) => n.type === 'work_overlap');
    const to_alice = overlaps.find((n) => n.recipient_actor === 'alice');
    const to_bob = overlaps.find((n) => n.recipient_actor === 'bob');
    assert.ok(to_alice, 'the holder of the overlapped work is told');
    assert.equal(to_alice.issue_id, 'ex-b');
    assert.equal(to_alice.related_issue, 'ex-a');
    assert.equal(to_alice.actor, 'bob');
    assert.match(to_alice.snippet, /ui\/server\/ws\.js/);
    assert.match(to_alice.guidance, /Coordinate, don't block/);
    assert.match(to_alice.guidance, /@bob is on #ex-b, which overlaps your #ex-a/);
    // The suggested move is an @mention of the other holder on their item.
    assert.match(to_alice.guidance, /comment on #ex-b with @bob saying which part you take/);
    assert.match(to_alice.guidance, /never wait for a reply/);
    assert.equal(to_alice.audience, 'agent');
    assert.ok(to_bob, 'the declarer is told who else is there');
    assert.equal(to_bob.issue_id, 'ex-a');
    assert.equal(to_bob.actor, 'alice');
  });

  test('two readers never collide, done artifacts never count, own work is quiet', () => {
    const before = [
      issue({
        id: 'ex-a',
        assignee: 'alice',
        artifacts: [
          art('o/r:a.js', 'reading'),
          art('o/r:b.js', 'done'),
          art('o/r:own.js', 'reading')
        ]
      }),
      issue({ id: 'ex-b', assignee: 'bob', artifacts: [] }),
      issue({ id: 'ex-c', assignee: 'alice', artifacts: [] })
    ];
    const after_issues = structuredClone(before);
    // bob reads what alice reads (harmless) and edits what alice is done with.
    after_issues[1].artifacts = [art('o/r:a.js', 'reading'), art('o/r:b.js')];
    // alice edits a file her own other issue reads: her business, not news.
    after_issues[2].artifacts = [art('o/r:own.js')];
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: after_issues,
      live_actors: ACTORS,
      board_id: 'b1',
      now: T0
    });
    assert.deepEqual(
      notifications.filter((n) => n.type === 'work_overlap'),
      []
    );
  });

  test('a cursor from before artifacts were tracked never floods', () => {
    const before = [
      issue({ id: 'ex-a', assignee: 'alice', artifacts: [art('o/r:x/')] }),
      issue({ id: 'ex-b', assignee: 'bob', artifacts: [art('o/r:x/y.js')] })
    ];
    const prev = stateFromExport(before);
    for (const cursor of Object.values(prev.issues)) delete cursor.ar;
    const { notifications } = computeBoardEvents({
      prev,
      issues: before,
      live_actors: ACTORS,
      board_id: 'b1',
      now: T0
    });
    assert.deepEqual(notifications, []);
  });

  test('claiming work with artifacts re-announces them to overlapping holders', () => {
    const before = [
      issue({ id: 'ex-a', status: 'in_progress', assignee: 'alice', artifacts: [art('o/r:x/')] }),
      issue({ id: 'ex-b', status: 'open', assignee: '', created_by: 'carol', artifacts: [art('o/r:x/y.js', 'planned')] })
    ];
    const after_issues = structuredClone(before);
    after_issues[1].status = 'in_progress';
    after_issues[1].assignee = 'bob';
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: after_issues,
      live_actors: ACTORS,
      board_id: 'b1',
      now: T0
    });
    const to_alice = notifications.find(
      (n) => n.recipient_actor === 'alice' && n.type === 'work_overlap'
    );
    assert.ok(to_alice);
    assert.match(to_alice.snippet, /bob started on/);
  });

  test('reassignment tells the previous holder; status moves tell owners, never the actor', () => {
    const before = [
      issue({ id: 'ex-1', status: 'open', assignee: 'alice', created_by: 'carol' })
    ];
    const after_issues = [
      issue({
        id: 'ex-1',
        status: 'in_progress',
        assignee: 'bob',
        created_by: 'carol',
        last_actor: 'bob'
      })
    ];
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: after_issues,
      live_actors: ACTORS,
      board_id: 'b1',
      now: T0
    });
    const by = Object.fromEntries(notifications.map((n) => [n.recipient_actor, n]));
    assert.equal(by.alice.type, 'reassigned_away');
    assert.match(by.alice.snippet, /now assigned to bob/);
    assert.equal(by.bob.type, 'assigned');
    assert.equal(by.carol.type, 'status_on_owned');
    assert.match(by.carol.snippet, /open → in_progress \(by bob\)/);
  });

  test('a status move with no recorded actor spares the assignee', () => {
    const before = [issue({ id: 'ex-1', status: 'open', assignee: 'alice', created_by: 'carol' })];
    const after_issues = [issue({ id: 'ex-1', status: 'closed', assignee: 'alice', created_by: 'carol' })];
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: after_issues,
      live_actors: ACTORS,
      board_id: 'b1',
      now: T0
    });
    assert.deepEqual(
      notifications.map((n) => [n.recipient_actor, n.type]),
      [['carol', 'status_on_owned']]
    );
  });

  test('a new child under an epic tells the epic owners', () => {
    const epic = issue({ id: 'ex-epic', title: 'Epic', assignee: 'alice', created_by: 'carol' });
    const before = [epic];
    const after_issues = [
      epic,
      issue({
        id: 'ex-new',
        title: 'Fresh work',
        created_by: 'bob',
        dependencies: [{ depends_on_id: 'ex-epic', type: 'parent-child' }]
      })
    ];
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: after_issues,
      live_actors: ACTORS,
      board_id: 'b1',
      now: T0
    });
    const rows = notifications.filter((n) => n.type === 'new_in_area');
    assert.deepEqual(rows.map((n) => n.recipient_actor).sort(), ['alice', 'carol']);
    assert.equal(rows[0].issue_id, 'ex-new');
    assert.equal(rows[0].related_issue, 'ex-epic');
    assert.equal(rows[0].actor, 'bob');
  });

  test('recipients resolve through one resolver: an alias mention reaches its owner', () => {
    // What the accounts work plugs in: alex-laptop is an alias of mira.
    const live = new Map([
      ['mira', 'mira'],
      ['bob', 'bob']
    ]);
    const base = resolverFromLiveActors(live);
    const aliases = new Map([['alex-laptop', 'mira']]);
    const resolver = {
      resolve: (/** @type {string} */ h) =>
        base.resolve(aliases.get(String(h).toLowerCase()) || h),
      same: (/** @type {string} */ a, /** @type {string} */ b) =>
        resolver.resolve(a) !== '' && resolver.resolve(a) === resolver.resolve(b)
    };
    const before = [issue({ id: 'ex-1', assignee: 'alex-laptop' })];
    const after_issues = [
      issue({
        id: 'ex-1',
        assignee: 'alex-laptop',
        comments: [
          comment('bob', 'ping @alex-laptop', '2026-01-02T00:00:00Z'),
          comment('mira', 'note to self on my own issue', '2026-01-03T00:00:00Z')
        ]
      })
    ];
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: after_issues,
      resolver,
      board_id: 'b1',
      now: T0
    });
    const to_mira = notifications.filter((n) => n.recipient_actor === 'mira');
    assert.equal(to_mira.length, 1);
    assert.equal(to_mira[0].type, 'mention');
    assert.equal(to_mira[0].actor, 'bob');
  });

  test('accounts aliases: a person acting through one alias notifies none of their aliases', () => {
    // Production shape: alex-laptop is a live legacy agent AND an alias of
    // mira (accounts migration); mira is the user's own principal row.
    const live = new Map([
      ['mira', 'mira'],
      ['alex-laptop', 'alex-laptop'],
      ['dana', 'dana']
    ]);
    const aliases = new Map([
      ['mira', 'mira'],
      ['alex-laptop', 'mira'],
      ['alex-laptop-triage-probe', 'mira'],
      ['dana', 'dana']
    ]);
    const before = [
      issue({ id: 'ex-1', assignee: 'alex-laptop', created_by: 'alex-laptop' })
    ];
    const own = [
      issue({
        id: 'ex-1',
        assignee: 'alex-laptop',
        created_by: 'alex-laptop',
        comments: [comment('mira', 'my own note', '2026-01-02T00:00:00Z')]
      })
    ];
    // Without the alias map (the pre-fix wiring) mira's own comment notified
    // alex-laptop — the bug seen on feads-bkw.
    const legacy = computeBoardEvents({
      prev: stateFromExport(before),
      issues: own,
      resolver: resolverFromLiveActors(live),
      board_id: 'b1',
      now: T0
    });
    assert.deepEqual(
      legacy.notifications.map((n) => [n.recipient_actor, n.type]),
      [['alex-laptop', 'comment_on_owned']]
    );
    const fixed = computeBoardEvents({
      prev: stateFromExport(before),
      issues: own,
      resolver: resolverFromLiveActors(live, aliases),
      board_id: 'b1',
      now: T0
    });
    assert.deepEqual(fixed.notifications, []);
    // ...and a delegated child alias acting is the same person too.
    const child = computeBoardEvents({
      prev: stateFromExport(before),
      issues: [
        issue({
          id: 'ex-1',
          assignee: 'alex-laptop',
          created_by: 'mira',
          comments: [
            comment('alex-laptop-triage-probe', 'probe', '2026-01-02T00:00:00Z')
          ]
        })
      ],
      resolver: resolverFromLiveActors(live, aliases),
      board_id: 'b1',
      now: T0
    });
    assert.deepEqual(child.notifications, []);
  });

  test('accounts aliases: someone else acting reaches the person once, by their user actor', () => {
    const live = new Map([
      ['mira', 'mira'],
      ['alex-laptop', 'alex-laptop'],
      ['dana', 'dana']
    ]);
    const aliases = new Map([
      ['mira', 'mira'],
      ['alex-laptop', 'mira'],
      ['dana', 'dana']
    ]);
    const before = [issue({ id: 'ex-1', assignee: 'alex-laptop', created_by: 'mira' })];
    const { notifications } = computeBoardEvents({
      prev: stateFromExport(before),
      issues: [
        issue({
          id: 'ex-1',
          assignee: 'alex-laptop',
          created_by: 'mira',
          comments: [comment('dana', 'looks good', '2026-01-02T00:00:00Z')]
        })
      ],
      resolver: resolverFromLiveActors(live, aliases),
      board_id: 'b1',
      now: T0
    });
    assert.deepEqual(
      notifications.map((n) => [n.recipient_actor, n.type, n.actor]),
      [['mira', 'comment_on_owned', 'dana']]
    );
    // An explicit @mention of your own alias stays a deliberate note-to-self.
    const self_mention = computeBoardEvents({
      prev: stateFromExport(before),
      issues: [
        issue({
          id: 'ex-1',
          assignee: 'alex-laptop',
          created_by: 'mira',
          comments: [comment('mira', 'remind @alex-laptop', '2026-01-02T00:00:00Z')]
        })
      ],
      resolver: resolverFromLiveActors(live, aliases),
      board_id: 'b1',
      now: T0
    });
    assert.deepEqual(
      self_mention.notifications.map((n) => [n.recipient_actor, n.type]),
      [['mira', 'mention']]
    );
  });

  test('mergeBoardState folds a partial scan into the cursor', () => {
    const prev = stateFromExport([
      issue({ id: 'ex-1', status: 'open' }),
      issue({ id: 'ex-2', status: 'open' }),
      issue({ id: 'ex-3', status: 'open' })
    ]);
    const next = mergeBoardState(
      prev,
      [issue({ id: 'ex-2', status: 'closed' }), issue({ id: 'ex-3', deleted: true })],
      ['ex-2', 'ex-3', 'ex-gone']
    );
    assert.equal(next.issues['ex-1'].s, 'open');
    assert.equal(next.issues['ex-2'].s, 'closed');
    assert.equal(next.issues['ex-3'], undefined);
    assert.equal(prev.issues['ex-2'].s, 'open', 'prev is not mutated');
  });

  test('every type has guidance and an audience; only mentions reach humans', () => {
    for (const type of [
      'mention',
      'assigned',
      'reassigned_away',
      'work_overlap',
      'dependency_completed',
      'comment_on_owned',
      'status_on_owned',
      'new_in_area',
      'update_on_commented'
    ]) {
      const text = guidanceFor(type, { issue_id: 'ex-1', actor: 'bob' });
      assert.ok(text.length > 0, type);
      // Agents coordinate by @mentioning the other person: whenever a row
      // knows who acted, its guidance tells the agent to @ them back.
      if (type !== 'assigned' && type !== 'dependency_completed') {
        assert.match(text, /@bob/, type);
      }
      assert.equal(audienceOf(type), type === 'mention' ? 'all' : 'agent');
    }
  });

  test('a listed row speaks the current guidance, whatever wording it was minted with', () => {
    const db = freshDb();
    seedAgents(db);
    const base = {
      board_id: 'b1',
      recipient_actor: 'alice',
      issue_title: 'T',
      snippet: 's',
      created_at: Date.now(),
      read_at: 0,
      url: '#/issues?issue=ex-9'
    };
    insertNotifications(db, [
      {
        ...base,
        id: 'n_old',
        type: 'work_overlap',
        issue_id: 'ex-9',
        actor: 'bob',
        related_issue: 'ex-1',
        guidance:
          'Leave one comment on #ex-9; @mention someone only if you need their decision.'
      },
      {
        ...base,
        id: 'n_future',
        type: 'some_future_type',
        issue_id: 'ex-8',
        actor: 'bob',
        related_issue: '',
        guidance: 'stored text for a type this build does not know'
      }
    ]);
    const by_id = new Map(
      listNotifications(db, { actor: 'alice' }).map((n) => [n.id, n])
    );
    assert.equal(
      by_id.get('n_old')?.guidance,
      guidanceFor('work_overlap', {
        issue_id: 'ex-9',
        actor: 'bob',
        related_issue: 'ex-1'
      })
    );
    assert.equal(
      by_id.get('n_future')?.guidance,
      'stored text for a type this build does not know'
    );
  });

  test('guidance matches boards/guidance-cases.json (shared with the Python MCP)', () => {
    const fixture = JSON.parse(
      fs.readFileSync(new URL('./guidance-cases.json', import.meta.url), 'utf8')
    );
    assert.ok(fixture.cases.length >= NOTIFICATION_TYPES.length * 2);
    for (const c of fixture.cases) {
      assert.equal(
        guidanceFor(c.type, {
          issue_id: c.issue_id,
          actor: c.actor,
          related_issue: c.related_issue
        }),
        c.guidance,
        `${c.type} ${c.actor || '(no actor)'}`
      );
    }
    // Every known type is covered, with and without a known actor.
    for (const type of NOTIFICATION_TYPES) {
      assert.ok(fixture.cases.some((c) => c.type === type && c.actor), type);
      assert.ok(fixture.cases.some((c) => c.type === type && !c.actor), type);
    }
  });

  test('guidance never tells an agent to stop and wait', () => {
    for (const type of NOTIFICATION_TYPES) {
      const text = guidanceFor(type, { issue_id: 'ex-1', actor: 'bob', related_issue: 'ex-2' });
      assert.doesNotMatch(text, /only if you need their decision/, type);
      assert.doesNotMatch(text, /\bwait (?:for|until)\b(?! a reply)/, type);
    }
    for (const type of ['mention', 'work_overlap']) {
      assert.match(guidanceFor(type, { issue_id: 'ex-1', actor: 'bob' }), /never wait for a reply/);
    }
  });
});

describe('store: audiences and burst collapse', () => {
  /**
   * @param {Partial<import('./notifications.mjs').NotificationRow>} o
   */
  function row(o) {
    return {
      id: `n_${Math.random().toString(36).slice(2)}`,
      board_id: 'b1',
      recipient_actor: 'alice',
      type: 'mention',
      issue_id: 'ex-1',
      issue_title: 'T',
      actor: 'bob',
      snippet: 's',
      related_issue: '',
      created_at: Date.now(),
      read_at: 0,
      handled_at: 0,
      url: '#/issues?issue=ex-1',
      ...o
    };
  }

  test('the bell (audience human) sees only mentions; agents see everything', () => {
    const db = freshDb();
    seedAgents(db);
    insertNotifications(db, [
      row({ type: 'mention' }),
      row({ type: 'work_overlap', issue_id: 'ex-2' }),
      row({ type: 'status_on_owned', issue_id: 'ex-3' })
    ]);
    const bell = listNotifications(db, { actor: 'alice', audience: 'human' });
    assert.deepEqual(bell.map((n) => n.type), ['mention']);
    assert.equal(unreadCount(db, 'alice', { audience: 'human' }), 1);
    const agent = listNotifications(db, { actor: 'alice', queue: 'handled' });
    assert.equal(agent.length, 3);
    assert.equal(unhandledCount(db, 'alice'), 3);
    assert.deepEqual(unhandledByType(db, 'alice'), {
      mention: 1,
      work_overlap: 1,
      status_on_owned: 1
    });
    assert.ok(agent.every((n) => typeof n.guidance === 'string' && n.guidance.length > 0));
    // Mark-all-read from the bell clears what the bell showed, nothing more.
    const acked = ackNotifications(db, { actor: 'alice', all: true, mode: 'seen', audience: 'human' });
    assert.equal(acked, 1);
    assert.equal(unreadCount(db, 'alice'), 2);
    db.close();
  });

  test('a burst of one agent type on one issue collapses; mentions never do', () => {
    const db = freshDb();
    seedAgents(db);
    const first = insertNotifications(db, [row({ type: 'status_on_owned', snippet: 'one' })]);
    const second = insertNotifications(db, [row({ type: 'status_on_owned', snippet: 'two', actor: 'carol' })]);
    assert.equal(second[0].id, first[0].id, 'the burst lands on the surviving row');
    assert.equal(second[0].count, 2);
    insertNotifications(db, [row({ type: 'mention' }), row({ type: 'mention' })]);
    const list = listNotifications(db, { actor: 'alice', queue: 'handled', limit: 50 });
    const status = list.filter((n) => n.type === 'status_on_owned');
    assert.equal(status.length, 1);
    assert.equal(status[0].count, 2);
    assert.equal(status[0].snippet, 'two');
    assert.equal(status[0].actor, 'carol');
    assert.equal(list.filter((n) => n.type === 'mention').length, 2);
    // Once handled, the next event starts a fresh row.
    ackNotifications(db, { actor: 'alice', ids: [status[0].id], mode: 'handled' });
    const third = insertNotifications(db, [row({ type: 'status_on_owned', snippet: 'three' })]);
    assert.notEqual(third[0].id, status[0].id);
    db.close();
  });

  test('ephemeral coordination rows expire unhandled; obligations do not', () => {
    const db = freshDb();
    seedAgents(db);
    const old = Date.now() - 20 * 24 * 60 * 60 * 1000;
    insertNotifications(db, [
      row({ type: 'work_overlap', created_at: old, issue_id: 'ex-8' }),
      row({ type: 'mention', created_at: old, issue_id: 'ex-9' })
    ]);
    pruneNotifications(db);
    const left = listNotifications(db, { actor: 'alice', queue: 'handled', limit: 50 });
    assert.deepEqual(left.map((n) => n.type), ['mention']);
    db.close();
  });
});
