// In-view menus — ES's answer to "how do I configure this from a couch"
// (PLAN §16e Phase 2).
//
// EmulationStation opens a menu with a button and everything lives inside it.
// romdeck had the opposite shape: every feature hung off a toolbar button or a
// modal that assumed a pointer. These menus are the pad-side entry to the same
// features, rendered on the same stage as the themed view.
//
// Layout is first-party and fixed, consuming theme TOKENS rather than being
// theme-defined (§16e decision 2). ES-DE's own menus aren't theme-described
// either, and this avoids blocking Phase 2 on inventing theme XML for menus.
import { focus } from './focus.js';

let root = null;
const stack = []; // open menus, innermost last

function build() {
  if (root) return root;
  root = document.createElement('div');
  root.id = 'menu-layer';
  root.className = 'hidden';
  document.body.appendChild(root);
  return root;
}

/**
 * Open a menu panel.
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} [spec.subtitle]
 * @param {Array<{label:string, hint?:string, action?:Function, disabled?:boolean}>} spec.items
 * @param {Function} [spec.onClose]
 */
export function openMenu({ title, subtitle = '', items = [], onClose = null }) {
  build();
  root.classList.remove('hidden');

  const panel = document.createElement('div');
  panel.className = 'menu-panel';
  panel.style.zIndex = String(50 + stack.length);

  const head = document.createElement('div');
  head.className = 'menu-head';
  const h = document.createElement('div');
  h.className = 'menu-title';
  h.textContent = title;
  head.appendChild(h);
  if (subtitle) {
    const s = document.createElement('div');
    s.className = 'menu-sub';
    s.textContent = subtitle;
    head.appendChild(s);
  }
  panel.appendChild(head);

  const list = document.createElement('div');
  list.className = 'menu-items';
  const groupName = `menu${stack.length}`;
  const buttons = [];

  for (const item of items) {
    const b = document.createElement('button');
    b.className = 'menu-item' + (item.disabled ? ' disabled' : '');
    const label = document.createElement('span');
    label.className = 'mi-label';
    label.textContent = item.label;
    b.appendChild(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'mi-hint';
      hint.textContent = item.hint;
      b.appendChild(hint);
    }
    if (!item.disabled) {
      b.onclick = () => item.action?.();
      buttons.push(b);
    }
    list.appendChild(b);
  }
  panel.appendChild(list);

  // A menu whose entries are all disabled (an empty save-state list, say)
  // would have an empty ring and no way out except `back`. Give it an
  // explicit Back entry so it is never a dead end.
  if (!buttons.length) {
    const b = document.createElement('button');
    b.className = 'menu-item';
    const label = document.createElement('span');
    label.className = 'mi-label';
    label.textContent = 'Back';
    b.appendChild(label);
    b.onclick = () => closeMenu();
    list.appendChild(b);
    buttons.push(b);
  }

  const foot = document.createElement('div');
  foot.className = 'menu-foot';
  foot.textContent = 'Ⓐ select      Ⓑ back';
  panel.appendChild(foot);

  root.appendChild(panel);

  const entry = { panel, groupName, onClose };
  stack.push(entry);

  focus.group(groupName, { onBack: () => closeMenu() });
  for (const b of buttons) focus.register(groupName, b);
  focus.push(groupName);
  return entry;
}

/** Close the innermost menu (or all of them). */
export function closeMenu({ all = false } = {}) {
  const entry = stack.pop();
  if (!entry) return false;
  entry.panel.remove();
  if (focus.activeName() === entry.groupName) focus.pop();
  // Menus are built fresh each time they open; leaving the group registered
  // would strand an empty ring behind and misreport the app's reachability.
  focus.groups.delete(entry.groupName);
  entry.onClose?.();
  if (all) {
    while (stack.length) closeMenu();
  }
  if (!stack.length && root) root.classList.add('hidden');
  return true;
}

export function closeAllMenus() {
  while (stack.length) closeMenu();
}

export function menuOpen() {
  return stack.length > 0;
}

export function menuDepth() {
  return stack.length;
}
