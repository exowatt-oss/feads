/**
 * feads addition — where an agent should point its MCP client.
 *
 * After a human signs in or signs up in the browser, the thing they hand their agent
 * is an **MCP connection**, not a shell incantation. The agent reaches feads over
 * MCP with the same token, and the MCP server carries its own instructions, so the
 * human pastes a connection and no context.
 *
 * This module answers one question: what URL. It is separated from the routes
 * because the answer is entirely a matter of configuration, and because getting it
 * wrong is worse than not answering — a plausible but wrong URL sends someone
 * debugging their agent's config, while "I do not know, set `FEADS_MCP_URL`" sends
 * them to the one place that fixes it.
 *
 * The defaults mirror `integrations/beads-mcp/src/beads_mcp/server.py`, which is
 * the authority: `FEADS_MCP_HOST` (default `127.0.0.1`), `FEADS_MCP_PORT` (default
 * `4143` — 4141 is the feads UI and 4142 its documented alternate), path `/mcp`.
 * `FEADS_MCP_URL` overrides the lot, which is what a hosted deployment behind a
 * proxy or a different path needs.
 *
 * ## Why a bind-all host is "unknown" rather than a URL
 *
 * `FEADS_MCP_HOST` is a *bind* address. `0.0.0.0` and `::` mean "every interface",
 * which is a perfectly good thing to listen on and not an address anything can
 * connect to. Printing `http://0.0.0.0:4143/mcp` would be exactly the plausible-
 * but-wrong answer this avoids: it fails for the reader in a way that looks like the
 * MCP server is down. So that case reports no URL and says which variable to set.
 *
 * ## What this cannot know
 *
 * Whether an HTTP MCP server is actually *running*. `FEADS_MCP_HTTP` is read by the
 * MCP process, not by this one, and the dashboard has no reason to be started with
 * it. So the URL is reported as where the MCP surface lives *if it is being served
 * over HTTP*, and the UI says as much rather than implying a live endpoint was
 * probed. Probing it from here would be a network call on a login response, and a
 * negative answer would be indistinguishable from "not started yet".
 */

/** Mirrors `DEFAULT_HTTP_HOST` in the MCP server. */
const DEFAULT_MCP_HOST = '127.0.0.1';
/** Mirrors `DEFAULT_HTTP_PORT`: 4141 is the UI, 4142 its alternate, so 4143. */
const DEFAULT_MCP_PORT = '4143';
/** Mirrors `DEFAULT_HTTP_PATH`. */
const DEFAULT_MCP_PATH = '/mcp';

/** Hosts that are bind addresses rather than places to connect to. */
const BIND_ALL_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*']);

/**
 * @typedef {Object} McpEndpoint
 * @property {string} url - `''` when it could not be determined.
 * @property {'explicit'|'derived'|'unknown'} source
 * @property {string} reason - Why, in words a reader can act on. Always populated,
 * including on success, so the UI can explain what it is showing.
 */

/**
 * Resolve the MCP endpoint from the environment.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {McpEndpoint}
 */
export function resolveMcpEndpoint(env = process.env) {
  const explicit = String(env.FEADS_MCP_URL || '').trim();
  if (explicit.length > 0) {
    try {
      // Parsed rather than trusted: a typo'd override is the one case where the
      // reader has already told us where the MCP is and we would still print
      // nonsense. Better to fall through to "unknown" and name the variable.
      const parsed = new URL(explicit);
      return {
        url: parsed.toString(),
        source: 'explicit',
        reason: 'from FEADS_MCP_URL'
      };
    } catch {
      return {
        url: '',
        source: 'unknown',
        reason:
          'FEADS_MCP_URL is set but is not a valid URL, so the MCP endpoint ' +
          'cannot be shown — fix it, or unset it to use the default'
      };
    }
  }

  const host = String(env.FEADS_MCP_HOST || DEFAULT_MCP_HOST).trim();
  const port = String(env.FEADS_MCP_PORT || DEFAULT_MCP_PORT).trim();
  if (BIND_ALL_HOSTS.has(host)) {
    return {
      url: '',
      source: 'unknown',
      reason:
        `FEADS_MCP_HOST is ${host}, which is a bind address rather than one an ` +
        'agent can connect to — set FEADS_MCP_URL to the address it should use'
    };
  }
  if (!/^\d+$/.test(port)) {
    return {
      url: '',
      source: 'unknown',
      reason:
        `FEADS_MCP_PORT is "${port}", which is not a port number — fix it, or ` +
        'set FEADS_MCP_URL'
    };
  }
  // Bracketed for IPv6, which is otherwise ambiguous against the port separator.
  const authority =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return {
    url: `http://${authority}:${port}${DEFAULT_MCP_PATH}`,
    source: 'derived',
    reason:
      'the default MCP address — this assumes the MCP server is being served ' +
      'over HTTP (`make mcp-http`)'
  };
}
