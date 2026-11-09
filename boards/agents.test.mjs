/**
 * Tests for agent identity: invites, registration, tiers, revocation.
 *
 * node:test + node:sqlite, both built in, so this suite adds no dependencies.
 * Run with: node --test boards/
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

import {
  AGENT_TOKEN_PREFIX,
  DEFAULT_INVITE_TTL_MS,
  INVITE_TOKEN_PREFIX,
  TokenError,
  countAgentsByRole,
  createInvite,
  delegateAgent,
  credentialPath,
  findAgentBySession,
  getAgent,
  getInvite,
  hashToken,
  inspectAgentRemoval,
  inviteStatus,
  listAgents,
  listInvites,
  normalizeActor,
  readCredential,
  registerAgent,
  removeAgentActor,
  removeCredential,
  resolveAgentIdentity,
  revokeAgent,
  revokeInvite,
  setAgentRole,
  signupAgent,
  touchAgent,
  verifyAgentToken,
  writeCredential,
} from "./agents.mjs";
import { SCHEMA_VERSION, openRegistry, upsertBoard } from "./registry.mjs";

const tmp_root = fs.mkdtempSync(path.join(os.tmpdir(), "feads-agents-test-"));
let db_seq = 0;

/** @returns {import('node:sqlite').DatabaseSync} */
function freshDb() {
  db_seq += 1;
  const db = openRegistry({ path: path.join(tmp_root, `a${db_seq}.db`) });
  upsertBoard(db, {
    id: "demo",
    name: "Demo",
    board_dir: path.join(tmp_root, `board${db_seq}`),
  });
  return db;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [overrides]
 */
function invite(db, overrides = {}) {
  return createInvite(db, {
    board_id: "demo",
    display_name: "Laptop Claude",
    ...overrides,
  });
}

after(() => fs.rmSync(tmp_root, { recursive: true, force: true }));

describe("schema", () => {
  test("the agent tables arrive by opening a v1 registry", () => {
    // The registry predates agents, so migration-by-open is the upgrade path for any
    // existing ~/.feads/registry.db. If this breaks, real boards stop opening.
    const p = path.join(tmp_root, "upgrade.db");
    const v1 = openRegistry({ path: p });
    upsertBoard(v1, {
      id: "demo",
      name: "Demo",
      board_dir: path.join(tmp_root, "b"),
    });
    v1.close();

    const v2 = openRegistry({ path: p });
    const { token } = createInvite(v2, { board_id: "demo", display_name: "A" });
    assert.ok(registerAgent(v2, { token }).agent.id);
    assert.equal(
      v2.prepare("SELECT version FROM schema_meta").get().version,
      SCHEMA_VERSION,
    );
    v2.close();
  });
});

describe("invites", () => {
  test("mint returns a prefixed token and stores only its hash", () => {
    const db = freshDb();
    const { invite: row, token } = invite(db);
    assert.ok(token.startsWith(INVITE_TOKEN_PREFIX));
    assert.equal(token.length, INVITE_TOKEN_PREFIX.length + 32);

    // The whole security property: the plaintext must exist nowhere in the file.
    const stored = db
      .prepare("SELECT token_hash FROM agent_invites WHERE id = ?")
      .get(row.id);
    assert.equal(stored.token_hash, hashToken(token));
    assert.notEqual(stored.token_hash, token);
    const dump = JSON.stringify(
      db.prepare("SELECT * FROM agent_invites").all(),
    );
    assert.ok(
      !dump.includes(token),
      "plaintext invite token must not be in the table",
    );
  });

  test("reads never expose token_hash", () => {
    const db = freshDb();
    const { invite: row } = invite(db);
    assert.ok(!("token_hash" in getInvite(db, row.id)));
    assert.ok(!("token_hash" in listInvites(db)[0]));
  });

  test("the actor is slugified so it survives a shell unquoted", () => {
    const db = freshDb();
    const { invite: row } = invite(db, {
      display_name: "alex’s MacBook (work)",
    });
    assert.equal(row.actor, "alex-s-macbook-work");
    assert.equal(row.display_name, "alex’s MacBook (work)");
  });

  test("a name with no usable characters is refused rather than silently empty", () => {
    const db = freshDb();
    assert.throws(
      () => invite(db, { display_name: "!!!" }),
      /actor name is required/,
    );
  });

  test("the tier defaults to user and is recorded on the invite", () => {
    const db = freshDb();
    assert.equal(invite(db, { display_name: "a" }).invite.role, "user");
    assert.equal(
      invite(db, { display_name: "b", role: "admin" }).invite.role,
      "admin",
    );
    // Fail closed: an unrecognized role must not become admin.
    assert.equal(
      invite(db, { display_name: "c", role: "superuser" }).invite.role,
      "user",
    );
  });

  test("default expiry is bounded, and never is explicit", () => {
    const db = freshDb();
    const { invite: bounded } = invite(db, { display_name: "a" });
    assert.ok(bounded.expires_at > Date.now());
    assert.ok(bounded.expires_at <= Date.now() + DEFAULT_INVITE_TTL_MS);
    const { invite: forever } = invite(db, { display_name: "b", ttl_ms: 0 });
    assert.equal(forever.expires_at, 0);
  });

  test("a second pending invite for the same actor is refused with the fix in the message", () => {
    const db = freshDb();
    invite(db);
    assert.throws(
      () => invite(db),
      (err) => {
        assert.match(err.message, /already exists/);
        // The token was shown once; the only recovery is replacing the invite, so the
        // error has to say so or the operator will look for a way to re-read it.
        assert.match(err.message, /revoke-invite/);
        return true;
      },
    );
  });

  test("revoking a pending invite frees the actor for a new one", () => {
    const db = freshDb();
    const first = invite(db);
    assert.ok(revokeInvite(db, first.invite.id));
    assert.equal(inviteStatus(getInvite(db, first.invite.id)), "revoked");
    assert.ok(invite(db).token, "a fresh invite should now mint");
  });

  test("listInvites hides everything but pending unless asked", () => {
    const db = freshDb();
    const live = invite(db, { display_name: "live" });
    const dead = invite(db, { display_name: "dead" });
    revokeInvite(db, dead.invite.id);
    assert.deepEqual(
      listInvites(db).map((i) => i.actor),
      ["live"],
    );
    assert.equal(listInvites(db, { include_inactive: true }).length, 2);
    assert.equal(live.invite.board_id, "demo");
  });

  test("inviteStatus reports expiry without a sweeper", () => {
    const db = freshDb();
    const { invite: row } = invite(db, { expires_at: Date.now() - 1000 });
    assert.equal(inviteStatus(row), "expired");
  });

  test("minting for an unknown board fails loudly", () => {
    const db = freshDb();
    assert.throws(
      () => createInvite(db, { board_id: "nope", display_name: "x" }),
      /no such board/,
    );
  });
});

describe("registration", () => {
  test("redeeming mints a durable agent token and consumes the invite", () => {
    const db = freshDb();
    const { invite: row, token } = invite(db);
    const result = registerAgent(db, { token, session_id: "sess-1" });

    assert.ok(result.token.startsWith(AGENT_TOKEN_PREFIX));
    assert.notEqual(result.token, token);
    assert.equal(result.agent.actor, "laptop-claude");
    assert.equal(result.agent.board_id, "demo");
    assert.equal(result.invite_id, row.id);
    assert.equal(inviteStatus(getInvite(db, row.id)), "redeemed");
    assert.equal(getInvite(db, row.id).redeemed_by, result.agent.id);
  });

  test("an invite is single-use", () => {
    const db = freshDb();
    const { token } = invite(db);
    registerAgent(db, { token });
    assert.throws(
      () => registerAgent(db, { token }),
      (err) => {
        assert.ok(err instanceof TokenError);
        assert.equal(err.reason, "redeemed");
        return true;
      },
    );
  });

  test("a failed redeem leaves no agent row behind", () => {
    const db = freshDb();
    const { token } = invite(db);
    registerAgent(db, { token });
    try {
      registerAgent(db, { token });
    } catch {
      // expected
    }
    // The consume-then-insert transaction must roll back as a unit, or a rejected
    // second redeem would still create a duplicate identity.
    assert.equal(listAgents(db).length, 1);
  });

  test("an expired invite is refused", () => {
    const db = freshDb();
    const { token } = invite(db, { expires_at: Date.now() - 60_000 });
    assert.throws(
      () => registerAgent(db, { token }),
      (err) => {
        assert.equal(err.reason, "expired");
        return true;
      },
    );
  });

  test("a revoked invite is refused", () => {
    const db = freshDb();
    const { invite: row, token } = invite(db);
    revokeInvite(db, row.id);
    assert.throws(
      () => registerAgent(db, { token }),
      (err) => {
        assert.equal(err.reason, "revoked");
        return true;
      },
    );
  });

  test("an unknown token is refused, and a malformed one is distinguished", () => {
    const db = freshDb();
    assert.throws(
      () =>
        registerAgent(db, { token: `${INVITE_TOKEN_PREFIX}${"0".repeat(32)}` }),
      (err) => {
        assert.equal(err.reason, "unknown");
        return true;
      },
    );
    assert.throws(
      () => registerAgent(db, { token: "hunter2" }),
      (err) => {
        assert.equal(err.reason, "malformed");
        return true;
      },
    );
  });

  test("an agent token cannot be used as an invite token", () => {
    const db = freshDb();
    const { token } = invite(db);
    const agent_token = registerAgent(db, { token }).token;
    assert.throws(
      () => registerAgent(db, { token: agent_token }),
      (err) => {
        assert.equal(err.reason, "malformed");
        return true;
      },
    );
  });

  test("the agent cannot choose its own tier at redeem time", () => {
    const db = freshDb();
    const { token } = invite(db, { role: "user" });
    // `role` is deliberately not an input to registerAgent; passing one must not
    // promote the agent. This is the escalation path worth a test of its own.
    const { agent } = registerAgent(db, { token, ...{ role: "admin" } });
    assert.equal(agent.role, "user");
  });

  test("an admin invite produces an admin", () => {
    const db = freshDb();
    const { token } = invite(db, { role: "admin" });
    assert.equal(registerAgent(db, { token }).agent.role, "admin");
  });

  test("registration records where and who, defaulting host to this machine", () => {
    const db = freshDb();
    const { token } = invite(db);
    const { agent } = registerAgent(db, {
      token,
      workspace_dir: tmp_root,
      session_id: "sess-9",
    });
    assert.equal(agent.host, os.hostname());
    assert.equal(agent.workspace_dir, path.resolve(tmp_root));
    assert.equal(agent.session_id, "sess-9");
    assert.ok(agent.registered_at > 0);
    assert.equal(agent.last_seen_at, agent.registered_at);
  });

  test("reads never expose token_hash", () => {
    const db = freshDb();
    const { token } = invite(db);
    const { agent } = registerAgent(db, { token });
    assert.ok(!("token_hash" in agent));
    assert.ok(!("token_hash" in getAgent(db, agent.id)));
    assert.ok(!("token_hash" in listAgents(db)[0]));
  });
});

describe("signupAgent", () => {
  test("mints and redeems in one call, leaving no pending invite", () => {
    const db = freshDb();
    const { agent, token, invite_id } = signupAgent(db, {
      board_id: "demo",
      display_name: "alex Laptop",
    });
    assert.equal(agent.actor, "alex-laptop");
    assert.ok(token.startsWith(AGENT_TOKEN_PREFIX));
    assert.equal(inviteStatus(getInvite(db, invite_id)), "redeemed");
    // The whole point of one function: no half-finished state for a caller to clean up.
    assert.deepEqual(listInvites(db), []);
    assert.equal(listAgents(db).length, 1);
  });

  test("always produces a user, never an admin", () => {
    const db = freshDb();
    // `role` is deliberately not part of the input. Passing one must not promote —
    // a self-service admin tier would be no tier at all.
    const { agent } = signupAgent(db, {
      board_id: "demo",
      display_name: "Hopeful",
      ...{ role: "admin" },
    });
    assert.equal(agent.role, "user");
  });

  test("an explicit actor slug is honoured", () => {
    const db = freshDb();
    const { agent } = signupAgent(db, {
      board_id: "demo",
      display_name: "alex on the laptop",
      actor: "alex-mbp",
    });
    assert.equal(agent.actor, "alex-mbp");
    assert.equal(agent.display_name, "alex on the laptop");
  });

  test("a colliding name fails without creating anything", () => {
    const db = freshDb();
    signupAgent(db, { board_id: "demo", display_name: "Twice" });
    assert.throws(
      () => signupAgent(db, { board_id: "demo", display_name: "Twice" }),
      /already registered/,
    );
    // A failed sign-up must not leave a pending invite holding the contested name
    // hostage — the next attempt would then fail for a different, confusing reason.
    assert.deepEqual(listInvites(db), []);
    assert.equal(listAgents(db).length, 1);
  });

  test("records the surface it was created from", () => {
    const db = freshDb();
    const { agent } = signupAgent(db, {
      board_id: "demo",
      display_name: "Browser Human",
      kind: "human",
    });
    // The browser knows its caller is a human; the MCP knows its caller is an agent.
    assert.equal(agent.kind, "human");
  });

  test("the token it returns actually verifies", () => {
    const db = freshDb();
    const { agent, token } = signupAgent(db, {
      board_id: "demo",
      display_name: "Verify Me",
    });
    assert.equal(verifyAgentToken(db, token).id, agent.id);
  });
});

describe("actor uniqueness", () => {
  test("two live agents cannot share an actor on one board", () => {
    const db = freshDb();
    // Minting is what normally blocks this; go around it to prove the schema also
    // does, since the index is the guarantee the surfaces rely on.
    const a = invite(db);
    registerAgent(db, { token: a.token });
    assert.throws(() => invite(db), /already registered/);
  });

  test("revoking frees the name, and the old row survives as history", () => {
    const db = freshDb();
    const first = registerAgent(db, { token: invite(db).token }).agent;
    assert.ok(revokeAgent(db, first.id, "machine retired"));

    const second = registerAgent(db, { token: invite(db).token }).agent;
    assert.equal(second.actor, first.actor);
    assert.notEqual(second.id, first.id);

    // An actor lookup must resolve to the live agent, not the dead one it replaced.
    assert.equal(
      getAgent(db, "laptop-claude", { board_id: "demo" }).id,
      second.id,
    );
    assert.equal(listAgents(db).length, 1);
    assert.equal(listAgents(db, { include_revoked: true }).length, 2);
    assert.equal(getAgent(db, first.id).revoke_reason, "machine retired");
  });

  test("the same actor may exist on two different boards", () => {
    const db = freshDb();
    upsertBoard(db, {
      id: "other",
      name: "Other",
      board_dir: path.join(tmp_root, "other-board"),
    });
    registerAgent(db, { token: invite(db).token });
    const second = registerAgent(db, {
      token: createInvite(db, {
        board_id: "other",
        display_name: "Laptop Claude",
      }).token,
    }).agent;
    assert.equal(second.board_id, "other");
    assert.equal(listAgents(db).length, 2);
    assert.equal(listAgents(db, { board_id: "other" }).length, 1);
  });
});

describe("token verification", () => {
  test("a live token resolves to its agent", () => {
    const db = freshDb();
    const { agent, token } = registerAgent(db, { token: invite(db).token });
    assert.equal(verifyAgentToken(db, token).id, agent.id);
  });

  test("a revoked agent stops verifying", () => {
    const db = freshDb();
    const { agent, token } = registerAgent(db, { token: invite(db).token });
    revokeAgent(db, agent.id);
    assert.equal(verifyAgentToken(db, token), null);
  });

  test("wrong, empty and invite-shaped tokens all return null rather than throwing", () => {
    const db = freshDb();
    const { token: invite_token } = invite(db);
    for (const bad of [
      "",
      "hunter2",
      invite_token,
      `${AGENT_TOKEN_PREFIX}${"f".repeat(32)}`,
    ]) {
      assert.equal(verifyAgentToken(db, bad), null, bad);
    }
  });
});

describe("tiers", () => {
  test("setAgentRole promotes and demotes a live agent", () => {
    const db = freshDb();
    const { agent } = registerAgent(db, { token: invite(db).token });
    assert.equal(agent.role, "user");
    assert.equal(setAgentRole(db, agent.id, "admin").role, "admin");
    assert.equal(setAgentRole(db, agent.id, "user").role, "user");
    // Fails closed on nonsense rather than throwing, matching normalizeRole.
    assert.equal(setAgentRole(db, agent.id, "wizard").role, "user");
  });

  test("a revoked agent cannot be promoted", () => {
    const db = freshDb();
    const { agent } = registerAgent(db, { token: invite(db).token });
    revokeAgent(db, agent.id);
    assert.equal(setAgentRole(db, agent.id, "admin").role, "user");
  });

  test("countAgentsByRole ignores revoked agents", () => {
    const db = freshDb();
    const a = registerAgent(db, {
      token: invite(db, { display_name: "a", role: "admin" }).token,
    });
    registerAgent(db, { token: invite(db, { display_name: "b" }).token });
    assert.deepEqual(countAgentsByRole(db, { board_id: "demo" }), {
      user: 1,
      admin: 1,
    });
    revokeAgent(db, a.agent.id);
    assert.deepEqual(countAgentsByRole(db, { board_id: "demo" }), {
      user: 1,
      admin: 0,
    });
  });
});

describe("liveness", () => {
  test("touchAgent moves last_seen_at forward", async () => {
    const db = freshDb();
    const { agent } = registerAgent(db, { token: invite(db).token });
    await new Promise((r) => setTimeout(r, 5));
    const touched = touchAgent(db, agent.id, { session_id: "sess-new" });
    assert.ok(touched.last_seen_at > agent.last_seen_at);
    assert.equal(touched.session_id, "sess-new");
    assert.equal(touched.registered_at, agent.registered_at);
  });

  test("a revoked agent cannot be touched back to life", () => {
    const db = freshDb();
    const { agent } = registerAgent(db, { token: invite(db).token });
    revokeAgent(db, agent.id);
    const touched = touchAgent(db, agent.id);
    assert.equal(touched.last_seen_at, agent.last_seen_at);
    assert.ok(touched.revoked_at > 0);
  });

  test("sessions resolve to distinct agents on one host", () => {
    const db = freshDb();
    const one = registerAgent(db, {
      token: invite(db, { display_name: "one" }).token,
      session_id: "sess-a",
    }).agent;
    const two = registerAgent(db, {
      token: invite(db, { display_name: "two" }).token,
      session_id: "sess-b",
    }).agent;
    assert.equal(findAgentBySession(db, "sess-a").id, one.id);
    assert.equal(findAgentBySession(db, "sess-b").id, two.id);
    assert.equal(findAgentBySession(db, "sess-c"), null);
    assert.equal(findAgentBySession(db, ""), null);
  });

  test("a revoked agent no longer answers to its session", () => {
    const db = freshDb();
    const { agent } = registerAgent(db, {
      token: invite(db).token,
      session_id: "sess-x",
    });
    revokeAgent(db, agent.id);
    assert.equal(findAgentBySession(db, "sess-x"), null);
  });
});

describe("actor removal", () => {
  test("scrubs a case-insensitive actor and every descendant while keeping tombstones", () => {
    const db = freshDb();
    const admin = registerAgent(db, {
      token: invite(db, { actor: "admin", role: "admin" }).token,
    }).agent;
    const target = signupAgent(db, {
      board_id: "demo",
      display_name: "Target",
      actor: "Target",
      metadata: { sensitive: true },
    }).agent;
    const child = delegateAgent(db, {
      parent_agent_id: target.id,
      handle: "worker",
      session_id: "target-session",
      metadata: { sensitive: true },
    }).agent;
    const pending = invite(db, {
      actor: "pending-target",
      created_by: target.actor,
    });
    const target_hash = db
      .prepare("SELECT token_hash FROM agents WHERE id = ?")
      .get(target.id).token_hash;
    const child_hash = db
      .prepare("SELECT token_hash FROM agents WHERE id = ?")
      .get(child.id).token_hash;

    db.prepare(
      `INSERT INTO agent_runtime_presence
       (agent_id, session_id, runtime_id, run_id, kind, status, heartbeat_at)
       VALUES (?, 'target-session', 'runtime', 'runtime', 'main', 'working', ?)`,
    ).run(child.id, Date.now());
    db.prepare(
      `INSERT INTO work_flares
       (id, agent_id, actor, board_id, issue_id, started_at, heartbeat_at)
       VALUES ('flare-target', ?, ?, 'demo', 'issue-1', ?, ?)`,
    ).run(target.id, target.actor, Date.now(), Date.now());
    db.prepare(
      `INSERT INTO notifications
       (id, board_id, recipient_actor, type, issue_id, actor, created_at)
       VALUES ('notification-target', 'demo', ?, 'mention', 'issue-1', ?, ?)`,
    ).run(target.actor, target.actor, Date.now());
    db.prepare(
      `INSERT INTO notify_state (board_key, state_json, updated_at)
       VALUES ('demo', '{}', ?)`,
    ).run(Date.now());

    const result = removeAgentActor(db, {
      actor: "TARGET",
      requester_agent_id: admin.id,
      reason: "removed for test",
    });

    assert.equal(result.agents, 2);
    assert.equal(result.runtime_presence, 1);
    assert.equal(result.flares, 1);
    assert.equal(result.invites, 2);
    assert.equal(result.notifications, 1);
    assert.equal(result.notify_state, 1);
    const scrubbed = db
      .prepare(
        `SELECT id, actor, role, display_name, host, workspace_dir, session_id,
                metadata, revoked_at, revoke_reason, token_hash
           FROM agents WHERE id IN (?, ?) ORDER BY id`,
      )
      .all(target.id, child.id);
    assert.equal(scrubbed.length, 2);
    assert.ok(scrubbed.every((row) => row.revoked_at > 0));
    assert.ok(scrubbed.every((row) => row.display_name === ""));
    assert.ok(scrubbed.every((row) => row.host === ""));
    assert.ok(scrubbed.every((row) => row.workspace_dir === ""));
    assert.ok(scrubbed.every((row) => row.session_id === ""));
    assert.ok(scrubbed.every((row) => row.metadata === "{}"));
    assert.ok(
      scrubbed.every((row) => row.revoke_reason.includes("removed for test")),
    );
    assert.notEqual(
      scrubbed.find((row) => row.id === target.id).token_hash,
      target_hash,
    );
    assert.notEqual(
      scrubbed.find((row) => row.id === child.id).token_hash,
      child_hash,
    );
    assert.equal(
      db
        .prepare("SELECT id FROM agent_invites WHERE id = ?")
        .get(pending.invite.id),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT id FROM work_flares WHERE id = 'flare-target'").get(),
      undefined,
    );
    assert.equal(
      db
        .prepare(
          "SELECT id FROM notifications WHERE id = 'notification-target'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM notify_state").get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM agents WHERE revoked_at = 0 AND actor = 'target'",
        )
        .get().n,
      0,
    );
    db.close();
  });

  test("refuses missing, self, and last-admin removals before mutation", () => {
    const db = freshDb();
    const admin = registerAgent(db, {
      token: invite(db, { actor: "admin", role: "admin" }).token,
    }).agent;
    const target = signupAgent(db, {
      board_id: "demo",
      display_name: "Target",
      actor: "target",
    }).agent;
    const child = delegateAgent(db, {
      parent_agent_id: target.id,
      handle: "worker",
    }).agent;

    assert.throws(
      () => inspectAgentRemoval(db, { actor: "unknown" }),
      (error) => error.code === "target_not_found",
    );
    assert.throws(
      () =>
        inspectAgentRemoval(db, {
          actor: "TARGET",
          requester_agent_id: child.id,
        }),
      (error) => error.code === "self_removal",
    );
    assert.equal(
      db.prepare("SELECT revoked_at FROM agents WHERE id = ?").get(target.id)
        .revoked_at,
      0,
    );
    db.close();

    const last_admin_db = freshDb();
    const last_admin = registerAgent(last_admin_db, {
      token: invite(last_admin_db, { actor: "only-admin", role: "admin" })
        .token,
    }).agent;
    assert.throws(
      () => inspectAgentRemoval(last_admin_db, { actor: last_admin.actor }),
      (error) => error.code === "last_admin",
    );
    assert.equal(
      last_admin_db
        .prepare("SELECT revoked_at FROM agents WHERE id = ?")
        .get(last_admin.id).revoked_at,
      0,
    );
    last_admin_db.close();
  });
});

describe("identity resolution", () => {
  const fixture = JSON.parse(
    fs.readFileSync(new URL("./authz-cases.json", import.meta.url), "utf8"),
  );

  /**
   * Build the environment a resolution case describes, against a real registry.
   *
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{ token: string, session: string }} c
   */
  function envFor(db, c) {
    /** @type {Record<string, string|undefined>} */
    const env = {};
    const live = registerAgent(db, {
      token: invite(db, { display_name: "live one" }).token,
      session_id: "sess-live",
    });
    if (c.token === "valid") env.FEADS_AGENT_TOKEN = live.token;
    if (c.token === "invalid")
      env.FEADS_AGENT_TOKEN = `${AGENT_TOKEN_PREFIX}${"0".repeat(32)}`;

    if (c.session === "live") env.CLAUDE_CODE_SESSION_ID = "sess-live";
    if (c.session === "no_match") env.CLAUDE_CODE_SESSION_ID = "sess-nobody";
    if (c.session === "revoked") {
      const dead = registerAgent(db, {
        token: invite(db, { display_name: "dead one" }).token,
        session_id: "sess-dead",
      });
      revokeAgent(db, dead.agent.id, "revoked for the test");
      env.CLAUDE_CODE_SESSION_ID = "sess-dead";
    }
    return env;
  }

  test("the fixture actually has resolution cases", () => {
    assert.ok(fixture.resolution_cases.length >= 8);
  });

  for (const c of fixture.resolution_cases) {
    test(c.name, () => {
      const db = freshDb();
      const resolved = resolveAgentIdentity(db, envFor(db, c), {
        board_id: "demo",
      });
      assert.equal(resolved.via, c.via, `via for: ${c.name}`);
      assert.equal(
        !!resolved.agent,
        c.resolves_agent,
        `resolves_agent for: ${c.name}`,
      );
      assert.equal(
        resolved.credential_rejected,
        c.credential_rejected,
        `credential_rejected for: ${c.name}`,
      );
    });
  }

  test("revocation cannot promote through the session door", () => {
    // The second door into the same inversion, and the likelier one for a daemon that
    // has no token but always has a session id.
    const db = freshDb();
    const { agent } = registerAgent(db, {
      token: invite(db).token,
      session_id: "sess-x",
    });
    revokeAgent(db, agent.id);
    const resolved = resolveAgentIdentity(
      db,
      { CLAUDE_CODE_SESSION_ID: "sess-x" },
      { board_id: "demo" },
    );
    assert.equal(resolved.agent, null);
    assert.ok(
      resolved.credential_rejected,
      "a revoked session must be a rejection, not an anonymous caller",
    );
  });

  test("findAgentBySession can be asked for revoked rows explicitly", () => {
    const db = freshDb();
    const { agent } = registerAgent(db, {
      token: invite(db).token,
      session_id: "sess-y",
    });
    revokeAgent(db, agent.id);
    assert.equal(findAgentBySession(db, "sess-y"), null);
    assert.equal(
      findAgentBySession(db, "sess-y", { include_revoked: true }).id,
      agent.id,
    );
  });

  test("a live agent is preferred when a session has both a live and a revoked row", () => {
    const db = freshDb();
    const first = registerAgent(db, {
      token: invite(db, { display_name: "reused" }).token,
      session_id: "sess-z",
    });
    revokeAgent(db, first.agent.id);
    const second = registerAgent(db, {
      token: invite(db, { display_name: "reused" }).token,
      session_id: "sess-z",
    });
    const resolved = resolveAgentIdentity(
      db,
      { CLAUDE_CODE_SESSION_ID: "sess-z" },
      { board_id: "demo" },
    );
    assert.equal(resolved.agent.id, second.agent.id);
    assert.ok(!resolved.credential_rejected);
  });
});

describe("credential file", () => {
  const original_registry = process.env.FEADS_REGISTRY_DB;
  beforeEach(() => {
    // credentialPath derives from the registry location, so point it at the tmp dir
    // rather than writing into the real ~/.feads during a test run.
    process.env.FEADS_REGISTRY_DB = path.join(tmp_root, "cred", "registry.db");
  });
  after(() => {
    if (original_registry === undefined) delete process.env.FEADS_REGISTRY_DB;
    else process.env.FEADS_REGISTRY_DB = original_registry;
  });

  test("is written 0600 and round-trips", () => {
    const db = freshDb();
    const { agent, token } = registerAgent(db, { token: invite(db).token });
    const file = writeCredential(agent, token);
    assert.equal(file, credentialPath(agent.id));

    // A world-readable token file would undo the point of hashing in the database.
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const read = readCredential(agent.id);
    assert.equal(read.token, token);
    assert.equal(read.actor, agent.actor);
    assert.equal(read.role, agent.role);
  });

  test("per-agent paths, so agents sharing a machine do not clobber each other", () => {
    assert.notEqual(credentialPath("ag_1"), credentialPath("ag_2"));
  });

  test("reading a missing or corrupt credential returns null rather than throwing", () => {
    assert.equal(readCredential("ag_missing"), null);
    const file = credentialPath("ag_corrupt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json");
    assert.equal(readCredential("ag_corrupt"), null);
  });

  test("removeCredential reports whether there was anything to remove", () => {
    const db = freshDb();
    const { agent, token } = registerAgent(db, { token: invite(db).token });
    writeCredential(agent, token);
    assert.ok(removeCredential(agent.id));
    assert.ok(!removeCredential(agent.id));
  });
});

describe("board cascade", () => {
  test("removing a board takes its agents and invites with it", () => {
    const db = freshDb();
    registerAgent(db, { token: invite(db).token });
    invite(db, { display_name: "pending" });
    db.prepare("DELETE FROM boards WHERE id = ?").run("demo");
    assert.equal(listAgents(db).length, 0);
    assert.equal(listInvites(db, { include_inactive: true }).length, 0);
  });
});

describe("normalizeActor", () => {
  test("matches the registry slug rules so ids and actors normalize alike", () => {
    assert.equal(normalizeActor("Laptop Claude"), "laptop-claude");
    assert.equal(normalizeActor("  sample_controller  "), "sample-controller");
    assert.equal(normalizeActor("!!!"), "");
  });
});
