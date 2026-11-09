/**
 * Two tiers, one policy.
 *
 * Every surface that can act on a board — the UI server, the MCP server, the
 * `feads-agent` CLI — asks this module the same question and gets the same answer.
 * There is exactly one implementation on purpose: the routing code already carries
 * a [parity contract](https://github.com/exowatt-oss/feads#configuration) between two hand-written
 * implementations, and that is the single largest maintenance cost in the codebase.
 * Authorization must not repeat that mistake, because a permission check that
 * disagrees between two surfaces is a security bug rather than a routing quirk.
 *
 * The tiers:
 *
 * | | anonymous | `user` | `admin` |
 * | --- | --- | --- | --- |
 * | Read any board, any item | yes | yes | yes |
 * | **Mint a `user` invite (sign up)** | **yes** | **yes** | **yes** |
 * | Create and update items | no | yes | yes |
 * | Delete an item it created | no | yes | yes |
 * | Delete anyone else's item | no | **no** | yes |
 * | List the registered agents | no | own row only | all rows |
 * | Mint an **admin** invite, revoke, promote | no | **no** | yes |
 *
 * ## Sign-up is open; the admin tier is not
 *
 * Anyone — including a visitor who has presented nothing — may mint a `user` invite.
 * This is not a secret system: the point of an identity here is that claims stop
 * lying about who holds them, not that access is rationed. Gating sign-up would only
 * mean a human has to go find someone with a CLI before their agent can be honest
 * about its own name.
 *
 * Minting an **admin** invite is the one exception, and it has to be, or the tier is
 * decorative: if anyone could mint an admin invite, anyone could self-promote past
 * the delete rules in one step, and "a user may only delete its own items" would mean
 * nothing at all.
 *
 * Reads are deliberately not scoped. A `user` sees every board and every item; the
 * board exists so agents can see each other's work, and a permission model that
 * hid other agents' beads would defeat the collision detection it is meant to
 * protect. The only thing tier controls is destruction and administration.
 *
 * ## What this can and cannot enforce
 *
 * These checks bind the surfaces that route through feads. They do **not** bind a
 * shell that runs `bd delete` directly — `bd` is a local Go binary reading a local
 * Dolt database, with no auth layer to hook. So today this is an *integrity* control
 * against an agent doing something destructive by mistake or by misreading its
 * remit, not a *security boundary* against a hostile local process.
 *
 * That gap closes when the registry moves behind HTTP (see
 * `the excluded hosted-provider design`), because then the service,
 * not the caller, holds the database. Writing the policy here now is what makes
 * that a deployment change rather than a redesign — but until then, do not describe
 * this as sandboxing an untrusted agent, because it is not.
 */

/** The only two tiers. There is no third, and no per-action grants. */
export const ROLES = /** @type {const} */ (['user', 'admin']);

/**
 * What an *unidentified* caller is treated as. Not a tier — tiers belong to
 * registered agents — but the stance a surface takes toward someone who presented
 * nothing at all.
 *
 * - `operator` — unrestricted. Correct for the CLI, which is the local trust root:
 *   whoever can run it can already edit the SQLite file it writes, and it is the
 *   only path that can mint the *first* invite. Minting needs admin, admin needs a
 *   redeemed invite, so a CLI without operator mode would make the whole model
 *   unbootstrappable.
 * - `read_only` — may read every board, may change nothing. Correct for the browser,
 *   where presenting a credential is a real affordance (a login box) and "view the
 *   board, log in to act" is the honest offer.
 * - `deny` — refuse outright. What a hosted deployment sets, where the service holds
 *   the database and the caller does not.
 *
 * The stance is per surface on purpose. The alternative — one global answer — forces
 * either a CLI that cannot bootstrap or a browser that hands full delete rights to
 * anyone who opens the page.
 */
export const UNIDENTIFIED_STANCES = /** @type {const} */ (['operator', 'read_only', 'deny']);

/** What a surface assumes when it says nothing: the pre-existing CLI behaviour. */
export const DEFAULT_UNIDENTIFIED_STANCE = 'operator';

/** What a caller may attempt. */
export const ACTIONS = /** @type {const} */ ([
  'read',
  'write',
  'delete',
  'mint_invite',
  'delegate_agent',
  'manage_agents',
  'manage_silos',
  'view_roster'
]);

export const DEFAULT_ROLE = 'user';

/**
 * Coerce anything into a valid role, defaulting to the least privileged.
 *
 * Unknown input falls back to `user` rather than throwing: a row written by a newer
 * version with a role this build does not know must not fail open to admin.
 *
 * @param {string} [input]
 * @returns {'user'|'admin'}
 */
export function normalizeRole(input) {
  const role = String(input || '')
    .trim()
    .toLowerCase();
  return role === 'admin' ? 'admin' : DEFAULT_ROLE;
}

/**
 * Whether a string names a role exactly. Used to reject typos at the CLI boundary,
 * where silently downgrading `--role admni` to `user` would be worse than an error.
 *
 * @param {string} input
 * @returns {boolean}
 */
export function isRole(input) {
  return ROLES.includes(
    /** @type {'user'|'admin'} */ (String(input || '').trim().toLowerCase())
  );
}

/**
 * @param {{ role?: string } | null | undefined} agent
 * @returns {boolean}
 */
export function isAdmin(agent) {
  return !!agent && normalizeRole(agent.role) === 'admin';
}

/**
 * Whether a `mint_invite` request is asking for the admin tier.
 *
 * Tested on the raw string rather than through `normalizeRole`, which maps anything
 * unrecognized to `user`. That fallback is right for reading a stored row and wrong
 * here: a request for `role: "Admin "` or `"ADMIN"` must be recognized as an
 * escalation attempt and checked, not quietly downgraded to an open sign-up.
 *
 * @param {{ role?: string }} resource
 * @returns {boolean}
 */
function wantsAdminInvite(resource) {
  return String(resource?.role || '').trim().toLowerCase() === 'admin';
}

/**
 * @typedef {object} Decision
 * @property {boolean} allowed
 * @property {string} reason  Always populated, including on allow, so a caller can
 *   log why something was permitted as readily as why it was not.
 */

/**
 * Decide whether an agent may perform an action.
 *
 * @param {{ actor?: string, role?: string, revoked_at?: number } | null | undefined} agent
 *   The registered agent, or null/undefined for an unidentified caller.
 * @param {'read'|'write'|'delete'|'mint_invite'|'manage_agents'|'manage_silos'|'view_roster'} action
 * @param {{ created_by?: string, id?: string, role?: string }} [resource]
 *   For `delete`, `created_by` is the item's creator — bd populates this from the
 *   creating agent's `BEADS_ACTOR`, which is exactly the actor name minted here.
 * @returns {Decision}
 */
export function can(agent, action, resource = {}) {
  if (!agent) {
    return {
      allowed: false,
      reason: 'no registered agent identity — run the feads register skill first'
    };
  }
  if (agent.revoked_at && Number(agent.revoked_at) > 0) {
    return { allowed: false, reason: `agent ${agent.actor} is revoked` };
  }

  const role = normalizeRole(agent.role);
  const admin = role === 'admin';

  switch (action) {
    case 'read':
      // Unscoped by design — see the module header.
      return { allowed: true, reason: `${role} may read every board` };

    case 'write':
      return { allowed: true, reason: `${role} may create and update items` };

    case 'delete': {
      if (admin) return { allowed: true, reason: 'admin may delete any item' };
      const creator = String(resource.created_by || '');
      if (!creator) {
        // Refusing an unattributed item is the safe default: treating "no creator
        // recorded" as "yours" would let a user delete every item that predates
        // creator attribution.
        return {
          allowed: false,
          reason:
            `${resource.id || 'item'} has no recorded creator, so a user cannot ` +
            'establish ownership — an admin must delete it'
        };
      }
      if (creator === agent.actor) {
        return { allowed: true, reason: `user created ${resource.id || 'this item'}` };
      }
      return {
        allowed: false,
        reason:
          `${resource.id || 'item'} was created by ${creator}, not ${agent.actor} — ` +
          'a user may only delete its own items'
      };
    }

    case 'mint_invite':
      // Open to every tier, because sign-up is open — except for the admin tier,
      // which would otherwise be self-service and therefore meaningless.
      if (wantsAdminInvite(resource)) {
        return admin
          ? { allowed: true, reason: 'admin may mint an admin invite' }
          : {
              allowed: false,
              reason:
                `${agent.actor} is a user — only an admin may mint an admin invite ` +
                '(minting a user invite is open to anyone)'
            };
      }
      return { allowed: true, reason: `${role} may mint a user invite — sign-up is open` };

    case 'delegate_agent':
      return { allowed: true, reason: `${role} may delegate a user-tier child agent` };

    case 'manage_agents':
      return admin
        ? { allowed: true, reason: 'admin may revoke agents and change tiers' }
        : {
            allowed: false,
            reason: `${agent.actor} is a user — only an admin may manage agents`
          };

    case 'manage_silos':
      return admin
        ? { allowed: true, reason: 'admin may manage silos' }
        : {
            allowed: false,
            reason: `${agent.actor} is a user — only an admin may manage silos`
          };

    case 'view_roster':
      // A user is not blocked outright: it may see itself. Callers narrow the
      // result with `rosterScope`, so "allowed" here means "may call it at all".
      return { allowed: true, reason: admin ? 'admin sees every agent' : 'user sees itself' };

    default:
      return { allowed: false, reason: `unknown action: ${action}` };
  }
}

/**
 * Decide, accounting for callers that present no identity at all.
 *
 * This is what surfaces actually call, and it exists because "no identity" has to
 * mean something coherent. Two candidate answers, and the wrong one is tempting:
 *
 * - *Deny.* Sounds strict, but it would blank the local dashboard for anyone who
 *   has not registered, and gate reading your own board on a ceremony — while
 *   changing nothing about what that person can do, since they can still run `bd
 *   delete` in the shell next to it.
 * - *Allow, as the operator.* Whoever can reach the local UI or CLI already owns the
 *   database file. Treating them as the operator states that trust boundary instead
 *   of pretending to enforce one that does not exist.
 *
 * So unidentified callers are the operator by default, and `require_identity` (set
 * from `FEADS_REQUIRE_AGENT`) flips it to deny. A hosted deployment sets that flag:
 * there the service holds the database, the caller does not, and "they could run bd
 * anyway" stops being true — which is the point at which this becomes a real
 * security boundary rather than an integrity control.
 *
 * @param {{ actor?: string, role?: string, revoked_at?: number } | null | undefined} agent
 * @param {'read'|'write'|'delete'|'mint_invite'|'manage_agents'|'manage_silos'|'view_roster'} action
 * @param {{ created_by?: string, id?: string, role?: string }} [resource]
 * ## A rejected credential is not the same as no credential
 *
 * `credential_rejected` says the caller presented a token and it did not verify —
 * usually because the agent was revoked. That must **deny**, and it must deny even
 * when `require_identity` is off, because the permissive fallback would otherwise
 * invert revocation: a `user` whose token stops verifying would resolve to
 * "unidentified", become the operator, and so gain the ability to delete anything.
 * Revoking an agent would *promote* it. Silence about the distinction is what makes
 * this easy to get wrong — the two states look identical at the call site, since both
 * produce a null agent.
 *
 * @param {{ unidentified?: 'operator'|'read_only'|'deny', require_identity?: boolean,
 *           credential_rejected?: boolean }} [options]
 *   `unidentified` is the surface's stance (see UNIDENTIFIED_STANCES).
 *   `require_identity: true` is accepted as an alias for `unidentified: 'deny'`.
 * @returns {Decision & { mode: 'agent'|'operator'|'anonymous'|'rejected' }}
 */
export function decide(agent, action, resource = {}, options = {}) {
  if (agent) return { ...can(agent, action, resource), mode: 'agent' };
  if (options.credential_rejected) {
    return {
      allowed: false,
      reason:
        'a credential was presented and did not verify — the agent may have been ' +
        'revoked; register again with a fresh invite, or present no credential at all',
      mode: 'rejected'
    };
  }

  const stance = options.require_identity ? 'deny' : normalizeStance(options.unidentified);

  if (stance === 'deny') {
    // Sign-up stays open even here — with one carve-out for the admin tier.
    // Originally deny closed sign-up too ("a hosted deployment is not offering
    // open sign-up at this door"), which made the deny stance unescapable from
    // the dashboard: a first-time visitor needs an identity to get an identity.
    // The hosted deployment that finally exists sits behind the platform's
    // hosted SSO, so everyone who reaches this door is already an
    // authenticated employee — enrollment is how a caller *satisfies* the
    // requirement, the same reason the login route carries no policy gate.
    if (action === 'mint_invite') {
      if (wantsAdminInvite(resource)) {
        return {
          allowed: false,
          reason:
            'sign-up is open, but only an admin may mint an admin invite — ' +
            'ask an existing admin, or mint one from the CLI',
          mode: 'anonymous'
        };
      }
      return {
        allowed: true,
        reason:
          'sign-up is open to anyone — minting a user invite (this surface ' +
          'requires an identity for everything else)',
        mode: 'anonymous'
      };
    }
    return {
      allowed: false,
      reason:
        'this surface requires an agent identity and none was presented — ' +
        'register with an invite token, or paste an existing agent token',
      mode: 'anonymous'
    };
  }

  if (stance === 'read_only') {
    // Reads stay open so the board is visible before you log in: hiding it would gate
    // *looking* on a ceremony while changing nothing about what a local shell can do.
    if (action === 'read') {
      return {
        allowed: true,
        reason: 'no identity presented — read-only access to every board',
        mode: 'anonymous'
      };
    }
    // Sign-up is the one *write* an anonymous visitor may cause, and it has to be:
    // this is how a first-time visitor gets an identity at all, and requiring one to
    // get one is a closed loop. Still not the admin tier — that would make sign-up a
    // self-promotion button.
    if (action === 'mint_invite') {
      if (wantsAdminInvite(resource)) {
        return {
          allowed: false,
          reason:
            'sign-up is open, but only an admin may mint an admin invite — ' +
            'ask an existing admin, or mint one from the CLI',
          mode: 'anonymous'
        };
      }
      return {
        allowed: true,
        reason: 'sign-up is open to anyone — minting a user invite',
        mode: 'anonymous'
      };
    }
    return {
      allowed: false,
      reason:
        `no identity presented, so this session is read-only — paste the token your ` +
        `agent uses, or sign up for one, to ${action === 'delete' ? 'delete' : action} anything`,
      mode: 'anonymous'
    };
  }

  return {
    allowed: true,
    reason:
      'operator mode: no agent identity presented, and a local caller already owns ' +
      'the database (set FEADS_REQUIRE_AGENT=1 to refuse instead)',
    mode: 'operator'
  };
}

/**
 * Coerce a stance, defaulting to the least surprising rather than the most permissive.
 *
 * Unknown input falls back to `operator` because that is the *pre-existing* behaviour
 * of every surface that does not pass a stance — failing closed to `deny` here would
 * silently break the CLI on a typo, which is a worse outcome than the typo.
 *
 * @param {string} [input]
 * @returns {'operator'|'read_only'|'deny'}
 */
export function normalizeStance(input) {
  const stance = String(input || '').trim().toLowerCase();
  return stance === 'read_only' || stance === 'deny'
    ? /** @type {'read_only'|'deny'} */ (stance)
    : DEFAULT_UNIDENTIFIED_STANCE;
}

/**
 * The stance a surface should take, given its own default and the environment.
 *
 * `FEADS_REQUIRE_AGENT=1` upgrades any surface to `deny`; it can only ever tighten.
 *
 * @param {'operator'|'read_only'|'deny'} surface_default
 * @param {Record<string, string | undefined>} [env]
 * @returns {'operator'|'read_only'|'deny'}
 */
export function stanceFor(surface_default, env = process.env) {
  if (requireIdentityFromEnv(env)) return 'deny';
  return normalizeStance(surface_default);
}

/**
 * Whether unidentified callers should be refused. Read from the environment so a
 * deployment can tighten every surface at once without a code change.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function requireIdentityFromEnv(env = process.env) {
  const raw = String(env.FEADS_REQUIRE_AGENT || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Like `can`, but throws. For call sites where the failure is exceptional rather
 * than a branch — the CLI and the MCP tools, mostly.
 *
 * @param {{ actor?: string, role?: string, revoked_at?: number } | null | undefined} agent
 * @param {'read'|'write'|'delete'|'mint_invite'|'manage_agents'|'manage_silos'|'view_roster'} action
 * @param {{ created_by?: string, id?: string, role?: string }} [resource]
 * @returns {Decision}
 */
export function require_(agent, action, resource = {}) {
  const decision = can(agent, action, resource);
  if (!decision.allowed) {
    const err = new Error(decision.reason);
    /** @type {any} */ (err).code = 'forbidden';
    /** @type {any} */ (err).action = action;
    throw err;
  }
  return decision;
}

/**
 * How much of the roster a caller may see.
 *
 * The admin page is "every registered agent"; a user asking the same question gets
 * its own row rather than an error, because knowing its own identity and tier is
 * how an agent explains what it may do.
 *
 * @param {{ id?: string, role?: string, revoked_at?: number } | null | undefined} agent
 * @returns {{ scope: 'all'|'self'|'none', agent_id?: string }}
 */
export function rosterScope(agent) {
  if (!agent) return { scope: 'none' };
  // Note the asymmetry with `decide`: a *null* agent gets nothing here, because this
  // function only knows about tiers. Whether an unidentified caller is a trusted
  // operator is a separate question, and answering it here would bake the local
  // trust assumption into a pure tier lookup. Surfaces call `rosterScopeFor`.
  // Revocation outranks tier, exactly as in `can`. A revoked admin credential that
  // still returned the full roster would make revoking one cosmetic.
  if (agent.revoked_at && Number(agent.revoked_at) > 0) return { scope: 'none' };
  if (isAdmin(agent)) return { scope: 'all' };
  return { scope: 'self', agent_id: agent.id };
}

/**
 * The roster scope a *surface* should apply, operator mode included.
 *
 * Every surface that shows a roster must call this rather than `rosterScope`, and
 * this exists because getting it wrong is silent: an operator run through the plain
 * tier lookup resolves to `none` and sees an **empty** roster, which reads as "no
 * agents are registered" rather than "you were not recognized". That is a worse
 * failure than an error, and it is not hypothetical — the CLI shipped it for exactly
 * as long as it took to run the command by hand.
 *
 * @param {{ id?: string, role?: string, revoked_at?: number } | null | undefined} agent
 * @param {{ unidentified?: 'operator'|'read_only'|'deny', require_identity?: boolean,
 *           credential_rejected?: boolean }} [options]
 * @returns {{ scope: 'all'|'self'|'none', agent_id?: string }}
 */
export function rosterScopeFor(agent, options = {}) {
  if (agent) return rosterScope(agent);
  // An operator owns the database, so it sees the whole roster like an admin. A
  // read-only or denied caller sees none of it: who else is registered is
  // administrative data, and the roster is the one read that is not simply "the
  // board", so it does not ride along with read-only board access.
  const stance = options.require_identity ? 'deny' : normalizeStance(options.unidentified);
  if (options.credential_rejected || stance !== 'operator') return { scope: 'none' };
  return { scope: 'all' };
}
