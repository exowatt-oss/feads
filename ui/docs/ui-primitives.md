# UI primitives

The dashboard's shared vocabulary, defined in `app/styles.css` (section
"Primitives", right after the element defaults). New pages — Spaces,
Departments, access/admin, Connect an agent — should be composed from these
instead of adding page-specific `*-header` / `*-empty` / `*-table` rules.

Rules the primitives encode:

- **One control height.** Buttons, inputs, selects, filter triggers and
  segmented items are `--control-h` (32px; `--control-h-sm` 26px).
- **Hairlines, not shadows.** Resting surfaces get `1px var(--border)`.
  Elevation (`--shadow-pop`, `--shadow-lg`) is only for things that float:
  menus, popovers, dialogs.
- **Colour is state.** Status, P0/P1 priority, danger and "live" carry colour.
  Type, labels, roles and counts are neutral. Decoration never gets a hue.
- **Scales, not numbers.** Use `--space-*` (2px steps; `--space-12` 24px,
  `--space-16` 32px), `--text-*` (`2xs` 10 · `xs` 11 · `sm` 12 · `base` 13 ·
  `md` 14 · `lg` 16 · `xl` 20 · `2xl` 24) and `--page-gutter` (20px, 12px on
  phones).
- **No sideways scrolling.** Wrap, stack or widen. The story graph is the one
  deliberate two-dimensional scroller, and it scrolls inside its own frame.

## Tokens worth knowing

| Token                                              | Use                                                      |
| -------------------------------------------------- | -------------------------------------------------------- |
| `--fg` / `--fg-muted` / `--muted` / `--muted-soft` | text, strongest to quietest (all ≥ 4.5:1 in both themes) |
| `--bg-app` / `--bg` / `--bg-subtle` / `--bg-soft`  | canvas → surface → inset → chip fill                     |
| `--border` / `--border-soft` / `--border-strong`   | default hairline / row divider / hover                   |
| `--brand-action`                                   | fill behind white text (primary buttons); ≥ 4.5:1        |
| `--brand-grad`                                     | the mark only                                            |
| `--brand-soft` / `--brand-text`                    | selected / "ours" tint and its text                      |
| `--surface-hover`                                  | hover wash for rows, tabs, ghost buttons                 |
| `--lane-bg`                                        | board lanes                                              |

## Layout

| Class                                                                                 | When                                                                                     |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `.page` (`.page--wide`)                                                               | Root of any non-board route. Max 1280px, page gutter, 24px top.                          |
| `.page-header` > `.page-header__main` (`__title`, `__desc`) + `.page-header__actions` | Top of every page: an `h2` title (20px/800), one line of purpose, actions on the right.  |
| `.section` > `.section__header` (`__title`, `__desc`)                                 | A titled block inside a page ("Managed silos", "Members"). 32px apart.                   |
| `.section__header` > `.section__main` (`__title`, `__desc`) + `.section__actions`     | Title and its line of purpose stay together on the left; actions (and a `__note`) right. |
| `.section__count`, `.section__subtitle`, `.section__subhead`                          | A neutral count beside a title; a table's own heading inside a section (with a filter).  |
| `.form` (`__row`, `__actions`), `.field--grow`, `.fieldset`                           | A stacked form: fields 16px apart, at most 40rem wide; side-by-side fields in `__row`.   |
| `.disclosure` > `.disclosure__item` > `__summary` (button) + `__sub` / `__body`       | Rows that open in place (Departments): caret, name, tags, right-aligned count line.      |
| `.surface` (`.surface--pad`)                                                          | A quiet bordered box around a form or table. No shadow.                                  |
| `.toolbar` > `.toolbar__group` (`.toolbar__label`), `.toolbar__spacer`                | A wrapping row of filters/controls above a list or board.                                |
| `.toolbar.toolbar--form` > `.field` …, submit `.btn`                                  | A one-line form (Connect an agent, New department): labels above, controls aligned.      |

```html
<div class="page">
  <header class="page-header">
    <div class="page-header__main">
      <h2 class="page-header__title">Departments</h2>
      <p class="page-header__desc">
        Who works together. Each department owns a Space.
      </p>
    </div>
    <div class="page-header__actions">
      <button class="btn btn--primary">New department</button>
    </div>
  </header>
  <section class="section">…</section>
</div>
```

## Header context (Space / board)

`index.html` wraps the board picker in `.header-context`. A Space selector goes
**before** it, separated by a `.header-context__sep` (`/`). Each selector is a
`.context-select` button (`.context-select__label`, `.context-select__caret`)
with `aria-haspopup="listbox"` and `aria-expanded`; its popover is a `.menu`.
The board picker's trigger already carries both `board-menu__trigger` and the
`context-select` look. On phones the whole `.header-context` sits in the top row
between the mark and the actions.

## Controls

| Class                                                                                             | When                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `.btn`                                                                                            | Secondary action.                                                                                    |
| `.btn--primary` (alias `.btn.primary`)                                                            | The one obvious next step in a view. Brand fill, white text.                                         |
| `.btn--ghost`                                                                                     | Tertiary / cancel. No border until hover.                                                            |
| `.btn--danger` (alias `.btn.danger`)                                                              | The **confirming** step of a destructive flow (inside the dialog).                                   |
| `.btn--danger-text`                                                                               | A row-level destructive action that opens that confirm ("Remove", "Revoke").                         |
| `.btn--sm`, `.btn--icon`                                                                          | Dense rows; square icon buttons (give them `aria-label`).                                            |
| `.ghost-button`                                                                                   | Text-weight inline add ("+ Label", "+ Add link").                                                    |
| `.segmented` > `.segmented__item` (`.is-active` / `aria-pressed` / `aria-selected`)               | 2–4 mutually exclusive scopes or views ("Active / All").                                             |
| `.field` > `.field__label`, control, `.field__hint`, `.field__error`                              | Every form field: label above, hint/error below.                                                     |
| `input.input`, `select.select`, `textarea.input`                                                  | Full-width controls at the shared height.                                                            |
| `.menu` > `.menu__item` (`[aria-selected]`, `[data-active]`), `.menu__label`, `.menu__divider`    | Any floating list: dropdowns, pickers, autocomplete.                                                 |
| `.input-row`, `.input--mono`, `select.select--fit`                                                | A control and its button on one line ("token [Copy]"); mono values; a select as wide as its options. |
| `.check` (`--block` > `__text` > `__label`, `__hint`), `.check-group`                             | A checkbox with its label, inline or as a block with a hint line.                                    |
| `.combobox` > `input` + `.menu.combobox__menu` (`__option`, `__primary`, `__secondary`, `__note`) | An input with suggestions under it — the people picker (`views/people-picker.js`).                   |
| `.segmented--sm`                                                                                  | A role toggle inside a table row (Member / Admin).                                                   |

## Data

| Class                                                                                  | When                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.chip` (+ `--outline`, `--brand`, `--success`, `--warning`, `--danger`), `.chip__dot` | Small labels. Neutral by default; a tone only when it is state (role "admin" → `--brand`, "revoked" → `--danger`).                                                                                   |
| `.data-table`                                                                          | Rows of records: uppercase 11px header, hairline rows, hover wash.                                                                                                                                   |
| `.data-table--stack` (+ `data-label` on every `<td>`)                                  | Under 720px each row becomes a labelled block — no column is hidden, nothing scrolls sideways. Users and Agents use it.                                                                              |
| `.data-table__primary`, `.data-table__sub`, `td.data-table__actions`, `tr.is-muted`    | Two-line cells (name over email, board over id); a right-aligned action cell that drops left when stacked; a disabled row.                                                                           |
| `.chip-row`                                                                            | Several chips in one cell, wrapping.                                                                                                                                                                 |
| `.code-block` (`__head`)                                                               | Lines to copy (setup snippets): wraps instead of scrolling sideways; the head pairs a label with a Copy button.                                                                                      |
| `.issues-table`                                                                        | Issue rows (list, epic children): under 720px a row becomes title + one line of facts. Cells are `cell-id`, `cell-type`, `cell-title`, `cell-status`, `cell-assignee`, `cell-priority`, `cell-deps`. |
| `.type-badge--*`                                                                       | Issue type: a 7px coloured square + neutral word.                                                                                                                                                    |
| `.badge-select.badge--status/priority`                                                 | Inline status/priority editors. Fill only for in-progress/closed status and P0; P1 is coloured text; the rest are plain.                                                                             |

## Feedback

| Class                                                                         | When                                                                                                                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.empty-state` (`--center`) > `__title`, `__body`, `__action`                 | Something is missing: say what, and what to do about it.                                                                                                  |
| `.notice` (`--warning`, `--danger`)                                           | An inline message that needs reading (stale token, failed provision).                                                                                     |
| `.dialog` > `__header` (`__title`), `__body`, `__footer`                      | Native `<dialog>`. Footer right-aligned: `.btn--ghost` Cancel, then the primary/danger action.                                                            |
| `confirmDialog({ title, body, confirm, danger })` (`utils/confirm-dialog.js`) | The confirmation step of anything destructive or far-reaching: a `.dialog--confirm` naming the consequence, Cancel focused first. Never `window.confirm`. |
| `.notice.notice--warning.reveal`                                              | A one-time secret on screen (minted token): the warning, the value with Copy, setup lines, "Done — hide it".                                              |
| `.surface__footer`                                                            | A quiet row under a table ("Show all 73 people").                                                                                                         |
| `.spinner`                                                                    | Inline 14px "this section is refreshing".                                                                                                                 |

## Responsive breakpoints in use

- **1360px** — the board description beside the picker steps out of the header;
  with a Space selector (accounts mode) the header becomes two rows.
- **1180px** — header becomes two rows (mark · context · actions / tabs). The
  single row needs ~1150px; below that the picker used to collapse to a stray
  caret and the identity wrapped into a stack.
- **1100px** — detail view stacks the property rail under the content.
- **720px** — `.issues-table` and `.data-table--stack` stack their rows.
- **640px** — phone: wordmark hidden (mark stays), "New issue" becomes `+`,
  "Sign out" becomes an icon (name and action in its title), `--page-gutter`
  12px, tabs tighten.
