/* FormForge — DOM primitives.
 *
 * How to make a change the page believes in: a click a framework handler sees,
 * text a controlled input keeps, a wait that ends when the page is ready.
 * Nothing here knows what a form, a widget or a library is.
 */
(function () {
  'use strict';

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function visible(el) {
    if (!el || !el.getClientRects) return false;
    if (el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
  }

  function textOf(el) {
    return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  // Lower-case ASCII letters and digits only, for fuzzy comparison.
  function norm(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  // Option texts that mean "nothing chosen" and must never be picked.
  const PLACEHOLDER = /^(|-+|—|–|\.\.\.|select|select\.\.\.|choose|choose\.\.\.|please\s*select|none|n\/?a|bitte\s*w(ä|ae)hlen|ausw(ä|ae)hlen|keine?|auswahl)$/i;

  // The whole pointer sequence: libraries variously open on pointerdown, mousedown or click.
  function press(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: Math.round(r.left + Math.min(r.width / 2, 40)),
      clientY: Math.round(r.top + r.height / 2),
      button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'mouse'
    };
    try { el.dispatchEvent(new PointerEvent('pointerover', o)); } catch (_) {}
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', o));
    if (el.focus) { try { el.focus({ preventScroll: true }); } catch (_) {} }
    try { el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o, { buttons: 0 }))); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, o, { buttons: 0 })));
    el.dispatchEvent(new MouseEvent('click', Object.assign({}, o, { buttons: 0 })));
  }

  function key(el, k, code) {
    const o = { key: k, code: code || k, bubbles: true, cancelable: true, composed: true };
    const target = el || document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', o));
    target.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  function setNativeValue(el, value) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  /* Type into a framework-controlled input. execCommand('insertText') produces
   * real beforeinput/input events, which Vue/React/Quill models accept; a bare
   * `.value =` is reverted by the next render. Falls back to the native setter.
   *
   * execCommand writes wherever the caret is, not into the element passed in,
   * so it only runs once focus has actually landed on `el`. */
  function typeInto(el, text) {
    if (!el) return null;
    try { el.focus({ preventScroll: true }); } catch (_) { }
    const focused = document.activeElement === el;
    const str = String(text);

    if (!('value' in el) && el.isContentEditable) {
      try {
        const r = document.createRange();
        r.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
      } catch (_) { }
      // Markup goes in as markup, or the editor shows the tags literally.
      const html = /^\s*<[a-z][\s\S]*>\s*$/i.test(str);
      let done = false;
      try {
        done = focused && document.execCommand(html ? 'insertHTML' : 'insertText', false, str);
      } catch (_) { done = false; }
      if (!done) {
        if (html) el.innerHTML = str; else el.textContent = str;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: str, inputType: 'insertText' }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return (el.innerText || el.textContent || '').trim();
    }

    try {
      el.setSelectionRange ? el.setSelectionRange(0, el.value.length) : el.select && el.select();
    } catch (_) { }
    let ok = false;
    try { ok = focused && document.execCommand('insertText', false, str); } catch (_) { ok = false; }
    if (!ok || el.value !== str) {
      setNativeValue(el, str);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: str, inputType: 'insertText' }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  }

  // Poll a condition instead of sleeping for a fixed time; most waits then cost one tick.
  async function settle(check, max = 250, step = 25) {
    const until = Date.now() + max;
    for (;;) {
      let ok = false;
      try { ok = !!check(); } catch (_) { ok = false; }
      if (ok) return true;
      if (Date.now() >= until) return false;
      await sleep(step);
    }
  }

  async function waitFor(fn, timeout = 1500, step = 25) {
    const until = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > until) return null;
      await sleep(step);
    }
  }

  function safeQuery(root, sel) {
    try { return Array.from(root.querySelectorAll(sel)); } catch (_) { return []; }
  }

  /* Commit a typed value the way a blur does. Controlled components parse and
   * write back on focusout, so a value typed without one is reverted by the
   * next render. Kept separate from typeInto: an autocomplete must stay focused
   * while its suggestions arrive. */
  function commit(el) {
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) { }
    try { el.blur(); } catch (_) { }
    try {
      el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    } catch (_) { }
  }

  /* Diagnostics about the page, collected rather than logged: a console.warn
   * from a content script lands in the extension's error list and reads as a
   * crash. run() drains these into the fill result for the Debug tab. */
  const notes = [];
  function note(msg) {
    if (notes.length < 40) notes.push(String(msg).slice(0, 220));
  }
  function takeNotes() {
    return notes.splice(0, notes.length);
  }

  globalThis.FormForgeDom = {
    note, takeNotes,
    sleep, visible, textOf, norm, press, key, setNativeValue, typeInto,
    commit, settle, waitFor, safeQuery, PLACEHOLDER
  };
})();
