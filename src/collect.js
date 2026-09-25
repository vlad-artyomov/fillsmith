/* Reading the page: what is a field, what it is called, what it already holds.
 *
 * Everything here answers a question about the document and changes nothing in
 * it, which is why it is its own file — content.js was 1675 lines and this was
 * the third of them that never touched the fill. It reaches the widget layer
 * for the controls a library draws and the overlay layer for the panels they
 * teleport; it knows nothing about personas, seeds or the model.
 */
(function () {
    'use strict';

    const W = globalThis.FillsmithWidgets;
    const O = globalThis.FillsmithOverlays;
    const H = W.helpers;

    /* A library's editor and a bare contenteditable are the same field to a
     * tester: both take markup, and both are worth a length the prompt states. */
    const RICH_KINDS = new Set(['richtext', 'contenteditable']);
    const MARK = 'data-fillsmith-id';
    const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
    const INLINE_OPTIONS = new Set(['inline-choice', 'radio-group']);
    const CAPTCHA = /\b(captcha|recaptcha|hcaptcha|turnstile|otp|one-?time|2fa|mfa|verification\s*code|sicherheitscode)\b/i;
    const APP_CHROME = /locale\s*switcher|switch\s+language|change\s+language|language\s+switcher|sprache\s+(wechseln|ändern)|theme\s+switcher/i;

    // ------------------------------------------------------------ discovery ----
    // Visible itself, or a visually-hidden native input inside a visible wrapper (styled checkboxes, switches).
    function isVisible(el) {
        if (!el) return false;
        if (el.disabled || el.readOnly) return false;
        if (H.visible(el)) return true;
        const type = (el.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio' || el.tagName === 'INPUT') {
            const wrap = el.closest('label, span, div');
            if (wrap && wrap !== el && H.visible(wrap) && wrap.getBoundingClientRect().width > 4) return true;
        }
        return false;
    }

    function textOf(node) {
        if (!node) return '';
        return (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    }

    // Every scrap of naming a rule could match on, joined with " | ": label, aria, placeholder, name, id.
    function describe(el) {
        const bits = [];
        if (el.labels && el.labels.length) bits.push(textOf(el.labels[0]));
        if (el.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lbl) bits.push(textOf(lbl));
        }
        const wrap = el.closest('label');
        if (wrap) bits.push(textOf(wrap));
        if (el.getAttribute('aria-label')) bits.push(el.getAttribute('aria-label'));
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
            labelledBy.split(/\s+/).forEach(id => {
                const n = document.getElementById(id);
                if (n) bits.push(textOf(n));
            });
        }
        ['placeholder', 'name', 'id', 'autocomplete', 'title'].forEach(a => {
            const v = el.getAttribute(a);
            if (a === 'autocomplete' && /^(off|on|nope|false|none)$/i.test(v || '')) return;
            if (v) bits.push(v.replace(/[_\-.\[\]]+/g, ' '));
        });
        if (bits.filter(Boolean).length < 2) {
            let prev = el.previousElementSibling;
            for (let hops = 0; prev && hops < 3; hops++, prev = prev.previousElementSibling) {
                const t = textOf(prev);
                if (t && t.length < 80) {
                    bits.push(t);
                    break;
                }
            }
        }
        return bits.filter(Boolean).join(' | ');
    }

    // Required by attribute, or by an asterisk in any caption-shaped fragment of the label.
    function looksRequired(el, label) {
        if (el.matches && el.matches('[required], [aria-required="true"]')) return true;
        if (el.querySelector && el.querySelector('[required], [aria-required="true"]')) return true;
        return String(label || '').split('|').some(bit =>
            bit.includes('*') && (bit.match(/\p{L}/gu) || []).length >= 2);
    }

    // What the control says it accepts; for a widget these live on the input it wraps.
    function limitsOf(el) {
        if (!el) return {
            placeholder: '',
            maxLength: null,
            pattern: null,
            min: null,
            max: null,
            step: null,
            autocomplete: ''
        };
        const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
        return {
            placeholder: el.getAttribute('placeholder') || '',
            maxLength: el.maxLength > 0 ? el.maxLength : null,
            pattern: el.getAttribute('pattern') || null,
            min: num(el.getAttribute('min')),
            max: num(el.getAttribute('max')),
            step: num(el.getAttribute('step')),
            autocomplete: el.getAttribute('autocomplete') || ''
        };
    }

    // The nearest heading *above* the field, not the first one in its container.
    function sectionOf(el) {
        const HEADINGS = 'legend, h1, h2, h3, h4, h5, [role="heading"]';
        const BOXES = 'fieldset, section, form, [role="group"], [role="dialog"]';
        for (let box = el.closest(BOXES); box; box = box.parentElement && box.parentElement.closest(BOXES)) {
            const above = Array.from(box.querySelectorAll(HEADINGS)).filter(h =>
                !h.contains(el) && (el.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING));
            if (above.length) return textOf(above[above.length - 1]);
        }
        return '';
    }

    function inDomOrder(fields) {
        return fields.sort((a, b) => {
            const p = a.el.compareDocumentPosition(b.el);
            if (p & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (p & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        });
    }

    /* A control's own popup is not part of the form: a dropdown's search box or
     * a date panel's month select exist to drive the widget. A popup is told from
     * an accordion or a tab panel (which are full of real fields) by two plain
     * ARIA facts: it floats, and a control names it through aria-controls. A
     * modal dialog is a form container, not a popup. */
    function popupSurfaces() {
        const roots = [];
        const add = (el) => {
            if (el && el !== document.body && !roots.includes(el)) roots.push(el);
        };
        const floats = (el) => /^(absolute|fixed)$/.test(getComputedStyle(el).position);
        const floatingRoot = (el) => {
            let out = null;
            for (let n = el; n && n !== document.body; n = n.parentElement) if (floats(n)) out = n;
            return out;
        };

        for (const el of document.querySelectorAll('[data-fillsmith-overlay], [data-fillsmith-opened]')) add(el);
        for (const el of document.querySelectorAll(O.GENERIC_OVERLAYS)) {
            if (!el.matches('[role="dialog"]')) add(el);
        }
        const LIST = '[role="listbox"], [role="menu"], [role="tree"], [role="grid"], [role="dialog"]';
        for (const owner of document.querySelectorAll('[aria-controls], [aria-owns]')) {
            const ids = ((owner.getAttribute('aria-controls') || '') + ' ' + (owner.getAttribute('aria-owns') || '')).trim().split(/\s+/);
            for (const id of ids) {
                const target = id && document.getElementById(id);
                if (!target || target.contains(owner)) continue;
                if (!target.matches(LIST) && !target.querySelector(LIST)) continue;
                const root = floatingRoot(target);
                if (!root || root.matches('[role="dialog"]') || root.querySelector('[role="dialog"]')) continue;
                add(root);
            }
        }
        return roots;
    }

    /* A modal dialog is the whole form while it is up. What lies under its mask
     * the tester cannot reach either, and closing the dialog to get there throws
     * away the one thing they opened it for. */
    function modalScope() {
        const modal = (d) => {
            if (d.getAttribute('aria-modal') === 'true') return true;
            try {
                return d.matches(':modal');
            } catch (_) {
                return false;
            }
        };
        const open = Array.from(document.querySelectorAll('[role="dialog"], dialog[open]')).filter(d => isVisible(d) && modal(d));
        return open.length ? open[open.length - 1] : null;
    }

    function collectFields(opts) {
        let fields = [];
        const popups = popupSurfaces();
        const scope = modalScope();
        const inPopup = (el) => popups.some(p => p.contains(el)) || (scope && !scope.contains(el));

        // 1. Component-library widgets, and the native inputs they own.
        const widgets = W.detect(document);
        const claimed = new Set();
        for (const w of widgets) W.claimed(w).forEach(el => claimed.add(el));

        for (const w of widgets) {
            if (inPopup(w.root)) continue;
            const label = W.labelFor(w, describe);
            if (CAPTCHA.test(label) || APP_CHROME.test(label)) continue;
            const shown = W.displayedValue(w);
            const filled = shown && !H.PLACEHOLDER.test(shown);
            const keepsItsValue = filled && !opts.overwrite && w.kind !== 'bool';
            const f = {
                keepsItsValue,
                kind: 'widget', widget: w, el: w.root, type: w.kind, lib: w.id,
                label, section: sectionOf(w.root),
                required: looksRequired(w.root, label),
                ...limitsOf(w.root.querySelector('input, textarea'))
            };
            /* A control whose choices are already on screen can say what they are.
             * Only native <select> and radio used to, so every component-library
             * list reached the model blind — and blind it invents: "Standard" for
             * a Yes/No radio group, "Office" for a list holding "Branch". The
             * filler then threw the invention away and picked a valid option
             * itself, which is the whole answer wasted. */
            if (INLINE_OPTIONS.has(w.kind)) {
                const seen = O.asTexts(O.optionsIn(w.root, w.lib))
                    .filter(o => o.text).slice(0, 40);
                if (seen.length) f.options = seen.map(o => ({value: o.value, text: o.text.slice(0, 60)}));
            }
            fields.push(f);
        }

        // 2. Plain native controls.
        const nodes = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
        const seenRadioGroups = new Set();
        for (const el of nodes) {
            if (claimed.has(el) || inPopup(el)) continue;
            const tag = el.tagName.toLowerCase();
            const type = tag === 'input' ? (el.type || 'text').toLowerCase()
                : tag === 'textarea' ? 'textarea'
                    : tag === 'select' ? 'select' : 'contenteditable';
            if (SKIP_TYPES.has(type) || !isVisible(el)) continue;

            const label = describe(el);
            if (CAPTCHA.test(label) || APP_CHROME.test(label)) continue;

            if (type === 'radio') {
                const key = el.name || label;
                if (seenRadioGroups.has(key)) continue;
                seenRadioGroups.add(key);
            }

            const hasValue = type === 'checkbox' || type === 'radio' ? el.checked
                : type === 'file' ? !!(el.files && el.files.length)
                    : type === 'contenteditable' ? !!textOf(el) : !!el.value;
            const keepsItsValue = hasValue && !opts.overwrite;

            const f = {
                keepsItsValue,
                kind: 'native', el, tag, type, label, section: sectionOf(el),
                required: el.required || looksRequired(el, label),
                ...limitsOf(el)
            };
            if (type === 'select') {
                /* The first option is the control's prompt, not a choice, when it
                 * carries a sentinel value: "(Select Card Type)", "Month", "Year"
                 * are all value="0" beside real options, and a seeded pick that
                 * lands on one writes the empty state as if it were data. Judged
                 * by the page's own convention rather than by reading the caption,
                 * which is a different word in every language — and only on a list
                 * long enough to need a prompt, so a three-row yes/no keeps every
                 * answer it has. */
                const SENTINEL = new Set(['', '0', '-1', 'none', 'null']);
                const prompting = el.options.length >= 4;
                f.options = Array.from(el.options)
                    .filter(o => o.value !== '' && !o.disabled)
                    .filter(o => !(prompting && o.index === 0 && SENTINEL.has(String(o.value).trim().toLowerCase())))
                    /* Every option, not the first forty. A country list is 250 long
                     * and the one wanted is rarely in its opening stretch: truncated,
                     * the match missed and the pick that followed it came out of the
                     * A's and B's, so a US persona lived in Aruba or Belize. */
                    .map(o => ({value: o.value, text: textOf(o).slice(0, 60)}));
            }
            if (type === 'radio') {
                const group = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name || '')}"]`)).filter(isVisible);
                f.group = group;
                f.options = group.map(g => ({value: g.value, text: describe(g).slice(0, 60)}));
            }
            fields.push(f);
        }

        // DOM order: dependent dropdowns (country → region) need the parent committed first.
        inDomOrder(fields);
        /* Rows a page renders one per item — an uploaded file's alt text, its
         * source, its "show this one" switch — carry no name and no id, and the
         * same caption as the row above. Their label key is therefore the same
         * key, and four rows read as one field: the second gets the first one's
         * value back as though a re-render had eaten it, and a later one is
         * passed over as already written. Number them in DOM order. The first of
         * a group keeps the bare key, so nothing that was unique before moves. */
        const nth = new Map();
        for (const f of fields) {
            const base = baseKey(f);
            if (base.charCodeAt(0) !== 108) continue;          // 'l:', the label-derived key
            const n = (nth.get(base) || 0) + 1;
            nth.set(base, n);
            if (n > 1) f.nth = n;
        }
        /* Numbered over every such row on the page, including the ones this pass
         * is not going to write. A later pass collects only what is still empty,
         * so counting the collected fields alone gave the third row the first
         * row's number — and with it the first row's value. */
        fields = fields.filter(f => !f.keepsItsValue);
        fields.forEach((f, i) => {
            f.idx = i;
            try {
                f.el.setAttribute(MARK, String(i));
            } catch (_) {
            }
        });
        return fields;
    }

    // --------------------------------------------------------------- naming ----
    /* The shortest honest name for a field: the first label fragment with at
     * least two letters (a component library's chevron glyph is a real
     * fragment), minus the required marker. */
    function captionOf(f, max) {
        for (const bit of String(f.label || '').split('|')) {
            const t = bit.replace(/[\s*﹡＊]*$/, '').replace(/\s*\((required|pflichtfeld)\)\s*$/i, '').trim();
            if (t && (t.match(/\p{L}/gu) || []).length >= 2) return t.slice(0, max || 40);
        }
        const ph = String(f.placeholder || '').trim();
        if (ph && /[\p{L}]/u.test(ph)) return ph.slice(0, max || 40);
        const kind = String(f.lib || '').replace(/^primevue-/, '') || f.type;
        const sec = String(f.section || '').trim();
        return (sec ? `${sec} · ${kind}` : kind).slice(0, max || 40);
    }

    /* A field's identity across re-renders. A framework replaces the node in
     * response to our own write, so identity is name/id, then the caption. */
    function fieldKey(f) {
        const base = baseKey(f);
        return f.nth ? `${base}#${f.nth}` : base;
    }

    function baseKey(f) {
        const el = f.el;
        const named = (el.getAttribute && (el.getAttribute('name') || el.getAttribute('id'))) || '';
        if (named) return `n:${named}`;
        const inner = el.querySelector && el.querySelector('input, textarea, select');
        const innerNamed = inner && (inner.name || inner.id);
        if (innerNamed) return `n:${innerNamed}`;
        return `l:${f.type}:${(f.section || '').slice(0, 40)}:${(f.label || '').slice(0, 80)}`;
    }

    function captionKey(f) {
        return `c:${(f.label || '').split('|')[0].replace(/[*\s]+/g, ' ').trim().toLowerCase()}`;
    }

    /* A rule's short name for the report: the first word of its pattern, so a
     * row reads "matched the street rule" and the whole regex sits in the
     * tooltip. A tester reads the word; whoever edits RULES reads the regex. */
    function ruleName(pattern) {
        const words = String(pattern || '').replace(/\\[bswdBSWD]|[()^$?*+|\\\/]/g, ' ');
        const m = words.match(/[\p{L}][\p{L}-]{2,}/u);
        return m ? m[0].toLowerCase() : 'a';
    }

    // The caption is only trusted when the original node has left the DOM: two fields can share one.
    function alreadyWritten(wrote, f) {
        const k = fieldKey(f);
        const byKey = wrote.find(w => w.key === k);
        if (byKey) return byKey;
        const c = captionKey(f);
        if (c.length <= 3) return undefined;
        return wrote.find(w => w.caption === c && !document.contains(w.f.el));
    }

    // -------------------------------------------------------------- reading ----
    /* "Has a choice been made", which for a picker showing only a flag differs
     * from "what does it show". Only a positive sign counts: "no placeholder
     * class in sight" used to pass for one, and a select that had reverted its
     * value — blank label, no placeholder — was believed to hold a choice, so
     * the repair pass left it empty. */
    function hasSelection(f) {
        const root = f.kind === 'widget' ? f.el : null;
        if (!root) return !!(f.el && f.el.value);
        if (root.querySelector('[aria-selected="true"], [class*="-option-selected"]')) return true;
        const combo = root.matches('[role="combobox"]') ? root : root.querySelector('[role="combobox"]');
        if (combo) {
            if (combo.getAttribute('aria-activedescendant')) return true;
            if (combo.getAttribute('data-test-select-value') || combo.getAttribute('data-value')) return true;
        }
        const inner = root.querySelector('input, select');
        return !!(inner && inner.value);
    }

    // What the page says the field holds right now.
    /* A limit set in a validation schema reaches the DOM only as the complaint
     * shown after a write. That message is the one place the limit exists, so
     * it is read the way a tester reads it: the error the form attached to the
     * field, or the nearest one that belongs to no other field. */
    const COMPLAINT = '[role="alert"], .p-message-error, .p-error, [class*="error"], [class*="invalid"]';
    const MAX_CHARS = /(?:maximum of|at most|no more than|up to|max\.?|maximal|höchstens|maximaal|massimo)\s*(\d{1,4})\s*(?:characters?|chars?|zeichen|tekens|caratteri)|(\d{1,4})\s*(?:characters?|chars?|zeichen)\s*(?:or (?:fewer|less)|maximum|max\.?|oder weniger)/i;
    const CONTROLS = 'input, textarea, select, [role="combobox"], [contenteditable="true"]';

    function complaintFor(f) {
        const input = f.kind === 'widget' ? (f.el.querySelector('input, textarea') || f.el) : f.el;
        const ids = `${input.getAttribute('aria-describedby') || ''} ${input.getAttribute('aria-errormessage') || ''}`
            .split(/\s+/).filter(Boolean);
        const texts = ids.map(id => document.getElementById(id)).filter(Boolean).map(n => n.textContent);
        for (let node = input.parentElement, up = 0; node && up < 4 && !texts.length; node = node.parentElement, up++) {
            const others = Array.from(node.querySelectorAll(CONTROLS)).some(c => c !== input && !f.el.contains(c));
            if (others) break;
            node.querySelectorAll(COMPLAINT).forEach(n => texts.push(n.textContent));
        }
        return texts.join(' ').replace(/\s+/g, ' ').trim();
    }

    function askedMaxChars(text) {
        const m = MAX_CHARS.exec(text);
        return m ? Number(m[1] || m[2]) : null;
    }

    const FIXED_LENGTH = new Set(['file', 'date', 'number', 'range', 'color', 'time', 'datetime-local', 'month', 'week', 'checkbox', 'radio']);

    function currentValue(f) {
        try {
            if (f.kind === 'widget') {
                const shown = W.displayedValue(f.widget);
                if (shown && !H.PLACEHOLDER.test(shown)) return shown;
                const inner = f.el.querySelector('input, textarea');
                if (inner && typeof inner.checked === 'boolean' && /bool|radio/.test(f.type)) return inner.checked ? 'on' : '';
                return inner && inner.value ? inner.value : '';
            }
            if (f.type === 'file') return Array.from(f.el.files || []).map(x => x.name).join(', ');
            if (f.type === 'checkbox' || f.type === 'radio') return f.el.checked ? 'on' : '';
            if (f.type === 'contenteditable') return (f.el.innerText || '').trim();
            return f.el.value || '';
        } catch (_) {
            return '';
        }
    }

    globalThis.FillsmithCollect = {
        MARK, SKIP_TYPES, INLINE_OPTIONS, CAPTCHA, APP_CHROME, FIXED_LENGTH, RICH_KINDS,
        isVisible, textOf, describe, looksRequired, limitsOf, sectionOf, inDomOrder,
        popupSurfaces, modalScope, collectFields,
        captionOf, fieldKey, baseKey, captionKey, ruleName, alreadyWritten,
        hasSelection, complaintFor, askedMaxChars, currentValue
    };
})();
