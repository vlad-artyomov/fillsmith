/* FormForge — page scanner and filler.
 *
 * Finds every fillable control (native inputs and component-library widgets),
 * decides a value for each — rule, type default, model, fallback — writes them
 * in DOM order, and then checks the page actually kept them.
 */
(function () {
    'use strict';

    const G = globalThis.FormForgeGen;
    const W = globalThis.FormForgeWidgets;
    const O = globalThis.FormForgeOverlays;
    const U = globalThis.FormForgeUploads;
    const Hud = globalThis.FormForgeHud;
    const H = W.helpers;
    const {progress, toast, ping} = Hud;

    const MARK = 'data-formforge-id';
    const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
    const CHOICE_KINDS = new Set(['choice', 'multichoice', 'inline-choice', 'autocomplete', 'radio', 'radio-group', 'select']);
    const CAPTCHA = /\b(captcha|recaptcha|hcaptcha|turnstile|otp|one-?time|2fa|mfa|verification\s*code|sicherheitscode)\b/i;
    // Page chrome that happens to be a form control: filling a language switcher rewrites every label mid-run.
    const APP_CHROME = /locale\s*switcher|switch\s+language|change\s+language|language\s+switcher|sprache\s+(wechseln|ändern)|theme\s+switcher/i;
    /* Choices whose candidate is a real-world fact an application's list may
     * hold — a country, a city, a salutation. Only these are worth filtering and
     * scrolling for; an invented company name is in nobody's list. */
    const REAL_WORLD_CHOICE = /countrylist|countrycode|phonecountry|\b(country|land|staat|city|stadt|ort|state|region|bundesland|province|salutation|anrede|gender|geschlecht|language|sprache|currency|währung)\b/i;
    const TIME_FIELD = /\b(time|uhrzeit|zeit)\b/i;
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

    let rng = Math.random;             // replaced by the persona's RNG at fill time

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

        for (const el of document.querySelectorAll('[data-formforge-overlay], [data-formforge-opened]')) add(el);
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
        const fields = [];
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
            if (filled && !opts.overwrite && w.kind !== 'bool') continue;
            fields.push({
                kind: 'widget', widget: w, el: w.root, type: w.kind, lib: w.id,
                label, section: sectionOf(w.root),
                required: looksRequired(w.root, label),
                ...limitsOf(w.root.querySelector('input, textarea'))
            });
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
            if (hasValue && !opts.overwrite) continue;

            const f = {
                kind: 'native', el, tag, type, label, section: sectionOf(el),
                required: el.required || looksRequired(el, label),
                ...limitsOf(el)
            };
            if (type === 'select') {
                f.options = Array.from(el.options)
                    .filter(o => o.value !== '' && !o.disabled)
                    .map(o => ({value: o.value, text: textOf(o).slice(0, 60)})).slice(0, 40);
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
    // "Has a choice been made", which for a picker showing only a flag differs from "what does it show".
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
        if (inner && inner.value) return true;
        return !root.querySelector('[class*="placeholder"]');
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

    // ----------------------------------------------------------- resolution ----
    /* Decide a value locally: rule, then type default. Returns null when only
     * the model or the fallback can answer. The section is deliberately not
     * matched — a legend like "Registered address" would win the address rule
     * for every field inside it. */
    function resolveLocally(f, persona) {
        const hit = G.matchRuleDetail(`${f.label} ${f.autocomplete}`, persona);
        if (hit) {
            f.matchedRule = hit.pattern;
            if (hit.weak) f.weakRule = true;
        }
        let value = hit ? hit.value : null;
        if (value != null && value !== '') {
            // A rich-text control wants markup even when a prose rule matched it.
            if (f.type === 'richtext' && typeof value === 'string' && !/^\s*</.test(value)) {
                return {value: persona.richText, source: 'rule'};
            }
            // A date widget wants the locale's format; a date in the past (a birth date) is typed, not picked.
            if (f.kind === 'widget' && f.type === 'date' && typeof value === 'string' && ISO_DATE.test(value)) {
                f.typeFirst = new Date(value) < new Date();
                value = G.formatDate(value, persona.dateFormat);
            }
            return {value, source: 'rule'};
        }

        if (f.kind === 'widget') {
            if (f.type === 'date') {
                if (TIME_FIELD.test(f.label)) return {value: '12:00', source: 'type'};
                if (/\b(year|jahr(gang)?|baujahr)\b/i.test(f.label) && !/\b(date|datum)\b/i.test(f.label)) {
                    return {value: String(new Date().getFullYear() - Math.floor(rng() * 8)), source: 'type'};
                }
                const isEnd = /\b(end|return|to|until|bis|rückgabe|ende)\b/i.test(f.label);
                return {value: isEnd ? persona.futureDateLateLocal : persona.futureDateLocal, source: 'type'};
            }
            if (f.type === 'number') return {value: G.numberFor(f.label, persona), source: 'type'};
            if (f.type === 'richtext') return {value: persona.richText, source: 'type'};
            if (f.type === 'bool' || CHOICE_KINDS.has(f.type)) return {value: null, source: 'choice'};
            return null;
        }

        if (f.type === 'number') return {value: G.numberFor(f.label, persona), source: 'type'};
        const byType = G.byType(f, persona);
        if (byType != null) return {value: byType, source: 'type'};
        if (CHOICE_KINDS.has(f.type) || f.type === 'checkbox') return {value: null, source: 'choice'};
        return null;
    }

    // null means "pick one yourself", which only a choice or a bool can honour.
    const picksItsOwn = (f) => CHOICE_KINDS.has(f.type) || f.type === 'checkbox' || f.type === 'bool';

    /* A phone field beside a country picker gets plain digits with the country
     * code; anything else with an input mask in its placeholder is fitted to it.
     * Choice kinds are exempt — a picker is also labelled "Phone number". */
    function shapeFor(f, value, persona) {
        if (CHOICE_KINDS.has(f.type)) return value;
        if (/\b(phone|tel|telefon|mobile|handy|fax)\b/i.test(f.label || '')) return persona.phoneDigits;
        const mask = f.placeholder || '';
        return G.looksLikeMask(mask) ? G.fitMask(value, mask, rng) : value;
    }

    // ---------------------------------------------------------------- write ----
    const fire = (el, types) => {
        for (const t of types) el.dispatchEvent(new Event(t, {bubbles: true, composed: true}));
    };
    const filesAttached = new Set();      // by field key: an empty file input is what success looks like

    // Write one value and return what the control holds afterwards (null = nothing landed).
    async function applyValue(f, rawValue, persona) {
        if (f.kind === 'widget') {
            return await W.fill(f.widget, G.constrain(shapeFor(f, rawValue, persona), f), {
                rng, persona, label: captionOf(f, 24),
                required: !!f.required,
                requireMatch: REAL_WORLD_CHOICE.test(f.label || ''),
                typeFirst: !!f.typeFirst
            });
        }

        const el = f.el;
        let value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
        try {
            if (f.type === 'checkbox') {
                const want = f.required ? true : (value === true || value === 'true' || rng() > 0.55);
                if (el.checked !== want) {
                    H.press(el);
                    if (el.checked !== want) {
                        el.checked = want;
                        fire(el, ['input', 'change']);
                    }
                }
                return String(el.checked);
            }

            if (f.type === 'radio') {
                const group = f.group || [el];
                const choice = O.matchAmong(f.options || [], rawValue);
                const hit = choice ? (f.options || []).indexOf(choice) : -1;
                const target = hit >= 0 ? group[hit] : group[Math.floor(rng() * group.length)];
                H.press(target);
                if (!target.checked) {
                    target.checked = true;
                    fire(target, ['input', 'change']);
                }
                return target.value || describe(target);
            }

            if (f.type === 'select') {
                const opts = f.options || [];
                if (!opts.length) return null;
                const choice = O.matchAmong(opts, rawValue) || opts[Math.floor(rng() * opts.length)];
                el.focus();
                H.setNativeValue(el, choice.value);
                fire(el, ['input', 'change']);
                const picked = el.selectedOptions && el.selectedOptions[0];
                return picked ? (textOf(picked) || picked.value) : (el.value || null);
            }

            if (f.type === 'file') {
                const names = await U.attachFiles(el, persona, fieldKey(f), rng);
                if (names) filesAttached.add(fieldKey(f));
                return names;
            }

            if (f.type === 'contenteditable') return H.typeInto(el, String(value)) || null;

            value = String(G.constrain(shapeFor(f, value, persona), f));
            const written = H.typeInto(el, value);
            H.commit(el);
            return (el.value != null && el.value !== '') ? el.value : (written || null);
        } catch (err) {
            H.note(`${captionOf(f, 30)}: threw while being filled — ${err && err.message || err}`);
            return null;
        }
    }

    /* The mark on a field just written. A ring that eases in and out reads as
     * attention; one that snaps on and off reads as an error. Outline moves no
     * layout, and the attribute leaves the element exactly as it was. */
    const TOUCH = 'data-formforge-touch';
    const touchTimers = new WeakMap();

    function touchStyle() {
        if (document.getElementById('formforge-touch-style')) return;
        const style = document.createElement('style');
        style.id = 'formforge-touch-style';
        style.textContent =
            `[${TOUCH}]{outline:2px solid rgba(47,158,111,0)!important;outline-offset:5px!important;` +
            `transition:outline-color .45s cubic-bezier(.2,.7,.2,1),outline-offset .45s cubic-bezier(.2,.7,.2,1)!important}` +
            `[${TOUCH}="ok"]{outline-color:rgba(47,158,111,.9)!important;outline-offset:2px!important}` +
            `[${TOUCH}="warn"]{outline-color:rgba(208,138,43,.9)!important;outline-offset:2px!important}` +
            `@media (prefers-reduced-motion:reduce){[${TOUCH}]{transition:none!important}}`;
        (document.head || document.documentElement).appendChild(style);
    }

    function flash(el, ok) {
        touchStyle();
        (touchTimers.get(el) || []).forEach(clearTimeout);
        el.setAttribute(TOUCH, '');
        void el.offsetWidth;                                   // begin from the transparent ring, so the colour eases in
        touchTimers.set(el, [
            setTimeout(() => el.setAttribute(TOUCH, ok ? 'ok' : 'warn'), 20),
            setTimeout(() => el.setAttribute(TOUCH, ''), 1500),
            setTimeout(() => el.removeAttribute(TOUCH), 2000)
        ]);
    }

    // ---------------------------------------------------------------- model ----
    /* Budgets. The first call after a browser start also pays for bringing the
     * model into memory, so it is budgeted separately (SESSION_ALLOWANCE_MS) from
     * patience with the model's answer (modelBudget). Later passes in one fill
     * get half the patience, and there are at most two of them. */
    const SESSION_ALLOWANCE_MS = 20000;
    const LATER_PASS_SHARE = 0.5;
    let modelWarm = false;
    let modelCalls = 0;
    let modelSettings = {};
    let modelTimedOut = false;
    let modelDebug = null;
    let modelVia = '';
    let modelError = '';
    let modelWarming = false;
    let modelLoading = false;
    let modelRequestMs = 0;         // how long the model took, which is not how long the fill waited
    let warmProbe = null;           // "is the session already up?", asked before the form is read

    function modelBudget(n, settings) {
        const override = Number(settings && settings.modelTimeout) || 0;
        if (override > 0) return override * 1000;
        const work = Math.min(8000, 1500 + 600 * n);
        return modelWarm ? work : Math.max(15000, work);
    }

    // What this screen is, in the page's own words. document.title alone is the product name on every SPA screen.
    function pageContext(el) {
        const one = (sel, within) => {
            const n = (within || document).querySelector(sel);
            return n ? textOf(n) : '';
        };
        const dialog = el && el.closest('[role="dialog"], .p-dialog, dialog, [class*="modal"]');
        return {
            title: document.title.slice(0, 80),
            breadcrumb: (one('[aria-label*="readcrumb"], .p-breadcrumb, nav[class*="breadcrumb"]') || '').slice(0, 120),
            heading: (one('main h1, main h2, h1, [role="main"] h1') || '').slice(0, 100),
            dialog: dialog ? (one('h1, h2, h3, [class*="title"], [class*="header"]', dialog) || '').slice(0, 100) : ''
        };
    }

    // A few existing rows of the list being added to: nothing describes a value's shape better.
    function nearbyExamples() {
        const out = [];
        try {
            const table = document.querySelector('table, [role="table"], [role="grid"], .p-datatable');
            if (table) {
                for (const cell of Array.from(table.querySelectorAll('td, [role="gridcell"]')).slice(0, 6)) {
                    const t = textOf(cell);
                    if (t && t.length < 40 && !out.includes(t)) out.push(t);
                }
            }
        } catch (_) {
        }
        return out.slice(0, 5);
    }

    const sendMessage = (msg) => new Promise(r => {
        try {
            chrome.runtime.sendMessage(msg, (v) => {
                void chrome.runtime.lastError;
                r(v || {});
            });
        } catch (_) {
            r({});
        }
    });

    /* Ask the model about the fields nothing local could answer. Always bounded:
     * whatever has not answered by the deadline is filled by the rules. */
    async function askModel(unresolved, persona) {
        if (!unresolved.length) return {};
        const payload = {
            persona: {
                fullName: persona.fullName, email: persona.email, company: persona.company,
                city: persona.city, country: persona.country, jobTitle: persona.jobTitle,
                locale: persona.locale, seed: persona.seed
            },
            pageTitle: document.title.slice(0, 120),
            context: pageContext(unresolved[0] && unresolved[0].el),
            examples: nearbyExamples(),
            // The field's whole contract, so the answer arrives inside it rather than being clipped.
            fields: unresolved.map(f => ({
                id: f.idx,
                label: f.label.slice(0, 140),
                section: f.section.slice(0, 60),
                required: f.required || undefined,
                placeholder: f.placeholder || undefined,
                min: f.min != null ? f.min : undefined,
                max: f.max != null ? f.max : undefined,
                richText: f.type === 'richtext' || undefined,
                type: f.kind === 'widget' ? `${f.type} (custom widget)` : f.type,
                maxLength: f.maxLength,
                pattern: f.pattern,
                options: f.options ? f.options.map(o => o.text).slice(0, 20) : undefined
            }))
        };
        try {
            const want = modelBudget(unresolved.length, modelSettings);
            const budget = modelCalls === 0 ? want : Math.round(want * LATER_PASS_SHARE);
            modelCalls++;
            /* Whether the session is already up decides how long to wait, and the
             * answer is wanted here rather than a round trip later: run() sends
             * this probe before it reads the form, so by now it has usually come
             * back. A probe that has not is not worth blocking on. */
            if (!warmProbe) warmProbe = sendMessage({kind: 'nano-warm'});
            const warm = await Promise.race([warmProbe, H.sleep(120).then(() => null)]);
            const loading = !(warm && warm.ready) && !modelWarm;
            if (loading) {
                modelLoading = true;
                progress('model', 'Warming up the model', null);
            }
            payload.budgetMs = budget;
            payload.sessionWaitMs = loading ? SESSION_ALLOWANCE_MS : 0;
            const tAsk = Date.now();
            const res = await Promise.race([
                chrome.runtime.sendMessage({kind: 'generate', payload}),
                new Promise(r => setTimeout(() => r({
                    ok: false,
                    timedOut: true
                }), budget + (loading ? SESSION_ALLOWANCE_MS : 0)))
            ]);
            modelLoading = false;
            modelRequestMs += Date.now() - tAsk;
            if (res && !res.timedOut) modelWarm = true;
            if (res && res.debug) modelDebug = res.debug;
            if (res && res.via) modelVia = res.via;
            if (res && res.error) modelError = String(res.error);
            modelWarming = !!(res && res.warming);
            if (res && res.timedOut) {
                modelTimedOut = true;
                // The worker keeps generating; the popup collects the late answer for the Debug tab.
                modelDebug = modelDebug || {
                    at: tAsk, asked: unresolved.length, waitedMs: Date.now() - tAsk,
                    note: `gave up after ${Date.now() - tAsk}ms of a ${budget}ms budget`,
                    batches: [], pending: true
                };
            }
            return (res && res.ok && res.values) ? res.values : {};
        } catch (err) {
            H.note(`the model could not be reached — ${err && err.message || err}`);
            return {};
        }
    }

    // ------------------------------------------------------------------ run ----
    async function run(settings) {
        modelSettings = settings || {};
        // Bring the model session up while the form is being read; nothing waits on it.
        warmProbe = null;
        if (modelSettings.useAI !== false) {
            warmProbe = sendMessage({kind: 'nano-warm'});
            warmProbe.then(r => {
                if (r && r.ready) modelWarm = true;
            });
        }
        globalThis.__formforgeRuns = (globalThis.__formforgeRuns || 0) + 1;   // observable double-injection
        modelTimedOut = false;
        modelDebug = null;
        modelVia = '';
        modelError = '';
        modelWarming = false;
        modelCalls = 0;
        modelRequestMs = 0;
        filesAttached.clear();
        Hud.reset();
        H.takeNotes();

        const tStart = Date.now();
        const phase = {};
        const seed = settings.seed || G.newSeed();
        const persona = G.buildPersona(seed, settings.locale || 'en-US', {
            emailDomain: settings.emailDomain,
            plusTag: settings.plusTag !== false
        });
        rng = persona._rng;

        /* Marks from an earlier fill would hide anything that fill revealed: a control
         * disabled at collect time is skipped, and a stale mark then keeps the later
         * passes from seeing it as new once our writes have enabled it. */
        document.querySelectorAll(`[${MARK}]`).forEach(el => el.removeAttribute(MARK));

        // A panel that was on screen before we started (an inline calendar) is not one we opened.
        const panelsBefore = new Set();
        document.querySelectorAll(O.PANEL_SELECTOR).forEach(el => {
            if (H.visible(el)) panelsBefore.add(el);
        });

        progress('read', 'Reading the form');
        const tCollect = Date.now();
        const fields = collectFields({overwrite: settings.overwrite !== false});
        phase.collect = Date.now() - tCollect;
        if (!fields.length) {
            toast('No fillable fields found on this page.', null);
            return {count: 0, persona: stripRng(persona), aiUsed: 0, widgets: 0};
        }

        // Plan: rules and type defaults first; the rest, plus weakly-ruled fields, go to the model.
        const plan = new Map();
        const unresolved = [];
        for (const f of fields) {
            const local = resolveLocally(f, persona);
            if (local && local.value != null) plan.set(f.idx, local);
            else unresolved.push(f);
        }
        const weakly = fields.filter(f => f.weakRule && plan.has(f.idx));
        const askAbout = unresolved.concat(weakly);
        const awaiting = new Set(askAbout.map(f => f.idx));

        /* The model is asked, not waited for. Every field a rule already answered
         * is written while the request is in flight, so the form starts filling
         * at once instead of after the model; a field the model owns is written
         * the moment its answer lands, and whatever is still outstanding when the
         * pass ends is collected afterwards — on the same deadline, which runs
         * from the request, so overlapping shortens the fill and never extends
         * the patience the setting promises. */
        let answers = null;
        let pending = null;
        let modelAsked = false;
        let aiUsed = 0;
        if (settings.useAI !== false && askAbout.length) {
            modelAsked = true;
            progress('model', `Asking the model about ${askAbout.length} field${askAbout.length === 1 ? '' : 's'}`);
            pending = askModel(askAbout, persona).then(v => {
                answers = v || {};
            });
        }

        const modelAnswer = (f) => {
            if (!answers) return null;
            const v = answers[String(f.idx)] ?? answers[f.idx];
            return v != null && String(v).trim() !== '' ? v : null;
        };
        // Why a field ended up on the filler, in the words of whatever went wrong.
        const whyFallback = (f) => f.matchedRule ? 'a rule matched but produced nothing'
            : settings.useAI === false ? 'no rule matched; the model was switched off'
                : modelWarming ? 'no rule matched; the model was still loading'
                    : modelTimedOut ? 'no rule matched; the model ran out of time'
                        : modelError ? `no rule matched; the model answered with an error: ${modelError.slice(0, 120)}`
                            : modelAsked ? 'no rule matched; the model had no answer for it'
                                : 'no rule matched; the model was not available';
        /* What to write, decided as late as possible: the model's answer if it
         * has arrived, the rule underneath it if not, and the filler otherwise. */
        const entryFor = (f) => {
            const fromModel = modelAnswer(f);
            if (fromModel != null) return {value: fromModel, source: 'ai'};
            if (plan.has(f.idx)) return plan.get(f.idx);
            f.whyFallback = whyFallback(f);
            return {value: picksItsOwn(f) ? null : G.fallbackText(f, persona), source: 'fallback'};
        };

        // First pass: sequential and awaited. Widgets open and close overlays; dependent dropdowns need order.
        progress('fill', 'Filling the form', {done: 0, total: fields.length});
        const filled = [];
        const skipped = [];
        const wrote = [];
        const timings = [];
        let widgetCount = 0;
        let at = 0;

        async function write(f, entry) {
            progress('fill', 'Filling the form', {done: at++, total: fields.length, label: captionOf(f)});
            // A switch written a moment ago may have folded this field away; that is the form's choice, not a miss.
            if (!document.contains(f.el) || !isVisible(f.el)) {
                H.note(`${captionOf(f)}: gone from the page before its turn — hidden by an earlier write`);
                return;
            }
            const t0 = Date.now();
            const written = await applyValue(f, entry.value, persona);
            timings.push({ms: Date.now() - t0, type: f.type, lib: f.lib || 'native', label: captionOf(f, 28)});
            if (written == null || String(written) === '') {
                skipped.push({
                    label: captionOf(f),
                    type: f.type,
                    lib: f.lib || '',
                    source: entry.source,
                    f,
                    plannedValue: entry.value
                });
                return;
            }
            // For a choice the plan is null ("pick one"); remember what was committed so a repair restores *that*.
            wrote.push({
                f,
                key: fieldKey(f),
                caption: captionKey(f),
                value: entry.value == null ? String(written) : entry.value
            });
            if (f.kind === 'widget') widgetCount++;
            if (entry.source === 'ai') aiUsed++;
            flash(f.el, entry.source !== 'fallback');
            filled.push({
                label: captionOf(f),
                value: String(written).slice(0, 60),
                source: f.kind === 'widget' ? `${entry.source}/${f.lib}` : entry.source,
                why: entry.source === 'rule' ? `matched ${f.matchedRule || 'a rule'}`
                    : entry.source === 'type' ? `the control is a ${f.type}`
                        : entry.source === 'ai' ? 'the model answered'
                            : (f.whyFallback || 'nothing else produced a value'),
                type: f.type, lib: f.lib || ''
            });
        }

        const late = [];
        for (const f of fields) {
            // Every field is either planned or waiting on the model; nothing is skipped here.
            if (pending && !answers && awaiting.has(f.idx)) late.push(f);
            else await write(f, entryFor(f));
        }

        // Whatever the model still owed when the pass ended: wait out the rest of its budget, then write.
        const tWait = Date.now();
        if (late.length && pending) {
            progress('fill', `Waiting for the model — ${late.length} field${late.length === 1 ? '' : 's'} left`,
                {done: at, total: fields.length});
            await pending;
        }
        phase.model = Date.now() - tWait;
        for (const f of late) await write(f, entryFor(f));

        if (modelAsked) {
            ping({
                stage: 'model',
                text: `Asking the model about ${askAbout.length} field${askAbout.length === 1 ? '' : 's'}`,
                detail: modelWarming ? 'still loading — try again in a moment'
                    : modelTimedOut ? 'out of time'
                        : aiUsed ? `${aiUsed} answered`
                            : modelError ? `error — ${modelError.slice(0, 80)}`
                                : modelVia && modelVia !== 'none' ? 'answered none' : 'no model available'
            });
        }

        /* Later passes, until the form stops changing: re-write what reverted,
         * retry what wrote nothing, fill what our writes revealed (a switch that
         * renders the controls it gates). A field is identified by key, so a node
         * the framework rebuilt gets its original value back rather than a new one. */
        phase.firstPass = Date.now() - tStart - phase.collect - phase.model;
        const tRevealed = Date.now();
        let revealed = 0;
        let repaired = 0;
        let lateModelCalls = 0;
        let settled = false;
        for (let pass = 0; pass < 5; pass++) {
            progress('repair', revealed || repaired
                ? `Filling what appeared (${revealed + repaired} so far)`
                : 'Checking that the form kept it all');
            let didSomething = false;

            for (const w of wrote) {
                if (w.repaired) continue;
                if (w.f.type === 'file' || filesAttached.has(w.key)) continue;
                if (!document.contains(w.f.el) || !isVisible(w.f.el)) continue;
                if (currentValue(w.f) !== '') continue;
                if (CHOICE_KINDS.has(w.f.type) && hasSelection(w.f)) continue;
                w.repaired = true;
                const again = await applyValue(w.f, w.value, persona);
                if (again != null && String(again) !== '') {
                    repaired++;
                    didSomething = true;
                }
            }

            // The form's own complaints about length: shorten to what it asks and write once more.
            for (const w of wrote) {
                if (w.shortened || CHOICE_KINDS.has(w.f.type) || FIXED_LENGTH.has(w.f.type)) continue;
                if (!document.contains(w.f.el) || !isVisible(w.f.el)) continue;
                const cur = String(currentValue(w.f) || '');
                const max = cur ? askedMaxChars(complaintFor(w.f)) : null;
                if (!max || cur.length <= max) continue;
                w.shortened = true;
                const again = await applyValue(w.f, G.shortenTo(cur, max), persona);
                if (again == null || String(again) === '') continue;
                w.value = String(again);
                repaired++;
                didSomething = true;
                const entry = filled.filter(x => x.label === captionOf(w.f)).pop();
                if (entry) {
                    entry.value = String(again).slice(0, 60);
                    entry.why += `; shortened to ${max} characters, as the form asked`;
                }
                H.note(`${w.caption}: the form asked for at most ${max} characters`);
            }

            for (const sk of skipped) {
                if (sk.retried) continue;
                if (sk.f.type === 'file' && filesAttached.has(fieldKey(sk.f))) continue;
                if (!document.contains(sk.f.el) || !isVisible(sk.f.el)) continue;
                if (currentValue(sk.f) !== '' || hasSelection(sk.f)) continue;
                sk.retried = true;
                const again = await applyValue(sk.f, sk.plannedValue, persona);
                if (again != null && String(again) !== '') {
                    repaired++;
                    didSomething = true;
                    filled.push({
                        label: sk.label, value: String(again).slice(0, 60),
                        source: sk.source + (sk.f.lib ? `/${sk.f.lib}` : ''),
                        why: 'committed on a second attempt', type: sk.type, lib: sk.f.lib || ''
                    });
                }
            }

            const tC = Date.now();
            const seen = new Set(document.querySelectorAll(`[${MARK}]`));
            const fresh = collectFields({overwrite: false}).filter(f => !seen.has(f.el));
            phase.recollect = (phase.recollect || 0) + (Date.now() - tC);

            const lateAnswers = {};
            if (settings.useAI !== false && lateModelCalls < 2) {
                const needModel = fresh.filter(f => !alreadyWritten(wrote, f) && !resolveLocally(f, persona) && !picksItsOwn(f));
                if (needModel.length) {
                    modelAsked = true;
                    lateModelCalls++;
                    const tM = Date.now();
                    Object.assign(lateAnswers, await askModel(needModel, persona));
                    phase.modelLate = (phase.modelLate || 0) + (Date.now() - tM);
                }
            }
            if (!fresh.length && !didSomething) break;

            let wroteNow = 0;
            for (const f of fresh) {
                const key = fieldKey(f);
                if (f.type === 'file' && filesAttached.has(key)) continue;
                const earlier = alreadyWritten(wrote, f);
                if (earlier && currentValue(f) !== '') continue;

                const local = earlier ? null : resolveLocally(f, persona);
                const late = lateAnswers[f.idx];
                const fromModel = !earlier && !local && late != null && String(late).trim() !== '';
                const value = earlier ? earlier.value
                    : local ? local.value
                        : fromModel ? late
                            : picksItsOwn(f) ? null : G.fallbackText(f, persona);
                const tR = Date.now();
                const written = await applyValue(f, value, persona);
                timings.push({
                    ms: Date.now() - tR,
                    type: f.type,
                    lib: (f.lib || 'native') + ':revealed',
                    label: captionOf(f, 28)
                });
                if (written == null || String(written) === '') continue;
                wroteNow++;
                didSomething = true;
                settled = false;
                if (fromModel) aiUsed++;
                if (earlier) {
                    earlier.f = f;
                    repaired++;
                    continue;
                }     // a repair, already listed
                revealed++;
                wrote.push({f, key, caption: captionKey(f), value});
                if (f.kind === 'widget') widgetCount++;
                flash(f.el, !!local);
                const source = local ? local.source : fromModel ? 'ai' : 'fallback';
                filled.push({
                    label: captionOf(f),
                    value: String(written).slice(0, 60),
                    source: f.kind === 'widget' ? `${source}/${f.lib}` : source,
                    why: local ? `matched ${f.matchedRule || 'a rule'}`
                        : fromModel ? 'the model answered (field appeared mid-fill)'
                            : 'appeared mid-fill; nothing else produced a value',
                    type: f.type, lib: f.lib || ''
                });
            }
            if (!wroteNow && !didSomething) {
                // One last look a beat later: a re-render provoked by the last write lands after the loop would give up.
                if (settled) break;
                settled = true;
                await H.sleep(250);
            }
        }

        // Let go of the field, then close anything we opened and did not manage to close.
        try {
            const active = document.activeElement;
            if (active && active !== document.body && typeof active.blur === 'function') active.blur();
        } catch (_) {
        }
        let leftOpen = [];
        try {
            const sel = `${O.PANEL_SELECTOR}, [data-formforge-opened]`;
            const stillOpen = () => Array.from(document.querySelectorAll(sel))
                .filter(el => H.visible(el) && !panelsBefore.has(el)
                    && !/-leave-/.test(String(el.className || ''))
                    && el.getAttribute('aria-hidden') !== 'true');
            for (let i = 0; i < 3 && stillOpen().length; i++) {
                H.press(H.neutralSpot(modalScope()));      // inside a dialog, on the dialog; never on the mask
                await H.settle(() => !stillOpen().length, 150);
            }
            leftOpen = stillOpen().map(e => String(e.className || e.tagName).slice(0, 80));
            for (const cls of leftOpen) H.note(`left on screen: ${cls}`);
        } catch (_) {
        }

        phase.secondPass = Date.now() - tRevealed;
        phase.total = Date.now() - tStart;
        timings.sort((a, b) => b.ms - a.ms);
        const notes = H.takeNotes();

        // Persisted from here, not from the popup, so a keyboard-triggered fill is recorded too.
        try {
            chrome.storage.local.set({
                lastFill: {
                    at: Date.now(), url: location.href.slice(0, 200), title: document.title.slice(0, 80),
                    count: filled.length, widgets: widgetCount, revealed, repaired, aiUsed,
                    modelTimedOut, modelWarming, modelVia, modelError, modelAsked, leftOpen, notes,
                    modelRequestMs, unresolvedCount: askAbout.length,
                    persona: {fullName: persona.fullName, seed: persona.seed, locale: persona.locale},
                    filled, skipped, phase, modelDebug
                }
            });
        } catch (_) {
        }

        toast(`Filled ${filled.length} field${filled.length === 1 ? '' : 's'}`,
            {persona, aiUsed, filled, widgets: widgetCount, skipped, ms: phase.total});
        ping({
            stage: 'done', text: `Filled ${filled.length} field${filled.length === 1 ? '' : 's'}`,
            done: filled.length, total: fields.length, aiUsed, skipped: skipped.length, ms: phase.total
        });
        return {
            count: filled.length,
            persona: stripRng(persona),
            aiUsed,
            widgets: widgetCount,
            revealed,
            repaired,
            leftOpen,
            notes,
            modelTimedOut,
            modelWarming,
            modelVia,
            modelError,
            modelDebug,
            modelAsked,
            modelRequestMs,
            unresolvedCount: askAbout.length,
            filled,
            skipped,
            phase,
            slowest: timings.slice(0, 12),
            choiceTimings: W.takeChoiceTimings()
        };
    }

    /* One field, on its own terms: no ordering, no repair loop, and worth a model
     * round trip. From the keyboard the field is the one with the caret; from the
     * context menu it is the one under the pointer, which a custom dropdown never
     * focuses. */
    async function fillOne(settings, opts) {
        const usable = (n) => n && n.nodeType === 1 && n !== document.body && n !== document.documentElement && document.contains(n);
        const focused = usable(document.activeElement) && document.activeElement;
        const pointed = usable(lastContextTarget) && lastContextTarget;
        const el = opts && opts.focusFirst ? (focused || pointed) : (pointed || focused);
        if (!el) {
            if (opts && opts.focusFirst) {
                toast('Put the cursor in a field first', {hint: true});
                return {ok: false, error: 'no field has the focus'};
            }
            // Either our listener was not there yet for that right-click, or the click was not on a field.
            const unseen = !sawContextMenu;
            toast(unseen ? 'Right-click the field once more' : 'Right-click the field itself', {hint: true});
            return {
                ok: false,
                error: unseen ? 'nothing was under that right-click yet — try it again' : 'that right-click was not on a field'
            };
        }

        const persona = G.buildPersona(settings.seed || G.newSeed(), settings.locale || 'en-US', {
            emailDomain: settings.emailDomain, plusTag: settings.plusTag !== false
        });
        rng = persona._rng;
        Hud.reset();

        // The clicked node may be the inner input of a widget; find the collected field that contains it.
        const fields = collectFields({overwrite: true});
        const f = fields.find(x => x.el === el || x.el.contains(el) || (x.group || []).includes(el));
        if (!f) {
            /* A control the form has switched off is a different answer from one
             * FormForge does not recognise, and only one of them is worth acting
             * on. Said on the page, because a fill from the keyboard or the
             * context menu has nowhere else to say it. */
            const off = el.closest('[contenteditable="false"], [disabled], [aria-disabled="true"], [class*="disabled"]');
            const why = off ? 'That field is switched off — turn it on first'
                : 'FormForge does not know how to fill that control';
            toast(why, {hint: true});
            return {ok: false, error: why};
        }

        progress('fill', 'Filling one field', {done: 0, total: 1, label: captionOf(f)});
        const local = resolveLocally(f, persona);
        let value = local ? local.value : null;
        let source = local ? local.source : 'fallback';
        if (value == null && settings.useAI !== false) {
            const answers = await askModel([f], persona);
            const v = answers[String(f.idx)] ?? answers[f.idx];
            if (v != null && String(v).trim() !== '') {
                value = v;
                source = 'ai';
            }
        }
        if (value == null) value = picksItsOwn(f) ? null : G.fallbackText(f, persona);

        const written = await applyValue(f, value, persona);
        const ok = written != null && String(written) !== '';
        if (ok) flash(f.el, source !== 'fallback');
        // Keep the caret where it was, so the shortcut can be pressed again for another value.
        if (el === focused && f.kind === 'native') {
            try {
                el.focus({preventScroll: true});
            } catch (_) {
            }
        }
        const entry = {
            label: captionOf(f), value: String(written || '').slice(0, 60),
            source: f.kind === 'widget' ? `${source}/${f.lib}` : source, type: f.type, lib: f.lib || ''
        };
        const aiUsed = source === 'ai' ? 1 : 0;
        toast(ok ? 'Filled one field' : 'That field did not take a value',
            {persona, aiUsed, filled: ok ? [entry] : [], skipped: ok ? [] : [entry]});
        return {
            ok, count: ok ? 1 : 0, persona: stripRng(persona), aiUsed,
            widgets: f.kind === 'widget' ? 1 : 0, filled: ok ? [entry] : [], skipped: ok ? [] : [entry]
        };
    }

    /* An uploader takes the files out of its input and keeps its own list, so
     * emptying the input clears nothing a tester can see. The list's own remove
     * buttons do; they are looked for in the nearest ancestor that has any,
     * never as far up as the form, whose other buttons delete other things. */
    const REMOVE_FILE = [
        '.p-fileupload-file-remove-button', '[data-pc-section="pcremovebutton"]', '[data-pc-section="removebutton"]',
        'button[name="deleteFile"]', '[aria-label*="remove" i]', '[aria-label*="delete" i]', '[aria-label*="löschen" i]',
        '[aria-label*="entfernen" i]', '[title*="remove" i]', '[title*="delete" i]', '[title*="löschen" i]', '[title*="entfernen" i]'
    ].join(', ');

    function removeAttached(input) {
        for (let node = input.parentElement; node && node !== document.body && node.tagName !== 'FORM'; node = node.parentElement) {
            const buttons = Array.from(node.querySelectorAll(REMOVE_FILE)).filter(b => !b.disabled);
            if (buttons.length) {
                buttons.forEach(b => H.press(b));
                return buttons.length;
            }
        }
        return 0;
    }

    function clearAll() {
        let n = 0;
        document.querySelectorAll(`[${MARK}]`).forEach(el => {
            const type = (el.type || '').toLowerCase();
            if (type === 'file') {
                const had = (el.files && el.files.length) || 0;
                H.setNativeValue(el, '');
                if (had) fire(el, ['input', 'change']);
                if (had + removeAttached(el)) n++;
            } else if (type === 'checkbox' || type === 'radio') {
                if (el.checked) {
                    el.checked = false;
                    fire(el, ['input', 'change']);
                    n++;
                }
            } else if (el.isContentEditable) {
                el.textContent = '';
                fire(el, ['input', 'change']);
                n++;
            } else if ('value' in el) {
                H.setNativeValue(el, '');
                fire(el, ['input', 'change']);
                n++;
            } else {
                const clear = el.querySelector('[class*="clear"], [data-pc-section="clearicon"]');
                if (clear) {
                    H.press(clear);
                    n++;
                }
            }
        });
        toast(`Cleared ${n} fields`, null);
        return {count: n};
    }

    function stripRng(p) {
        const c = Object.assign({}, p);
        delete c._rng;
        return c;
    }

    // -------------------------------------------------------------- messaging ----
    /* Injection happens on demand and can happen twice (the popup warms the page,
     * then dispatches). A second listener would turn one Fill into two racing
     * runs, so everything below registers once per document. */
    if (globalThis.__formforgeListening) return;
    globalThis.__formforgeListening = true;
    let busy = false;

    // Exposed for the test suites, which call these through the content-script world.
    globalThis.__formforge = {run, fillOne, clearAll, collectFields, describe, pageContext, nearbyExamples};

    // Chrome's context menu does not say which element was clicked; remember it ourselves.
    let lastContextTarget = null;
    let sawContextMenu = false;
    addEventListener('contextmenu', (e) => {
        sawContextMenu = true;
        lastContextTarget = e.target;
    }, true);

    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

    function exclusive(job, respond) {
        if (busy) {
            respond({ok: false, error: 'a fill is already running'});
            return false;
        }
        busy = true;
        job().then(respond).catch(e => respond({ok: false, error: String(e)})).finally(() => {
            busy = false;
        });
        return true;
    }

    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
        if (msg.kind === 'fill') return exclusive(async () => ({ok: true, ...(await run(msg.settings || {}))}), respond);
        if (msg.kind === 'fill-one') return exclusive(() => fillOne(msg.settings || {}, {focusFirst: !!msg.focusFirst}), respond);
        if (msg.kind === 'clear') return exclusive(async () => ({ok: true, ...clearAll()}), respond);
        // The worker says when the model has finished loading, so the card can stop saying "warming up".
        if (msg.kind === 'model-stage') {
            if (busy && modelLoading && msg.stage === 'asking') {
                modelLoading = false;
                progress('model', msg.text || 'Asking the model', null);
            }
            respond({ok: true});
            return false;
        }
        // Dry run: what would be filled, and which adapter claimed each control.
        if (msg.kind === 'scan') {
            const fields = collectFields({overwrite: true});
            const trim = s => (s || '').replace(/\s+/g, ' ').trim();
            const cls = el => trim(el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className || ''));
            // Present but not fillable right now: nearly always a collapsed accordion or an inactive tab.
            const hidden = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'))
                .filter(el => !SKIP_TYPES.has((el.type || el.tagName).toLowerCase()) && !isVisible(el));
            respond({
                ok: true, count: fields.length,
                widgets: fields.filter(f => f.kind === 'widget').map(f => ({
                    lib: f.lib,
                    kind: f.type,
                    label: f.label.slice(0, 60)
                })),
                fields: fields.map(f => ({
                    kind: f.kind, type: f.type, lib: f.lib || '',
                    label: trim(f.label).slice(0, 140), section: trim(f.section).slice(0, 60),
                    required: !!f.required, tag: f.el.tagName.toLowerCase(), cls: cls(f.el).slice(0, 80),
                    pc: (f.el.getAttribute && f.el.getAttribute('data-pc-name')) || ''
                })),
                hidden: hidden.map(el => ({
                    tag: el.tagName.toLowerCase(), type: (el.type || '').toLowerCase(),
                    name: el.name || el.id || '', label: trim(describe(el)).slice(0, 90), cls: cls(el).slice(0, 60)
                }))
            });
            return true;
        }
        return false;
    });
})();
