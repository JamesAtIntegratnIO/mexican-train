// The handful of DOM chores every other module needs: the three roots the page
// hands us, escaping, a shorter querySelector, toasts and the modal.
//
// This module imports nothing of ours. Everything else may import it.

export const app = document.getElementById('app');
export const modalEl = document.getElementById('modal');
export const toastEl = document.getElementById('toasts');

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg;
  toastEl.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, 2600);
}

export function closeModal() { modalEl.hidden = true; modalEl.innerHTML = ''; }

export function openModal(html, wire) {
  modalEl.innerHTML = html; modalEl.hidden = false;
  modalEl.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeModal; });
  if (wire) wire();
}

modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
