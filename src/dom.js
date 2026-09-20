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

    // A few embedded engines ship no PointerEvent; the mouse half still works there.
    const Pointer = globalThis.PointerEvent || MouseEvent;

    /* The whole pointer sequence: libraries variously open on pointerdown,
     * mousedown or click, and a component listening for the pointer pair
     * ignores a bare click. */
    function press(el) {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const at = {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: Math.round(r.left + Math.min(r.width / 2, 40)),
            clientY: Math.round(r.top + r.height / 2),
            button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'mouse'
        };
        const up = Object.assign({}, at, {buttons: 0});
        const send = (Kind, type, init) => {
            try {
                el.dispatchEvent(new Kind(type, init));
            } catch (_) { /* the engine has no such event; the rest of the sequence stands */
            }
        };

        send(Pointer, 'pointerover', at);
        send(Pointer, 'pointerdown', at);
        send(MouseEvent, 'mousedown', at);
        try {
            el.focus({preventScroll: true});
        } catch (_) { /* not focusable */
        }
        send(Pointer, 'pointerup', up);
        send(MouseEvent, 'mouseup', up);
        send(MouseEvent, 'click', up);
    }

    function key(el, k, code) {
        const o = {key: k, code: code || k, bubbles: true, cancelable: true, composed: true};
        const target = el || document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', o));
        target.dispatchEvent(new KeyboardEvent('keyup', o));
    }

    /* A form control is one whose prototype defines a value setter — the setter
     * React and Vue listen behind. Everything else that takes text is a
     * contenteditable host, and has no value of its own. */
    function valueSetter(el) {
        for (let p = Object.getPrototypeOf(el); p; p = Object.getPrototypeOf(p)) {
            const d = Object.getOwnPropertyDescriptor(p, 'value');
            if (d && d.set) return d.set;
        }
        return null;
    }

    // Returns false when there was no value to set; giving a <div> one hides what it is.
    function setNativeValue(el, value) {
        const set = valueSetter(el);
        if (!set) return false;
        set.call(el, value);
        return true;
    }

    // The words of a fragment of markup, for an editor that would not take the markup.
    const plainText = (html) => String(html)
        .replace(/<\/(p|li|div|h[1-6]|tr)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    /* Markup's own door into an editor. An editor converts what is pasted into
     * the model it keeps and polices anything else: Quill renders a bullet list
     * as `<ol><li data-list="bullet">`, so a `<ul>` written straight into the DOM
     * was a shape it could not name and it deleted the lot on its next pass —
     * measured at 7ms, one tick after the filler had read the field back as
     * full. Pasted, the same list arrives as the editor's own bullets.
     *
     * A handler that took the paste called preventDefault; nothing handled it
     * means a plain contenteditable, which the caller writes to directly. */
    function pasteInto(el, str) {
        try {
            const data = new DataTransfer();
            data.setData('text/html', str);
            data.setData('text/plain', plainText(str));
            return !el.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: data
            }));
        } catch (_) {
            return false;
        }
    }

    /* Type into a framework-controlled input. execCommand('insertText') produces
     * real beforeinput/input events, which Vue/React/Quill models accept; a bare
     * `.value =` is reverted by the next render. Falls back to the native setter.
     *
     * execCommand writes wherever the caret is, not into the element passed in,
     * so it only runs once focus has actually landed on `el`.
     *
     * Which branch to take is decided by what the element *is*. Asking whether it
     * has a `value` property instead was self-poisoning: the control branch used
     * to invent one on whatever it was handed, so a rich-text editor written to
     * once while the form had it switched off became a "form control" for the
     * rest of the page's life — and every later write put its markup in as
     * visible tags, appended rather than replaced. */
    function typeInto(el, text) {
        if (!el) return null;
        try {
            el.focus({preventScroll: true});
        } catch (_) {
        }
        const focused = document.activeElement === el;
        const str = String(text);

        if (!valueSetter(el)) {
            // A host the page has switched off takes nothing, and saying otherwise
            // would report a field as filled that is visibly empty.
            if (!el.isContentEditable) return null;
            try {
                const r = document.createRange();
                r.selectNodeContents(el);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(r);
            } catch (_) {
            }
            // Markup goes in as markup, or the editor shows the tags literally.
            const html = /^\s*<[a-z][\s\S]*>\s*$/i.test(str);
            let done = html && pasteInto(el, str);
            try {
                done = done || (focused && document.execCommand(html ? 'insertHTML' : 'insertText', false, str));
            } catch (_) {
            }
            if (!done) {
                if (html) el.innerHTML = str; else el.textContent = str;
                el.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    composed: true,
                    data: str,
                    inputType: 'insertText'
                }));
            }
            el.dispatchEvent(new Event('change', {bubbles: true}));
            return (el.innerText || el.textContent || '').trim();
        }

        try {
            el.setSelectionRange ? el.setSelectionRange(0, el.value.length) : el.select && el.select();
        } catch (_) {
        }
        let ok = false;
        try {
            ok = focused && document.execCommand('insertText', false, str);
        } catch (_) {
            ok = false;
        }
        if (!ok || el.value !== str) {
            setNativeValue(el, str);
            el.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                composed: true,
                data: str,
                inputType: 'insertText'
            }));
        }
        el.dispatchEvent(new Event('change', {bubbles: true}));
        return el.value;
    }

    /* Writing into an editor and finding out what it kept. The editor's own pass
     * runs after the write rather than during it, so the value is read on the
     * far side of it: reading in the same tick reported a field as filled that
     * the editor had emptied a moment later. An editor that kept nothing is
     * given the words without the markup, which every editor keeps. */
    /* Words with no markup of their own, given a shape an editor can hold. A
     * model answers a rich-text field in prose, and prose inserted at a caret
     * takes the formatting it lands on: dropped over content that opened with
     * <strong>, an entire release note came out bold. Paragraphs replace the
     * selection instead of typing into it, so nothing is inherited. */
    const asParagraphs = (str) => str.split(/\n{2,}|\r?\n/).map(s => s.trim()).filter(Boolean)
        .map(s => `<p>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
        .join('') || '<p></p>';

    async function typeIntoRich(el, text) {
        const plain = String(text);
        const str = /<[a-z]/i.test(plain) ? plain : asParagraphs(plain);
        typeInto(el, str);
        await sleep(0);                                  // the editor's turn, not a wait for a duration
        const held = () => (el.innerText || el.textContent || '').trim();
        if (held()) return held();
        typeInto(el, plainText(str));
        await sleep(0);
        return held() || null;
    }

    /* Emptying an editor through the door it converts, not the one it polices.
     * `textContent = ''` edits the DOM an editor is showing, not the model it
     * keeps, and Quill puts its own content straight back on the next tick — so
     * Clear reported five editors emptied and five editors still held their
     * text. A selection and a delete produce the beforeinput/input the editor
     * is listening for. */
    async function clearRich(el) {
        if (!el || !el.isContentEditable) return false;
        try {
            el.focus({preventScroll: true});
            const r = document.createRange();
            r.selectNodeContents(el);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
        } catch (_) { /* no selection to make; the fallback below still runs */
        }
        let done = false;
        try {
            done = document.activeElement === el && document.execCommand('delete', false, undefined);
        } catch (_) {
        }
        await sleep(0);
        const held = () => (el.innerText || el.textContent || '').trim();
        if (held()) {
            el.innerHTML = '';
            el.dispatchEvent(new InputEvent('input', {bubbles: true, composed: true, inputType: 'deleteByCut'}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            await sleep(0);
        }
        return done || !held();
    }

    // Poll a condition instead of sleeping for a fixed time; most waits then cost one tick.
    async function settle(check, max = 250, step = 25) {
        const until = Date.now() + max;
        for (; ;) {
            let ok = false;
            try {
                ok = !!check();
            } catch (_) {
                ok = false;
            }
            if (ok) return true;
            if (Date.now() >= until) return false;
            await sleep(step);
        }
    }

    async function waitFor(fn, timeout = 1500, step = 25) {
        const until = Date.now() + timeout;
        for (; ;) {
            const v = fn();
            if (v) return v;
            if (Date.now() > until) return null;
            await sleep(step);
        }
    }

    function safeQuery(root, sel) {
        try {
            return Array.from(root.querySelectorAll(sel));
        } catch (_) {
            return [];
        }
    }

    /* Commit a typed value the way a blur does. Controlled components parse and
     * write back on focusout, so a value typed without one is reverted by the
     * next render. Kept separate from typeInto: an autocomplete must stay focused
     * while its suggestions arrive. */
    function commit(el) {
        try {
            el.dispatchEvent(new Event('change', {bubbles: true}));
        } catch (_) {
        }
        try {
            el.blur();
        } catch (_) {
        }
        try {
            el.dispatchEvent(new FocusEvent('blur', {bubbles: false}));
            el.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
        } catch (_) {
        }
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

    /* Where to click, and whether to press Escape, when a control's popup must
     * go: inside a modal dialog both would close the dialog itself, so the click
     * lands on the dialog's own header and Escape is never sent. */
    const dialogOf = (el) => (el && el.closest ? el.closest('[role="dialog"], dialog, .p-dialog') : null);
    const neutralSpot = (el) => {
        const dlg = dialogOf(el);
        return dlg ? (dlg.querySelector('[class*="header"], [class*="title"], h1, h2, h3') || dlg) : document.body;
    };

    globalThis.FormForgeDom = {
        note, takeNotes, dialogOf, neutralSpot,
        sleep, visible, textOf, norm, press, key, setNativeValue, typeInto, typeIntoRich, clearRich, plainText,
        commit, settle, waitFor, safeQuery, PLACEHOLDER
    };
})();
