// The handful of DOM chores every other module needs: the three roots the page
// hands us, escaping, a shorter querySelector, toasts and the modal.
//
// This module imports nothing of ours. Everything else may import it.

export const app = document.getElementById('app')!;
export const modalEl = document.getElementById('modal')!;
export const toastEl = document.getElementById('toasts')!;

export const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
// querySelector, narrowed. Nearly every call reads back markup this client
// wrote a line earlier, so the element is guaranteed by construction. The few
// places that genuinely may miss — a host-only button, the modal's advance
// button — still check the result before using it.
export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T =>
  root.querySelector(sel) as T;
export const cssEsc = (s: string): string => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

export function toast(msg: string, kind = ''): void {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg;
  toastEl.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, 2600);
}

export function closeModal(): void { modalEl.hidden = true; modalEl.innerHTML = ''; }

export function openModal(html: string, wire?: () => void): void {
  modalEl.innerHTML = html; modalEl.hidden = false;
  modalEl.querySelectorAll<HTMLElement>('[data-close]').forEach((b) => { b.onclick = closeModal; });
  if (wire) wire();
}

modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
