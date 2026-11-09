/**
 * feads addition — how the bundle knows which build it is, and which staleness applies.
 *
 * The whole point of `ownBundleId` reading a URL rather than a build-time stamp is that
 * a file cannot contain the hash of itself, so these tests are mostly about the honest
 * failure mode: an unstamped load has to read as *unknown*, never as stale. A false
 * "update available" on a page that is perfectly current teaches people to ignore the
 * banner, and then the true one is missed too.
 */
import { describe, expect, test } from 'vitest';
import { ownBundleId, stalenessOf } from './build-info.js';

describe('ownBundleId', () => {
  test('reads the id the server stamped onto the script URL', () => {
    expect(ownBundleId('http://localhost:3000/main.bundle.js?v=abc123')).toBe(
      'abc123'
    );
  });

  test('an unstamped URL is unknown, not empty-as-a-value', () => {
    expect(ownBundleId('http://localhost:3000/main.bundle.js')).toBe('');
  });

  test('survives a file: URL, which is what a test or a local open produces', () => {
    expect(ownBundleId('file:///Users/x/app/main.bundle.js')).toBe('');
  });

  test('survives an unparseable URL rather than throwing on load', () => {
    // This runs at module scope in the real bundle. Throwing here would take the whole
    // dashboard down over a diagnostic.
    expect(ownBundleId('::::')).toBe('');
  });

  test('ignores other query parameters', () => {
    expect(ownBundleId('/main.bundle.js?x=1&v=deadbeef&y=2')).toBe('deadbeef');
  });
});

describe('stalenessOf', () => {
  test('a different bundle id is client staleness', () => {
    const stale = stalenessOf({ bundle_id: 'new', server_stale: false }, 'old');
    expect(stale.client_stale).toBe(true);
    expect(stale.server_stale).toBe(false);
  });

  test('the same bundle id is not', () => {
    const stale = stalenessOf(
      { bundle_id: 'same', server_stale: false },
      'same'
    );
    expect(stale.client_stale).toBe(false);
  });

  test('an unknown id on either side is not staleness', () => {
    // A difference from an unknown is not evidence of anything, and guessing wrong here
    // means telling somebody to reload a page that is already current.
    expect(stalenessOf({ bundle_id: 'new' }, '').client_stale).toBe(false);
    expect(stalenessOf({ bundle_id: '' }, 'old').client_stale).toBe(false);
    expect(stalenessOf(null, 'old').client_stale).toBe(false);
  });

  test('server staleness is taken from the server and nothing else', () => {
    // The client cannot compute it: only the daemon knows what it loaded at boot.
    const stale = stalenessOf(
      { bundle_id: 'same', server_stale: true },
      'same'
    );
    expect(stale.server_stale).toBe(true);
    expect(stale.client_stale).toBe(false);
  });

  test('both at once, which is what a deploy over a running daemon looks like', () => {
    // The original report. The two are independent, so they must be reportable together
    // — and the remedies are different, so they must not be merged.
    const stale = stalenessOf({ bundle_id: 'new', server_stale: true }, 'old');
    expect(stale).toEqual({ client_stale: true, server_stale: true });
  });

  test('a missing server_stale is false, not true', () => {
    // An older daemon that reports no such field must not be described as stale.
    expect(stalenessOf({ bundle_id: 'same' }, 'same').server_stale).toBe(false);
  });
});
