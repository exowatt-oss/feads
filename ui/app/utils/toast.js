/**
 * Show a transient global toast message anchored to the viewport.
 *
 * Colors come from the design tokens (see styles.css) so toasts follow the
 * theme; layout stays inline so a toast renders even before styles load.
 *
 * @param {string} text - Message text.
 * @param {'info'|'success'|'error'} [variant] - Visual variant.
 * @param {number} [duration_ms] - Auto-dismiss delay in milliseconds.
 */
export function showToast(text, variant = 'info', duration_ms = 2800) {
  const el = document.createElement('div');
  el.className = `toast toast--${variant}`;
  el.textContent = text;
  el.style.position = 'fixed';
  el.style.right = '14px';
  el.style.bottom = '14px';
  el.style.zIndex = '1000';
  el.style.color = '#fff';
  el.style.padding = '8px 12px';
  el.style.borderRadius = '8px';
  el.style.fontSize = '12px';
  if (variant === 'success') {
    el.style.background = 'var(--status-success, #156d36)';
  } else if (variant === 'error') {
    el.style.background = 'var(--status-danger, #9f2011)';
  } else {
    el.style.background = 'rgba(0,0,0,0.85)';
  }
  (document.body || document.documentElement).appendChild(el);
  setTimeout(() => {
    try {
      el.remove();
    } catch {
      /* ignore */
    }
  }, duration_ms);
}
