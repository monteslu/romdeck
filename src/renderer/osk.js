// On-screen keyboard — the component that makes text entry possible without a
// keyboard (PLAN §16e, decision 1: build ONE and reuse it everywhere).
//
// Three places need text with only a pad in hand: library search, cheat codes,
// and remote-play share codes. Each has a different alphabet, so the keyboard
// takes a layout rather than hardcoding QWERTY — a share code drawn from the
// base24 alphabet shouldn't offer letters that can't appear in one.
//
// It renders into the focus ring like any other surface, so navigation and
// activation come for free.
import { focus } from './focus.js';

const LAYOUTS = {
  // Full alphanumeric for search and free text.
  text: [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '-'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', ':', '.', "'"],
  ],
  // Cheat codes: hex plus the separators the common formats use.
  code: [
    ['0', '1', '2', '3', '4', '5', '6', '7'],
    ['8', '9', 'A', 'B', 'C', 'D', 'E', 'F'],
    ['-', ':', '+', ' '],
  ],
  // Share codes: exactly the base24 alphabet, nothing visually ambiguous.
  base24: [
    ['3', '4', '6', '7', '9', 'A'],
    ['C', 'D', 'E', 'F', 'G', 'H'],
    ['J', 'K', 'M', 'N', 'P', 'R'],
    ['T', 'U', 'V', 'W', 'X', 'Y'],
  ],
};

let el = null;
let session = null; // { target, onCommit, onCancel, group }

function build() {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'osk';
  el.className = 'hidden';
  el.innerHTML = `
    <div class="osk-panel">
      <div class="osk-title"></div>
      <div class="osk-preview"><span class="osk-value"></span><span class="osk-caret">|</span></div>
      <div class="osk-keys"></div>
      <div class="osk-actions"></div>
    </div>`;
  document.body.appendChild(el);
  return el;
}

/**
 * Open the keyboard against an input element.
 * @param {HTMLInputElement} target the field being edited
 * @param {object} opts
 * @param {'text'|'code'|'base24'} opts.layout which alphabet to offer
 * @param {string} opts.title what the user is typing
 * @param {(value:string)=>void} opts.onCommit
 * @param {(value:string)=>void} opts.onInput live updates (search-as-you-type)
 */
export function openKeyboard(target, {
  layout = 'text', title = 'Enter text', onCommit = null, onInput = null,
} = {}) {
  build();
  const rows = LAYOUTS[layout] ?? LAYOUTS.text;
  let value = target?.value ?? '';

  el.querySelector('.osk-title').textContent = title;
  const valueEl = el.querySelector('.osk-value');
  const paint = () => {
    valueEl.textContent = value;
    if (target) {
      target.value = value;
      // Let existing input handlers (formatting, filtering) run unchanged.
      target.dispatchEvent(new Event('input', { bubbles: true }));
      value = target.value; // honour whatever the handler normalised it to
      valueEl.textContent = value;
    }
    onInput?.(value);
  };

  const keys = el.querySelector('.osk-keys');
  keys.replaceChildren();
  const keyEls = [];
  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'osk-row';
    for (const ch of row) {
      const b = document.createElement('button');
      b.className = 'osk-key';
      b.textContent = ch === ' ' ? '␣' : ch;
      b.onclick = () => { value += ch; paint(); };
      rowEl.appendChild(b);
      keyEls.push(b);
    }
    keys.appendChild(rowEl);
  }

  const actions = el.querySelector('.osk-actions');
  actions.replaceChildren();
  const actionEls = [];
  const mkAction = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    actions.appendChild(b);
    actionEls.push(b);
    return b;
  };
  mkAction('⌫ Delete', () => { value = value.slice(0, -1); paint(); });
  mkAction('Clear', () => { value = ''; paint(); });
  if (layout === 'text') mkAction('␣ Space', () => { value += ' '; paint(); });
  mkAction('✓ Done', () => { close(); onCommit?.(value); }, 'primary');
  mkAction('Cancel', () => { close(); }, '');

  el.classList.remove('hidden');
  paint();

  focus.group('osk', { onBack: () => close() });
  for (const b of [...keyEls, ...actionEls]) focus.register('osk', b);
  focus.push('osk');
  session = { target, onCommit };
}

export function close() {
  if (!el) return;
  el.classList.add('hidden');
  if (focus.activeName() === 'osk') focus.pop();
  session = null;
}

export function isOpen() {
  return !!session;
}
