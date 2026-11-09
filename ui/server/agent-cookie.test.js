import { describe, expect, test } from 'vitest';
import {
  AGENT_TOKEN_COOKIE,
  agentTokenCookie,
  clearAgentTokenCookie,
  isSecureRequest,
  readAgentTokenCookie,
  readCookie
} from './agent-cookie.js';

/**
 * The cookie the browser carries its agent token in.
 *
 * Small surface, three things worth pinning: that the attributes a token needs are
 * all present, that `Secure` follows the connection rather than being assumed, and
 * that reading a header cannot throw — a browser sends whatever cookies the origin
 * has accumulated, and one malformed pair must not take a connection down.
 */
describe('readCookie', () => {
  test('reads a value by name', () => {
    expect(
      readCookie('a=1; feads_agent_token=fdsa_abc; b=2', 'feads_agent_token')
    ).toBe('fdsa_abc');
  });

  test('returns empty for an absent cookie or header', () => {
    expect(readCookie('a=1', 'feads_agent_token')).toBe('');
    expect(readCookie('', 'feads_agent_token')).toBe('');
    expect(readCookie(undefined, 'feads_agent_token')).toBe('');
    expect(readCookie(null, 'feads_agent_token')).toBe('');
  });

  test('does not match a cookie whose name merely ends with the target', () => {
    // `other_feads_agent_token` is a different cookie, and treating it as this one
    // would let any script on the origin choose the credential.
    expect(
      readCookie('other_feads_agent_token=nope', 'feads_agent_token')
    ).toBe('');
  });

  test('decodes percent-encoding, and survives a broken sequence', () => {
    expect(readCookie('x=a%20b', 'x')).toBe('a b');
    expect(readCookie('x=%E0%A4%A', 'x')).toBe('');
  });

  test('a malformed pair does not lose the rest of the header', () => {
    expect(
      readCookie('junk; feads_agent_token=fdsa_abc', 'feads_agent_token')
    ).toBe('fdsa_abc');
  });

  test('readAgentTokenCookie trims and names the right cookie', () => {
    expect(readAgentTokenCookie(`${AGENT_TOKEN_COOKIE}= fdsa_abc `)).toBe(
      'fdsa_abc'
    );
    expect(readAgentTokenCookie('nothing=here')).toBe('');
  });
});

describe('isSecureRequest', () => {
  test('trusts express’s req.secure', () => {
    expect(isSecureRequest({ secure: true })).toBe(true);
    expect(isSecureRequest({ secure: false })).toBe(false);
  });

  test('falls back to the TLS socket for a bare upgrade request', () => {
    // The WebSocket handshake is an `IncomingMessage` with no express decoration.
    expect(isSecureRequest({ socket: { encrypted: true } })).toBe(true);
    expect(isSecureRequest({ socket: {} })).toBe(false);
  });

  test('a forwarded-proto header cannot talk it into true', () => {
    // The direction that matters: a forged "yes" would mark the cookie `Secure` on
    // a plain-HTTP connection, and the browser would then never send it back — a
    // login that appears to work and silently does nothing.
    expect(
      isSecureRequest(
        /** @type {any} */ ({
          headers: { 'x-forwarded-proto': 'https' },
          socket: {}
        })
      )
    ).toBe(false);
  });

  test('no request at all is not secure', () => {
    expect(isSecureRequest(undefined)).toBe(false);
    expect(isSecureRequest(null)).toBe(false);
  });
});

describe('agentTokenCookie', () => {
  test('is HttpOnly, SameSite=Strict and rooted at /', () => {
    const value = agentTokenCookie('fdsa_abc');

    expect(value).toContain(`${AGENT_TOKEN_COOKIE}=fdsa_abc`);
    // HttpOnly is the whole reason a cookie was chosen over localStorage: page
    // JavaScript must never be able to read the credential.
    expect(value).toContain('HttpOnly');
    // The cookie authorizes writes, so it must not ride along with a request some
    // other site caused.
    expect(value).toContain('SameSite=Strict');
    // `/ws` and `/api/…` both need it.
    expect(value).toContain('Path=/');
    expect(value).toMatch(/Max-Age=\d+/);
  });

  test('omits Secure on plain HTTP and sets it on HTTPS', () => {
    // Unconditional `Secure` is the trap: the dashboard serves plain HTTP on
    // 127.0.0.1, where the browser would accept the cookie and never send it back.
    expect(agentTokenCookie('fdsa_abc', { secure: false })).not.toContain(
      'Secure'
    );
    expect(agentTokenCookie('fdsa_abc', { secure: true })).toContain('Secure');
  });

  test('percent-encodes the value', () => {
    expect(agentTokenCookie('a b;c')).toContain('a%20b%3Bc');
  });

  test('round-trips through the reader', () => {
    const set = agentTokenCookie('fdsa_abc', { secure: false });
    const header = set.split(';')[0];

    expect(readAgentTokenCookie(header)).toBe('fdsa_abc');
  });
});

describe('clearAgentTokenCookie', () => {
  test('expires immediately and keeps the same attributes', () => {
    const value = clearAgentTokenCookie();

    expect(value).toContain(`${AGENT_TOKEN_COOKIE}=`);
    // Max-Age=0 rather than an omitted Max-Age: a session cookie would survive
    // until the browser closed, which is not what signing out means.
    expect(value).toContain('Max-Age=0');
    // The attributes must match the ones it was set with, or the browser treats it
    // as a different cookie and the old one stays.
    expect(value).toContain('Path=/');
    expect(value).toContain('HttpOnly');
    expect(value).toContain('SameSite=Strict');
  });

  test('follows the connection for Secure, like setting it does', () => {
    expect(clearAgentTokenCookie({ secure: true })).toContain('Secure');
    expect(clearAgentTokenCookie({ secure: false })).not.toContain('Secure');
  });
});
