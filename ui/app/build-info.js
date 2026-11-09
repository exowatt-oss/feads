/**
 * feads addition — which build *this bundle* is, and which kind of stale the page is.
 *
 * ## How the bundle knows its own identity
 *
 * From the URL it was loaded with. The server serves `index.html` with the script tag
 * stamped `main.bundle.js?v=<bundle_id>` (see `stampBundleUrl` in `server/app.js`), and
 * `import.meta.url` in the bundled output *is* that URL, query and all. So the running
 * script can read the id of the build it came from with no build-time injection at all.
 *
 * That is not a shortcut, it is the only non-circular option. The honest identity of a
 * bundle is a hash of its bytes, and a file cannot contain the hash of itself. The
 * alternatives are a sidecar file the build has to keep in step, or a stamp computed
 * from the *sources* — which lies precisely when it matters, because sources edited
 * without a rebuild would report a build that was never produced. Reading the URL makes
 * the bundle's identity and the server's answer come from the same fact: the bytes on
 * disk.
 *
 * An unstamped load — a test in jsdom, a page opened from the filesystem, an old
 * `index.html` from a cache that predates the stamping — yields `''`, and `''` is
 * treated as *unknown*, never as stale. A false "update available" on a page that is
 * perfectly current teaches people to ignore the banner, which costs more than the
 * missed warning.
 */

/**
 * The build id this bundle was served as, or `''` when it was not served with one.
 *
 * @param {string} [url] - Defaults to this module's own URL. A parameter only so a
 * test can exercise the parsing without a bundler.
 * @returns {string}
 */
export function ownBundleId(url = import.meta.url) {
  try {
    return new URL(String(url), 'http://localhost').searchParams.get('v') || '';
  } catch {
    // A `file:` URL or anything unparseable. Unknown, which is not stale.
    return '';
  }
}

/**
 * @typedef {Object} BuildStaleness
 * @property {boolean} client_stale - The bundle in this browser is not the one on the
 * server. A reload fixes it.
 * @property {boolean} server_stale - The daemon is not running the code on disk. A
 * reload cannot fix it; only a restart can.
 */

/**
 * Which kinds of stale apply, given what this bundle is and what the server reported.
 *
 * The two are computed and reported separately on purpose, and never collapsed into one
 * "out of date". Their remedies differ, and telling somebody to reload when reloading
 * cannot help sends them round a loop with no exit — the exact experience this whole
 * feature exists to end. They are also not mutually exclusive: a daemon that has been up
 * across a deploy is usually *both*, which was the original report.
 *
 * @param {{ bundle_id?: string, server_stale?: boolean } | null | undefined} report
 * @param {string} [own_id] - This bundle's id; defaults to reading its own URL.
 * @returns {BuildStaleness}
 */
export function stalenessOf(report, own_id = ownBundleId()) {
  const mine = String(own_id || '');
  const theirs = String(report?.bundle_id || '');
  return {
    // Both ids have to be known. Either being empty means "cannot tell", and a
    // difference from an unknown is not evidence of anything.
    client_stale: mine.length > 0 && theirs.length > 0 && mine !== theirs,
    server_stale: report?.server_stale === true
  };
}
