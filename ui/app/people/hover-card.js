/* Standalone person card. No private directory, package or network access. */
import './hover-card.css';
let card = null;
export function open({ anchor, person, onRequestClose }) {
  close();
  const el = document.createElement('div');
  el.className = 'exo-ux-hover-card'; // compatibility with existing hover controller
  el.setAttribute('role', 'tooltip');
  el.style.cssText = 'position:fixed;z-index:10000;padding:12px 16px;border-radius:8px;background:var(--color-surface,#fff);color:var(--color-text,#222);border:1px solid #aaa;box-shadow:0 4px 16px #0003';
  const name = document.createElement('strong');
  name.textContent = person.display_name || person.actor;
  el.appendChild(name);
  if (person.email) {
    const email = document.createElement('div');
    email.textContent = person.email;
    el.appendChild(email);
  }
  const rect = anchor.getBoundingClientRect();
  el.style.left = `${Math.max(0, rect.left)}px`;
  el.style.top = `${Math.max(0, rect.bottom + 6)}px`;
  document.body.appendChild(el);
  card = el;
  el.addEventListener('pointerleave', () => onRequestClose?.());
}
export function close() { card?.remove(); card = null; }
export function isOpen() { return card !== null; }
