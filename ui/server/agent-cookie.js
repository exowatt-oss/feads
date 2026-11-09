/**
 * feads addition — how a browser carries an agent token.
 *
 * The dashboard's credential is an agent token, the same string an agent puts in
 * `FEADS_AGENT_TOKEN`. The browser has to hold it somewhere between page loads,
 * and the choice of *where* was made deliberately: an **HttpOnly cookie**, not
 * `localStorage`.
 *
 * The difference is what page JavaScript can reach. A token in `localStorage` is
 * readable by every script on the origin — including anything that ever lands in
 * a rendered issue description, which this app deliberately renders as Markdown.
 * A token in an HttpOnly cookie is not readable by any script at all; the browser
 * attaches it to requests and to the WebSocket handshake, and page code never
 * sees the value. So nothing in `ui/app/` ever holds the token, and there is no
 * code path that could put it in a WebSocket payload, a log line or an error body
 * because there is nothing to put.
 *
 * The attributes, and why each one:
 *
 * - `HttpOnly` — the whole point, above.
 * - `SameSite=Strict` — the cookie authorizes writes to a board, so it must not
 *   ride along with a request another site caused. Strict rather than Lax because
 *   nothing links into this dashboard from elsewhere; there is no navigation to
 *   preserve.
 * - `Path=/` — the WebSocket lives at `/ws` and the API at `/api/…`, so a
 *   narrower path would exclude one of them.
 * - `Secure` **only over HTTPS**. This is the one attribute that cannot be set
 *   unconditionally: the dashboard normally serves plain HTTP on 127.0.0.1, where
 *   a `Secure` cookie is accepted-and-never-sent-back. Login would appear to
 *   succeed and then do nothing, on every request, silently. So it is set from
 *   what the connection actually is.
 * - `Max-Age` — a convenience, not a control. The token is verified against the
 *   registry on every connection, so revoking an agent stops its cookie working
 *   immediately; the expiry only decides how long a browser bothers keeping a
 *   credential that may already be dead.
 *
 * ## What this is not
 *
 * Not a session store. There is no server-side session, no session id and no
 * device binding of any kind — no fingerprint, no IP check. Possession of the
 * token is the whole credential, exactly as it is for an agent in a shell, which
 * is what makes "the human in the browser sees what their agent sees" true rather
 * than approximately true. Locally this remains an integrity control: a shell
 * next to the browser can still run `bd delete` with no cookie at all.
 */

/** The cookie the browser presents its agent token in. */
export const AGENT_TOKEN_COOKIE = 'feads_agent_token';

/**
 * How long a browser keeps the credential, in seconds.
 *
 * Long enough that a human is not re-pasting a token every day, short enough that
 * an abandoned browser profile does not carry one indefinitely. Not a security
 * boundary — see the header.
 */
export const AGENT_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Read one cookie out of a `Cookie` header.
 *
 * Hand-rolled rather than adding a dependency: this parses one header into one
 * value, and the express `cookie-parser` middleware would also attach every
 * cookie on the origin to `req` where other code could pick a credential up by
 * accident.
 *
 * Tolerant on purpose — a browser sends whatever cookies the origin has
 * accumulated, and one malformed pair must not lose the rest.
 *
 * @param {string | undefined | null} header - A raw `Cookie` header.
 * @param {string} name
 * @returns {string} The value, or `''` when absent or unreadable.
 */
export function readCookie(header, name) {
  const raw = String(header || '');
  if (raw.length === 0) {
    return '';
  }
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      continue;
    }
    if (part.slice(0, eq).trim() !== name) {
      continue;
    }
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      // A percent sequence a browser would not have produced. Returning the raw
      // value would present something the registry cannot match anyway, and
      // throwing would take the whole connection down over a stray cookie.
      return '';
    }
  }
  return '';
}

/**
 * The agent token this request or handshake presented, if any.
 *
 * @param {string | undefined | null} cookie_header
 * @returns {string}
 */
export function readAgentTokenCookie(cookie_header) {
  return readCookie(cookie_header, AGENT_TOKEN_COOKIE).trim();
}

/**
 * Whether the connection is actually TLS, for the `Secure` attribute.
 *
 * Read from the socket, never from a header. Express's `req.secure` is derived
 * from `req.protocol`, which only consults `X-Forwarded-Proto` when `trust proxy`
 * is enabled — it is not — so a client cannot talk this into `true`. That
 * direction is the one that matters: a forged "yes" would mark the cookie
 * `Secure` on a plain-HTTP connection and the browser would never send it back.
 *
 * @param {{ secure?: boolean, socket?: unknown, connection?: unknown } | undefined | null} req
 * @returns {boolean}
 */
export function isSecureRequest(req) {
  if (!req) {
    return false;
  }
  if (req.secure === true) {
    return true;
  }
  // The WebSocket upgrade request is a bare `IncomingMessage` with no express
  // decoration, so fall back to what the TLS socket itself reports. `encrypted` is
  // only present on a `TLSSocket`, which is why the socket is read loosely: the
  // types say `net.Socket` and the runtime value is the subclass or not.
  const socket = /** @type {{ encrypted?: boolean } | undefined} */ (
    req.socket || req.connection
  );
  return socket?.encrypted === true;
}

/**
 * The `Set-Cookie` value that stores an agent token.
 *
 * @param {string} token
 * @param {{ secure?: boolean, max_age_seconds?: number }} [options]
 * @returns {string}
 */
export function agentTokenCookie(token, options = {}) {
  const max_age =
    typeof options.max_age_seconds === 'number'
      ? options.max_age_seconds
      : AGENT_TOKEN_MAX_AGE_SECONDS;
  return serializeCookie(AGENT_TOKEN_COOKIE, String(token), {
    max_age_seconds: max_age,
    secure: options.secure === true
  });
}

/**
 * The `Set-Cookie` value that clears it.
 *
 * `Max-Age=0` with an empty value rather than an omitted `Max-Age`: a session
 * cookie would survive until the browser closed, which is not what "log out"
 * means. The attributes must otherwise match the ones it was set with or the
 * browser treats it as a different cookie and the old one stays.
 *
 * @param {{ secure?: boolean }} [options]
 * @returns {string}
 */
export function clearAgentTokenCookie(options = {}) {
  return serializeCookie(AGENT_TOKEN_COOKIE, '', {
    max_age_seconds: 0,
    secure: options.secure === true
  });
}

/**
 * @param {string} name
 * @param {string} value
 * @param {{ max_age_seconds: number, secure: boolean }} attributes
 * @returns {string}
 */
function serializeCookie(name, value, attributes) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(attributes.max_age_seconds))}`
  ];
  if (attributes.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}
