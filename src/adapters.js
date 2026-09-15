/* FormForge — which control is which, and what it is called.
 *
 * LIBS holds selector *hints* per component library; detection falls back to
 * generic ARIA structure, so a library absent from the table still works if it
 * uses role="combobox" and role="option". This file never drives a control —
 * that is fillers.js.
 */
(function () {
    'use strict';

    const {visible, textOf, safeQuery, PLACEHOLDER} = globalThis.FormForgeDom;

    // ------------------------------------------------------------ libraries ----
    const LIBS = [
        {
            id: 'primevue-select', kind: 'choice',
            root: '.p-select, .p-cascadeselect, .p-treeselect',
            label: '.p-select-label', option: '.p-select-option, li[role="option"]',
            overlay: '.p-select-overlay, .p-cascadeselect-overlay, .p-treeselect-overlay',
            filter: '.p-select-filter, input.p-inputtext'
        },
        {
            id: 'primevue-multiselect', kind: 'multichoice',
            root: '.p-multiselect', label: '.p-multiselect-label',
            option: '.p-multiselect-option, li[role="option"]',
            overlay: '.p-multiselect-overlay', filter: '.p-multiselect-filter'
        },
        {
            id: 'primevue-autocomplete', kind: 'autocomplete',
            root: '.p-autocomplete', input: '.p-autocomplete-input, input',
            option: '.p-autocomplete-option, li[role="option"]', overlay: '.p-autocomplete-overlay'
        },
        {
            id: 'primevue-datepicker',
            kind: 'date',
            root: '.p-datepicker:not(.p-datepicker-panel):not(.p-datepicker-inline)',
            input: '.p-datepicker-input, input'
        },
        {id: 'primevue-inputnumber', kind: 'number', root: '.p-inputnumber', input: '.p-inputnumber-input, input'},
        {id: 'primevue-inputmask', kind: 'text', root: '.p-inputmask', input: 'input'},
        // Quill behind a PrimeVue shell. Above the generic entries so its toolbar buttons are never fields.
        {id: 'primevue-editor', kind: 'richtext', root: '.p-editor, .p-editor-container', input: '.ql-editor'},
        {
            id: 'primevue-toggleswitch',
            kind: 'bool',
            root: '.p-toggleswitch',
            input: 'input.p-toggleswitch-input, input'
        },
        {id: 'primevue-checkbox', kind: 'bool', root: '.p-checkbox', input: 'input.p-checkbox-input, input'},
        {id: 'primevue-radio', kind: 'radio', root: '.p-radiobutton', input: 'input.p-radiobutton-input, input'},
        {id: 'primevue-togglebutton', kind: 'bool', root: '.p-togglebutton'},
        {
            id: 'primevue-selectbutton',
            kind: 'inline-choice',
            root: '.p-selectbutton',
            option: '.p-togglebutton, [role="option"], [role="radio"]'
        },
        {
            id: 'primevue-listbox',
            kind: 'inline-choice',
            root: '.p-listbox',
            option: '.p-listbox-option, li[role="option"]'
        },
        {id: 'primevue-rating', kind: 'inline-choice', root: '.p-rating', option: '.p-rating-option'},

        {
            id: 'mui-select',
            kind: 'choice',
            root: '.MuiSelect-root, .MuiAutocomplete-root',
            overlay: '.MuiPopover-paper, .MuiAutocomplete-popper',
            option: 'li[role="option"], .MuiMenuItem-root'
        },
        {
            id: 'antd-select',
            kind: 'choice',
            root: '.ant-select',
            label: '.ant-select-selection-item',
            overlay: '.ant-select-dropdown',
            option: '.ant-select-item-option'
        },
        {id: 'antd-picker', kind: 'date', root: '.ant-picker', input: 'input'},
        /* Emotion class names end in the part name, so the anchor is the suffix.
         * `[class*="-container"]` also matches an application's own
         * `page-container`, which then swallows every real control inside it. */
        {
            id: 'react-select',
            kind: 'choice',
            root: '[class$="-container"]:has(> [class$="-control"]), .select__container:has(> .select__control)',
            overlay: '[class*="-menu"], .select__menu',
            option: '[class*="-option"], .select__option'
        },
        {
            id: 'radix-select',
            kind: 'choice',
            root: '[data-radix-select-trigger], button[role="combobox"][aria-haspopup="listbox"]',
            overlay: '[data-radix-select-content], [data-radix-popper-content-wrapper]',
            option: '[role="option"]'
        },
        {
            id: 'headless-listbox',
            kind: 'choice',
            root: '[id^="headlessui-listbox-button"]',
            overlay: '[id^="headlessui-listbox-options"]',
            option: '[role="option"]'
        },
        {
            id: 'choices-js',
            kind: 'choice',
            root: '.choices',
            overlay: '.choices__list--dropdown',
            option: '.choices__item--choice'
        },
        {
            id: 'select2',
            kind: 'choice',
            root: '.select2-container',
            overlay: '.select2-dropdown',
            option: '.select2-results__option'
        },
        {id: 'tom-select', kind: 'choice', root: '.ts-wrapper', overlay: '.ts-dropdown', option: '.option'},
        /* `.multiselect` is a name applications give their own wrappers, and a
         * wrapper that matches first wins the whole control — on one real admin
         * it hid the PrimeVue MultiSelect inside it, label, options and all.
         * The library's own parts are the proof that this is the library. */
        {
            id: 'vue-multiselect',
            kind: 'choice',
            root: '.multiselect:has(> .multiselect__tags, > .multiselect__select, > .multiselect__content-wrapper)',
            overlay: '.multiselect__content-wrapper',
            option: '.multiselect__option'
        },

        // Last resort: anything that declares itself a combobox, switch or radio group.
        {
            id: 'aria-combobox',
            kind: 'choice',
            root: '[role="combobox"][aria-haspopup="listbox"], [role="combobox"][aria-expanded]',
            option: '[role="option"]'
        },
        {id: 'aria-switch', kind: 'bool', root: '[role="switch"]'},
        {id: 'aria-radiogroup', kind: 'inline-choice', root: '[role="radiogroup"]', option: '[role="radio"]'}
    ];

    /* Deliberately not `[readonly]`: PrimeVue puts readonly on every Select's
     * hidden input to stop typing, which says nothing about whether the control
     * is ours to write. */
    const OFF = '[disabled], [aria-disabled="true"], [aria-readonly="true"]';

    function writable(el) {
        if (el.matches(OFF)) return false;
        /* A rich-text editor the form has switched off says so on the element
         * that holds the text — Quill sets contenteditable="false" and marks its
         * container disabled. It is not ours yet: the pass that runs after our
         * own writes finds it once the form has enabled it. */
        const host = el.querySelector('[contenteditable]');
        if (host && host.getAttribute('contenteditable') === 'false') return false;
        const inner = el.querySelector('[role="combobox"], input, textarea');
        return !(inner && inner.matches(OFF));
    }

    /* Two rules decide what counts as a widget: the first LIBS entry to match an
     * element decides its kind, and only the outermost match survives — a
     * SelectButton contains ToggleButtons, a Select contains a combobox. */
    function detect(doc) {
        doc = doc || document;
        const byRoot = new Map();
        for (const lib of LIBS) {
            for (const el of safeQuery(doc, lib.root)) {
                if (!visible(el) || !writable(el)) continue;
                // An inline calendar is a view of a value another control owns, not a field.
                if (lib.kind === 'date' && !el.querySelector('input')) continue;
                if (el.closest('[data-formforge-overlay]')) continue;
                if (!byRoot.has(el)) byRoot.set(el, lib);
            }
        }
        const roots = [...byRoot.keys()];
        const found = roots
            .filter(el => !roots.some(other => other !== el && other.contains(el)))
            .map(el => ({lib: byRoot.get(el), root: el, kind: byRoot.get(el).kind, id: byRoot.get(el).id}));
        return groupRadios(found);
    }

    function commonAncestor(els) {
        let a = els[0];
        while (a && !els.every(e => a.contains(e))) a = a.parentElement;
        return a;
    }

    /* A radio group is one decision. Libraries give every radio its own root
     * and no group wrapper, so they are stitched back together by the inner
     * input's `name`, exactly as the browser groups them. */
    function groupRadios(widgets) {
        const out = [];
        const groups = new Map();
        for (const w of widgets) {
            if (w.kind !== 'radio') {
                out.push(w);
                continue;
            }
            const input = w.root.querySelector('input[type="radio"], input');
            const name = input && input.name;
            if (!name) {
                out.push(w);
                continue;
            }
            if (!groups.has(name)) groups.set(name, []);
            groups.get(name).push(w);
        }
        for (const [name, members] of groups) {
            if (members.length === 1) {
                out.push(members[0]);
                continue;
            }
            out.push({
                lib: members[0].lib,
                id: members[0].id + '-group',
                kind: 'radio-group',
                root: commonAncestor(members.map(m => m.root)) || members[0].root,
                members, name
            });
        }
        return out;
    }

    // A radio's caption is rendered by the app beside the control, never inside its root.
    function radioLabel(root, input) {
        if (input) {
            if (input.labels && input.labels.length) {
                const t = textOf(input.labels[0]);
                if (t) return t;
            }
            if (input.id) {
                const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
                if (l) {
                    const t = textOf(l);
                    if (t) return t;
                }
            }
        }
        const wrap = root.closest('label');
        if (wrap) {
            const t = textOf(wrap);
            if (t) return t;
        }
        for (let sib = root.nextElementSibling, i = 0; sib && i < 2; sib = sib.nextElementSibling, i++) {
            const t = textOf(sib);
            if (t) return t;
        }
        // A parent holding the whole group carries the group's question, not this option's name.
        const parent = root.parentElement;
        if (parent && parent.querySelectorAll('.p-radiobutton, [role="radio"], input[type="radio"]').length <= 1) {
            const pt = textOf(parent);
            if (pt) return pt;
        }
        return input ? String(input.value || '') : '';
    }

    // Native controls inside a widget belong to the widget, not to the scanner.
    function claimed(widget) {
        if (widget.members) {
            return widget.members.flatMap(m => safeQuery(m.root, 'input, select, textarea, [contenteditable]'));
        }
        return safeQuery(widget.root, 'input, select, textarea, [contenteditable]');
    }

    // ------------------------------------------------------------- labelling ----
    const FIELD_WRAPPER = '.field, .p-field, .form-group, .form-field, [class*="field"], [class*="form-item"], .ant-form-item';
    const NAMED_WRAPPER = '.field, .p-field, .form-group, .form-field, .ant-form-item';

    function labelFor(widget, describe) {
        const root = widget.root;
        const bits = [];
        const inner = root.querySelector('input, select, textarea');
        if (inner && describe) bits.push(describe(inner));
        if (root.getAttribute('aria-label')) bits.push(root.getAttribute('aria-label'));
        // A Select without a native input keeps its accessible name on the inner combobox.
        const combo = root.matches('[role="combobox"]') ? root : root.querySelector('[role="combobox"]');
        if (combo && combo !== root) {
            ['aria-label', 'name', 'id'].forEach(a => {
                const v = combo.getAttribute(a);
                if (v && v.trim()) bits.push(v.replace(/[_\-.\[\]]+/g, ' '));
            });
        }
        // Vue props that are not real attributes still land on the element (PrimeVue Editor's caption).
        ['label', 'placeholder', 'hint'].forEach(a => {
            const v = root.getAttribute(a);
            if (v && v.trim()) bits.push(v);
        });
        const lb = root.getAttribute('aria-labelledby');
        if (lb) lb.split(/\s+/).forEach(id => {
            const n = document.getElementById(id);
            if (n) bits.push(textOf(n));
        });
        if (root.id) {
            const l = document.querySelector(`label[for="${CSS.escape(root.id)}"]`);
            if (l) bits.push(textOf(l));
        }
        /* A field wrapper usually holds the label as a sibling. Only trust one that
         * holds this single control, or that is explicitly a field by class —
         * otherwise a neighbour's caption bleeds onto this widget. */
        const field = root.closest(FIELD_WRAPPER) || root.parentElement;
        if (field) {
            const named = field.matches(NAMED_WRAPPER);
            const controls = field.querySelectorAll('input, select, textarea, [contenteditable="true"], [role="combobox"]');
            if (named || controls.length <= 1) {
                const l = field.querySelector('label, .p-floatlabel > label, legend, .ant-form-item-label');
                if (l && !l.contains(root)) bits.push(textOf(l));
            }
        }
        const fl = root.parentElement && root.parentElement.querySelector(':scope > label');
        if (fl) bits.push(textOf(fl));
        if (!bits.some(Boolean)) {
            let up = root.parentElement;
            for (let i = 0; up && i < 3; i++, up = up.parentElement) {
                const l = up.querySelector('label');
                if (l && !l.contains(root)) {
                    const t = textOf(l);
                    if (t) {
                        bits.push(t);
                        break;
                    }
                }
            }
        }
        if (root.getAttribute('placeholder')) bits.push(root.getAttribute('placeholder'));
        // Last resort: the heading of the panel the control sits in.
        if (!bits.some(Boolean)) {
            const sec = root.closest('section, fieldset, [class*="panel"], [class*="card"], [class*="box"]');
            const h = sec && sec.querySelector('h1, h2, h3, h4, legend, [role="heading"]');
            if (h && !h.contains(root)) bits.push(textOf(h));
        }
        return bits.filter(Boolean).map(s => s.slice(0, 120)).join(' | ').slice(0, 240);
    }

    /* A control showing its placeholder holds nothing, whatever the text says.
     * Ask the component first (every library marks the state with a class), then
     * the placeholder attribute of the control it wraps, and only then the words. */
    const PROMPT = /^(please\s+)?(bitte\s+)?(select|choose|pick|w(ä|ae)hle[nr]?|ausw(ä|ae)hlen)\b[^]{0,48}$/i;

    function showsPlaceholder(el, root) {
        if (!el) return true;
        for (let n = el; n && n !== root.parentElement; n = n.parentElement) {
            const cls = typeof n.className === 'string' ? n.className : '';
            if (/placeholder/i.test(cls) || /(^|[-_ ])empty(label)?($|[-_ ])/i.test(cls)) return true;
            if (n.hasAttribute && (n.hasAttribute('data-p-placeholder') || n.hasAttribute('aria-placeholder'))) return true;
        }
        const text = textOf(el).trim();
        if (!text) return true;
        for (const p of safeQuery(root, '[placeholder], [aria-placeholder], [data-placeholder]')) {
            const v = p.getAttribute('placeholder') || p.getAttribute('aria-placeholder') || p.getAttribute('data-placeholder');
            if (v && v.trim() === text) return true;
        }
        return PLACEHOLDER.test(text) || PROMPT.test(text);
    }

    // What the control displays right now; '' when it shows a placeholder.
    function displayedValue(widget) {
        const lib = widget.lib;
        if (widget.members) {
            for (const m of widget.members) {
                const i = m.root.querySelector('input');
                if (i && i.checked) return radioLabel(m.root, i);
            }
            return '';
        }
        if (lib.label) {
            const l = widget.root.querySelector(lib.label);
            if (l) return showsPlaceholder(l, widget.root) ? '' : textOf(l);
        }
        const inner = widget.root.querySelector('input, textarea');
        if (inner && inner.value) return inner.value;
        return showsPlaceholder(widget.root, widget.root) ? '' : textOf(widget.root);
    }

    globalThis.FormForgeAdapters = {
        LIBS, detect, claimed, labelFor, displayedValue, showsPlaceholder, radioLabel, writable
    };
})();
