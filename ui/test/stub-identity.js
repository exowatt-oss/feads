/**
 * Resolutions for suites that test WebSocket *handlers*, not authorization.
 *
 * Every mutating handler now asks `identity.js` whether the caller may act, which
 * makes the answer depend on two things a test cannot control: whether the machine
 * running it has a `~/.feads/registry.db`, and whether Claude Code exported a
 * `CLAUDE_CODE_SESSION_ID` that matches an agent in it. A suite about `label-add`
 * would then pass under a human and fail under an agent, or pass on a laptop with
 * no registry and fail on one with — and the failure would look like a bug in
 * labels.
 *
 * So handler suites pin the resolution and get on with their subject. The pattern,
 * copied verbatim into each such file because `vi.mock` is hoisted per module and
 * cannot be moved into an import:
 *
 * ```js
 * vi.mock('./identity.js', async (importOriginal) => {
 *   const actual = await importOriginal();
 *   const { operatorResolution } = await import('../test/stub-identity.js');
 *   return { ...actual, resolveIdentity: vi.fn(async () => operatorResolution()) };
 * });
 * ```
 *
 * `decideFor` is deliberately **not** stubbed: it loads the real
 * `boards/authz.mjs`, so these suites still run the real policy over a stated
 * identity. A suite that stubbed both would be asserting against its own mock, and
 * a handler that forgot to call the gate at all would pass.
 *
 * Which resolution to pin:
 *
 * - `operatorResolution()` — the pre-feads behaviour, and the right default for a
 *   suite about handler plumbing: it allows everything, so a refusal in such a
 *   suite is a real regression rather than an artefact of the stance.
 * - `anonymousResolution()` — the browser before anyone signs in. For suites whose
 *   subject *is* the gate.
 * - `agentResolution(row)` — a registered agent at its tier.
 */

/**
 * @typedef {'operator'|'read_only'|'deny'} Stance
 */

/**
 * @typedef {Object} StubResolution
 * @property {Record<string, any> | null} identity
 * @property {Record<string, any> | null} agent
 * @property {'agent'|'operator'|'anonymous'|'rejected'} mode
 * @property {Stance} stance
 * @property {boolean} require_identity
 * @property {boolean} credential_rejected
 * @property {string} via
 */

/**
 * An unidentified caller on a surface that treats one as the operator — what the
 * dashboard degrades to when no registry is reachable, and what every surface did
 * before the browser grew a login box.
 *
 * @returns {StubResolution}
 */
export function operatorResolution() {
  return {
    identity: null,
    agent: null,
    mode: 'operator',
    stance: 'operator',
    require_identity: false,
    credential_rejected: false,
    via: 'none'
  };
}

/**
 * An unidentified caller in a browser: may read, may change nothing.
 *
 * @param {{ require_identity?: boolean }} [options] - `require_identity` upgrades
 * the stance to `deny`, standing in for `FEADS_REQUIRE_AGENT=1`.
 * @returns {StubResolution}
 */
export function anonymousResolution(options = {}) {
  const deny = options.require_identity === true;
  return {
    identity: null,
    agent: null,
    mode: 'anonymous',
    stance: deny ? 'deny' : 'read_only',
    require_identity: deny,
    credential_rejected: false,
    via: 'none'
  };
}

/**
 * A caller whose credential was presented and refused — a revoked agent, most
 * often. Denied regardless of stance.
 *
 * @returns {StubResolution}
 */
export function rejectedResolution() {
  return {
    identity: null,
    agent: null,
    mode: 'rejected',
    stance: 'read_only',
    require_identity: false,
    credential_rejected: true,
    via: 'rejected'
  };
}

/**
 * A registered agent, at whatever tier its row says.
 *
 * @param {Record<string, any>} row - An agents row, e.g. from `toAgentRow`.
 * @param {{ stance?: Stance }} [options]
 * @returns {StubResolution}
 */
export function agentResolution(row, options = {}) {
  return {
    identity: {
      agent_id: row.id,
      actor: row.actor,
      display_name: row.display_name,
      role: row.role,
      board_id: row.board_id,
      last_seen_at: row.last_seen_at
    },
    agent: row,
    mode: 'agent',
    stance: options.stance || 'read_only',
    require_identity: options.stance === 'deny',
    credential_rejected: false,
    via: 'token'
  };
}
