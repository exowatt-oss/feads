import { html, nothing } from 'lit-html';

/**
 * Feads accounts mode: the people picker — find an example person by name or
 * email from the the optional directory roster (`GET /api/people`, space admins and
 * superadmins only) instead of typing an address from memory.
 *
 * A combobox over the `.menu` primitive. The input is an ordinary form field
 * named `email`: picking a person fills in their address, and a typed address
 * still submits as typed (the server's roster gate has the last word either
 * way). Stateless towards its host except for one callback: the host owns the
 * render and calls `template()` from its own.
 *
 * @param {Object} options
 * @param {(url: string) => Promise<any>} options.search - GET helper; resolves to the JSON body.
 * @param {() => void} options.onUpdate - Re-render the host.
 * @param {string} options.id - Unique per page; anchors the listbox ids.
 * @param {string} [options.label] - Accessible name of the input.
 * @param {string} [options.placeholder]
 * @param {(person: any) => string} [options.note] - A reason a person cannot be
 * picked ("already a member"), or '' when they can.
 * @param {number} [options.delay_ms] - Debounce before asking the server.
 */
export function createPeoplePicker(options) {
  const {
    search,
    onUpdate,
    id,
    label = 'Person',
    placeholder = 'Search by name or email',
    note = () => '',
    delay_ms = 160
  } = options;
  let query = '';
  /** @type {any[]} */
  let results = [];
  let open = false;
  let active = -1;
  let loading = false;
  let seq = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  /**
   * @param {number} from
   * @param {number} step
   */
  function nextPickable(from, step) {
    for (let i = 1; i <= results.length; i += 1) {
      const at = (from + step * i + results.length * 2) % results.length;
      if (!note(results[at])) return at;
    }
    return -1;
  }

  /** @param {string} q */
  async function lookup(q) {
    const mine = ++seq;
    loading = true;
    onUpdate();
    const out = await search(`/api/people?q=${encodeURIComponent(q)}`);
    if (mine !== seq) return;
    loading = false;
    results =
      out?.ok && Array.isArray(out.people) ? out.people.slice(0, 8) : [];
    open = true;
    active = nextPickable(-1, 1);
    onUpdate();
  }

  /** @param {Event} ev */
  function onInput(ev) {
    query = /** @type {HTMLInputElement} */ (ev.target).value;
    if (timer) clearTimeout(timer);
    const q = query.trim();
    if (q.length < 2) {
      seq += 1;
      results = [];
      open = false;
      loading = false;
      onUpdate();
      return;
    }
    timer = setTimeout(() => void lookup(q), delay_ms);
  }

  /** @param {any} person */
  function pick(person) {
    if (note(person)) return;
    query = String(person.email || '');
    open = false;
    onUpdate();
  }

  /** @param {KeyboardEvent} ev */
  function onKeydown(ev) {
    if (!open || results.length === 0) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      active = nextPickable(active, ev.key === 'ArrowDown' ? 1 : -1);
      onUpdate();
    } else if (ev.key === 'Enter') {
      // Enter picks while the list is open; with it closed, it submits.
      if (active >= 0) {
        ev.preventDefault();
        pick(results[active]);
      }
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      open = false;
      onUpdate();
    }
  }

  function onBlur() {
    if (!open) return;
    open = false;
    onUpdate();
  }

  function template() {
    const list_id = `${id}-list`;
    const show = open && (results.length > 0 || query.trim().length >= 2);
    return html`<div class="combobox">
      <input
        class="input"
        name="email"
        type="text"
        inputmode="email"
        autocomplete="off"
        spellcheck="false"
        role="combobox"
        aria-label=${label}
        aria-autocomplete="list"
        aria-expanded=${show ? 'true' : 'false'}
        aria-controls=${list_id}
        aria-activedescendant=${show && active >= 0
          ? `${id}-opt-${active}`
          : nothing}
        placeholder=${placeholder}
        .value=${query}
        @input=${onInput}
        @keydown=${onKeydown}
        @blur=${onBlur}
      />
      ${show
        ? html`<ul class="menu combobox__menu" role="listbox" id=${list_id}>
            ${results.length === 0
              ? html`<li class="combobox__empty" role="presentation">
                  ${loading ? 'Searching…' : 'No one on the roster matches.'}
                </li>`
              : results.map((person, i) => {
                  const why = note(person);
                  return html`<li
                    class="menu__item combobox__option"
                    role="option"
                    id=${`${id}-opt-${i}`}
                    aria-selected=${i === active ? 'true' : 'false'}
                    aria-disabled=${why ? 'true' : 'false'}
                    data-active=${i === active ? 'true' : 'false'}
                    @pointerdown=${(/** @type {Event} */ e) =>
                      e.preventDefault()}
                    @click=${() => pick(person)}
                  >
                    <span class="combobox__primary"
                      >${person.name || person.email}</span
                    >
                    <span class="combobox__secondary"
                      >${[person.email, person.department]
                        .filter(Boolean)
                        .join(' · ')}</span
                    >
                    ${why
                      ? html`<span class="combobox__note">${why}</span>`
                      : ''}
                  </li>`;
                })}
          </ul>`
        : ''}
    </div>`;
  }

  return {
    template,
    /** The current text: a picked address, or whatever was typed. */
    value: () => query.trim(),
    reset() {
      if (timer) clearTimeout(timer);
      seq += 1;
      query = '';
      results = [];
      open = false;
      loading = false;
      active = -1;
    }
  };
}
