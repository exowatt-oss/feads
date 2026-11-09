/**
 * The person hover card — the always-loaded half: a few document listeners and
 * a loader. Any element carrying `data-person-hover="<handle>"` (a mention, an
 * owner chip, a "by <name>") opens the card on hover, or on keyboard focus when
 * it is focusable; Escape, leaving both name and card, scrolling or resizing
 * close it.
 *
 * Nothing heavy is in the main bundle: React, Radix and `@example/ux` live in
 * `people.bundle.js` (+ `.css`), fetched on the first hover or focus of a name
 * and never on page load. Until it arrives the name is just a styled name.
 *
 * Touch: a tap opens the card only for names that are their own control
 * (focusable ones — mentions in comments); names inside a card, row or button
 * keep that control's tap.
 */
import { personFor } from '../utils/people.js';

export const TRIGGER_SELECTOR = '[data-person-hover]';
const CARD_SELECTOR = '.exo-ux-hover-card';
export const OPEN_DELAY_MS = 300;
export const CLOSE_DELAY_MS = 200;

/**
 * @typedef {{ open: (input: { anchor: Element, person: import('../utils/people.js').PersonInfo,
 *               theme: 'light' | 'dark', onRequestClose: () => void }) => void,
 *             close: () => void, isOpen: () => boolean }} CardModule
 */

/**
 * The URL of the lazy bundle: next to the main bundle, with its version query,
 * so a deploy never pairs a new controller with an old card.
 *
 * @param {string} main_url - `import.meta.url` of the main bundle
 * @returns {{ js: string, css: string }}
 */
export function peopleBundleUrls(main_url) {
  const url = new URL(main_url);
  const base = url.pathname.replace(/[^/]*$/, '');
  return {
    js: `${base}people.bundle.js${url.search}`,
    css: `${base}people.bundle.css${url.search}`
  };
}

/**
 * @param {Document} doc
 * @returns {() => Promise<CardModule>}
 */
function defaultLoader(doc) {
  return async () => {
    const urls = peopleBundleUrls(import.meta.url);
    if (!doc.querySelector('link[data-people-bundle]')) {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = urls.css;
      link.setAttribute('data-people-bundle', '');
      doc.head.appendChild(link);
    }
    return /** @type {Promise<CardModule>} */ (
      import(/* @vite-ignore */ urls.js)
    );
  };
}

/**
 * @param {Document} doc
 * @returns {'light' | 'dark'}
 */
function themeOf(doc) {
  return doc.documentElement.getAttribute('data-theme') === 'dark'
    ? 'dark'
    : 'light';
}

/**
 * @param {EventTarget | null} node
 * @returns {Element | null}
 */
function asElement(node) {
  return node && /** @type {any} */ (node).nodeType === 1
    ? /** @type {Element} */ (node)
    : node && /** @type {any} */ (node).parentElement
      ? /** @type {any} */ (node).parentElement
      : null;
}

/**
 * Install the listeners (once per document). Returns an uninstall function.
 *
 * @param {{ document?: Document, load?: () => Promise<CardModule> }} [options]
 * @returns {() => void}
 */
export function installPersonHover(options = {}) {
  const doc = options.document || document;
  const load = options.load || defaultLoader(doc);
  /** @type {CardModule | null} */
  let card = null;
  /** @type {Promise<CardModule> | null} */
  let loading = null;
  /** @type {Element | null} the name the card shows (or is about to) */
  let target = null;
  /** @type {Element | null} the name under the pointer */
  let hovered = null;
  let on_card = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let open_timer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let close_timer;

  function ensure() {
    if (!loading) {
      loading = load().then(
        (m) => (card = m),
        (err) => {
          loading = null;
          throw err;
        }
      );
    }
    return loading;
  }

  /** @param {Element} el */
  function wanted(el) {
    return el.isConnected && (hovered === el || doc.activeElement === el);
  }

  /**
   * @param {Element} el
   * @param {number} delay
   */
  function show(el, delay) {
    clearTimeout(close_timer);
    if (target === el && card?.isOpen()) return;
    const person = personFor(el.getAttribute('data-person-hover'));
    if (!person) return;
    target = el;
    clearTimeout(open_timer);
    const started = Date.now();
    ensure()
      .then(() => {
        const left = Math.max(0, delay - (Date.now() - started));
        open_timer = setTimeout(() => {
          if (target !== el || !wanted(el) || !card) return;
          card.open({
            anchor: el,
            person,
            theme: themeOf(doc),
            onRequestClose: () => {
              if (target && (hovered === target || on_card)) return;
              hide(0);
            }
          });
        }, left);
      })
      .catch(() => {
        // The name stays a name; the next hover tries again.
      });
  }

  /** @param {number} delay */
  function hide(delay) {
    clearTimeout(open_timer);
    clearTimeout(close_timer);
    const run = () => {
      if (target && (hovered === target || on_card)) return;
      if (target && doc.activeElement === target) return;
      target = null;
      card?.close();
    };
    if (delay > 0) close_timer = setTimeout(run, delay);
    else run();
  }

  function forceHide() {
    clearTimeout(open_timer);
    clearTimeout(close_timer);
    target = null;
    hovered = null;
    on_card = false;
    card?.close();
  }

  /** @param {PointerEvent} ev */
  function onOver(ev) {
    const el = asElement(ev.target);
    if (!el) return;
    if (el.closest(CARD_SELECTOR)) {
      on_card = true;
      clearTimeout(close_timer);
      return;
    }
    const trigger = el.closest(TRIGGER_SELECTOR);
    if (!trigger || ev.pointerType === 'touch') return;
    if (hovered === trigger) return;
    hovered = trigger;
    show(trigger, OPEN_DELAY_MS);
  }

  /** @param {PointerEvent} ev */
  function onOut(ev) {
    const el = asElement(ev.target);
    if (!el) return;
    const to = asElement(ev.relatedTarget);
    const card_el = el.closest(CARD_SELECTOR);
    if (card_el) {
      if (to && card_el.contains(to)) return;
      on_card = false;
      hide(CLOSE_DELAY_MS);
      return;
    }
    const trigger = el.closest(TRIGGER_SELECTOR);
    if (!trigger || trigger !== hovered) return;
    if (to && trigger.contains(to)) return;
    hovered = null;
    if (target === trigger) hide(CLOSE_DELAY_MS);
    else clearTimeout(open_timer);
  }

  /** @param {FocusEvent} ev */
  function onFocusIn(ev) {
    const el = asElement(ev.target);
    const trigger = el ? el.closest(TRIGGER_SELECTOR) : null;
    if (trigger && trigger.getAttribute('tabindex') !== null) show(trigger, 0);
  }

  /** @param {FocusEvent} ev */
  function onFocusOut(ev) {
    const el = asElement(ev.target);
    if (!el || el !== target) return;
    const to = asElement(ev.relatedTarget);
    if (to && to.closest(CARD_SELECTOR)) return;
    // Focus left the name; hide unless the pointer still holds it open.
    setTimeout(() => hide(0), 0);
  }

  /** @param {KeyboardEvent} ev */
  function onKey(ev) {
    if (ev.key !== 'Escape' || !card?.isOpen()) return;
    // Escape closes the card, not the dialog the name sits in.
    ev.preventDefault();
    ev.stopPropagation();
    forceHide();
  }

  /** @param {PointerEvent} ev */
  function onDown(ev) {
    if (ev.pointerType !== 'touch') return;
    const el = asElement(ev.target);
    const trigger = el ? el.closest(TRIGGER_SELECTOR) : null;
    if (!trigger || trigger.getAttribute('tabindex') === null) return;
    hovered = trigger;
    show(trigger, 0);
  }

  /** @param {Event} ev */
  function onScroll(ev) {
    if (!card?.isOpen()) return;
    const el = asElement(ev.target);
    if (el && el.closest && el.closest(CARD_SELECTOR)) return;
    forceHide();
  }

  function onResize() {
    if (card?.isOpen()) forceHide();
  }

  const view = doc.defaultView;
  doc.addEventListener('pointerover', onOver);
  doc.addEventListener('pointerout', onOut);
  doc.addEventListener('pointerdown', onDown, true);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  view?.addEventListener('resize', onResize);
  return () => {
    forceHide();
    doc.removeEventListener('pointerover', onOver);
    doc.removeEventListener('pointerout', onOut);
    doc.removeEventListener('pointerdown', onDown, true);
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('focusout', onFocusOut);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('scroll', onScroll, { capture: true });
    view?.removeEventListener('resize', onResize);
  };
}
