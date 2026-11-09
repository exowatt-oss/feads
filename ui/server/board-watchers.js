/**
 * feads addition — one file watcher per board that somebody is actually looking
 * at, reference-counted by the connections looking at it.
 *
 * ## Why this exists
 *
 * Board selection used to be per daemon, so change detection could be too: the
 * server created exactly one `watchDb` at startup and `rebind()`-ed it whenever
 * the board changed. Once board selection became per connection (see
 * `active-board.js`) that stopped being expressible. N connections can sit on M
 * boards, and every one of those boards needs its own `fs.watch` — a single
 * watcher can only ever be bound to one directory, so with two boards on screen
 * one of them would silently stop updating.
 *
 * The alternative to a pool is a watcher per *connection*, which is wrong for a
 * different reason: three tabs on one board would open three `fs.watch` handles
 * on the same directory and deliver three copies of every change. So the unit is
 * the board, and connections are holders that keep it alive.
 *
 * ## The two failure modes this is shaped around
 *
 * Both are silent, which is why they get an explicit accounting rather than a
 * best-effort `close()` somewhere:
 *
 * - **A leaked watcher.** `fs.watch` keeps a `persistent: true` handle, so a
 *   watcher nobody released holds an OS resource *and* the event loop open for the
 *   life of the process. A dashboard that has had twenty boards visited over a day
 *   would be watching twenty directories, nineteen of them for nobody.
 * - **A connection still hearing about a board it left.** Releasing on switch is
 *   half of that; the other half is in `ws.js`, which re-points the connection's
 *   subscriptions at the same time. Both halves are needed: this pool decides
 *   whether the *notification* still arrives, and the subscription registry
 *   decides whose data it refreshes.
 *
 * A watcher is created on the first holder and closed on the last, so the number
 * of live watchers is exactly the number of distinct boards in use. `size()`
 * exists so a test can assert that rather than infer it.
 *
 * ## Keyed by the board directory, not by the board's registry id
 *
 * The key is whatever `ws.js` passes as `board.key`, and `ws.js` passes the
 * *physical* board — the `.beads` directory, or the project root when there is no
 * board directory. Not the registry id: the id is absent for an unregistered
 * board and can be adopted asynchronously after startup for a registered one, so
 * keying on it would let the same board be watched twice under two names.
 */
import { debug } from './logging.js';
import { watchDb } from './watcher.js';

const log = debug('board-watchers');

/**
 * A board to watch. `key` identifies it, `root_dir` is where the database is
 * resolved from.
 *
 * @typedef {Object} WatchedBoard
 * @property {string} key
 * @property {string} root_dir
 * @property {string} [board_dir]
 */

/**
 * What a watcher has to provide. `watchDb` satisfies this; a test can pass
 * anything that does.
 *
 * @typedef {Object} BoardWatcher
 * @property {() => void} close
 * @property {string} [path]
 */

/**
 * @typedef {Object} PoolEntry
 * @property {WatchedBoard} board
 * @property {BoardWatcher | null} watcher
 * @property {Set<object>} holders
 */

/**
 * Create a reference-counted pool of per-board file watchers.
 *
 * @param {Object} [options]
 * @param {(board: WatchedBoard, notify: () => void) => BoardWatcher} [options.create]
 *   - How to start watching a board. Injected so tests never open a real
 *   `fs.watch`; a leaked OS handle in a test suite shows up as a run that will not
 *   exit rather than as a failure, which is exactly the kind of thing to keep out
 *   of the default path.
 * @param {(board_key: string) => void} [options.onChange]
 *   - Called with the key of the board whose files changed. Deliberately not given
 *   the holders: who cares about a change is `ws.js`'s question, and answering it
 *   here would need this module to know about subscriptions.
 * @param {number} [options.debounce_ms]
 * @param {number} [options.cooldown_ms]
 */
export function createBoardWatcherPool(options = {}) {
  const onChange = options.onChange || (() => {});
  const debounce_ms = options.debounce_ms;
  const cooldown_ms = options.cooldown_ms;
  const create =
    options.create ||
    ((board, notify) =>
      watchDb(board.root_dir, notify, {
        ...(typeof debounce_ms === 'number' ? { debounce_ms } : {}),
        ...(typeof cooldown_ms === 'number' ? { cooldown_ms } : {})
      }));

  /** @type {Map<string, PoolEntry>} */
  const entries = new Map();

  /**
   * Start watching `board` on behalf of `holder`, or add `holder` to the watcher
   * that already exists for it.
   *
   * Idempotent per holder: a connection re-selecting the board it is already on
   * must not increment anything, or the release on its next switch would leave the
   * watcher behind forever. A `Set` gives that for free.
   *
   * @param {WatchedBoard} board
   * @param {object} holder
   * @returns {void}
   */
  function retain(board, holder) {
    const key = String(board?.key || '');
    if (key.length === 0 || !holder || typeof holder !== 'object') {
      return;
    }
    const existing = entries.get(key);
    if (existing) {
      existing.holders.add(holder);
      return;
    }
    /** @type {BoardWatcher | null} */
    let watcher = null;
    try {
      watcher = create(board, () => {
        log('change on board %s', key);
        onChange(key);
      });
    } catch (err) {
      // A board whose directory has gone is the ordinary case here, and it must
      // not take the connection down: the entry is still recorded so the holder
      // accounting stays symmetric with `release`, just without a watcher.
      log('unable to watch board %s: %o', key, err);
      watcher = null;
    }
    entries.set(key, { board, watcher, holders: new Set([holder]) });
    log('watching board %s (%d live)', key, entries.size);
  }

  /**
   * Drop `holder`'s interest in a board, closing the watcher when it was the last.
   *
   * @param {string} board_key
   * @param {object} holder
   * @returns {void}
   */
  function release(board_key, holder) {
    const key = String(board_key || '');
    const entry = entries.get(key);
    if (!entry) {
      return;
    }
    entry.holders.delete(holder);
    if (entry.holders.size > 0) {
      return;
    }
    entries.delete(key);
    try {
      entry.watcher?.close();
    } catch (err) {
      log('closing watcher for %s failed: %o', key, err);
    }
    log('stopped watching board %s (%d live)', key, entries.size);
  }

  /**
   * Drop `holder` from every board it holds. What a closing connection needs, and
   * the reason it is a separate call: a connection that closed mid-switch could
   * otherwise be holding two boards, and releasing only its current one would leak
   * the other.
   *
   * @param {object} holder
   * @returns {void}
   */
  function releaseAll(holder) {
    for (const key of Array.from(entries.keys())) {
      release(key, holder);
    }
  }

  /**
   * Close every watcher. For daemon shutdown and for test teardown.
   *
   * @returns {void}
   */
  function closeAll() {
    for (const [key, entry] of entries) {
      try {
        entry.watcher?.close();
      } catch (err) {
        log('closing watcher for %s failed: %o', key, err);
      }
    }
    entries.clear();
  }

  return {
    retain,
    release,
    releaseAll,
    closeAll,
    /**
     * Number of boards currently watched. This is the assertion that catches a
     * leak, so it counts entries rather than holders.
     *
     * @returns {number}
     */
    size() {
      return entries.size;
    },
    /**
     * @returns {string[]}
     */
    keys() {
      return Array.from(entries.keys());
    },
    /**
     * How many connections hold a board. `0` for a board nobody watches.
     *
     * @param {string} board_key
     * @returns {number}
     */
    holderCount(board_key) {
      return entries.get(String(board_key || ''))?.holders.size || 0;
    }
  };
}
