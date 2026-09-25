/* Fillsmith — finding, opening and closing a widget's overlay.
 *
 * Overlays are teleported to <body>, so they are global while every question
 * about them is local: "is an overlay open" means "is *this control's* overlay
 * open". Everything here is scoped to the widget that owns it, through
 * aria-controls or through freshness — an element that was not there before
 * the control was pressed.
 */
(function () {
    'use strict';

    const {
        note, sleep, visible, textOf, norm, press, key, settle, safeQuery,
        PLACEHOLDER, dialogOf, neutralSpot
    } = globalThis.FillsmithDom;

    /* Roles and classes only: attribute-substring selectors walk every node and
     * these lists are evaluated inside 25ms polling loops. */
    const GENERIC_OVERLAYS = [
        '[role="listbox"]', '[role="menu"]', '[role="dialog"]',
        '.p-select-overlay', '.p-multiselect-overlay', '.p-autocomplete-overlay',
        '.p-datepicker-panel', '.p-listbox', '.p-popover', '.p-overlaypanel',
        '.ant-select-dropdown', '.ant-picker-dropdown',
        '.MuiPopover-paper', '.MuiAutocomplete-popper', '.MuiPickersPopper-root',
        '[data-radix-popper-content-wrapper]', '[data-radix-select-content]',
        '.choices__list--dropdown', '.select2-dropdown', '.ts-dropdown',
        '.multiselect__content-wrapper', '.flatpickr-calendar'
    ].join(',');

    const PANEL_SELECTOR = [
        '.p-datepicker-panel', '.ant-picker-dropdown', '.MuiPickersPopper-root',
        '.react-datepicker', '.flatpickr-calendar', '.datepicker-dropdown'
    ].join(',');

    // A closing overlay stays in the DOM, visible and full of options, for its whole leave transition.
    const LEAVING = /-leave-(active|to|from)\b/;

    function comboOf(widget) {
        return widget.root.matches('[role="combobox"]') ? widget.root : widget.root.querySelector('[role="combobox"]');
    }

    // The overlays a control names through aria-controls / aria-owns.
    function linkedOverlays(widget) {
        const combo = comboOf(widget);
        const out = [];
        for (const attr of ['aria-controls', 'aria-owns']) {
            const id = combo && combo.getAttribute(attr);
            if (id) id.split(/\s+/).forEach(x => {
                const n = document.getElementById(x);
                if (n) out.push(n);
            });
        }
        return out;
    }

    function linkedOverlayId(widget) {
        const combo = comboOf(widget);
        if (!combo) return '';
        return (combo.getAttribute('aria-controls') || combo.getAttribute('aria-owns') || '').split(/\s+/)[0] || '';
    }

    // Everything that could be this widget's overlay: linked first, then the library's, then generic.
    function overlayCandidates(widget) {
        const list = linkedOverlays(widget);
        if (widget.lib.overlay) list.push(...safeQuery(document, widget.lib.overlay));
        list.push(...safeQuery(document, GENERIC_OVERLAYS));
        return list.filter(visible);
    }

    // Strictly this widget's own overlay, for deciding whether it has closed.
    function ownOverlays(widget) {
        const out = linkedOverlays(widget);
        if (widget.lib.overlay) out.push(...safeQuery(document, widget.lib.overlay));
        return out.filter(liveOverlay);
    }

    /* "Open" means open *now*. The class that says a panel is leaving sits on the
     * overlay wrapper, while `aria-controls` names the list inside it — and the
     * list has no leave class, full opacity of its own, and every option still in
     * it. Asked only of the element itself, a committed dropdown therefore counted
     * as open for its whole fade: four hundred milliseconds of Escapes and clicks
     * at a control that had already closed. */
    function leaving(el) {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            if (n.getAttribute('aria-hidden') === 'true') return true;
            const cls = typeof n.className === 'string' ? n.className : (n.getAttribute('class') || '');
            if (LEAVING.test(cls)) return true;
        }
        return false;
    }

    function liveOverlay(el) {
        return !!el && !leaving(el) && visible(el);
    }

    function optionsIn(overlay, lib) {
        let opts = [];
        if (lib && lib.option) opts = safeQuery(overlay, lib.option);
        if (!opts.length) opts = safeQuery(overlay, '[role="option"]');
        if (!opts.length) opts = safeQuery(overlay, 'li');
        if (!opts.length) opts = safeQuery(overlay, '[class*="option"], [class*="item"]');
        return opts.filter(o => {
            if (!visible(o)) return false;
            // "No results found" is rendered as a row; it is a message, not a choice.
            if (o.matches('[class*="empty"], [class*="no-result"], [class*="noResult"], [class*="no-option"], [class*="noOption"]')) return false;
            if (o.getAttribute('aria-disabled') === 'true' || o.classList.contains('p-disabled') || o.hasAttribute('disabled')) return false;
            const t = textOf(o);
            return t && !PLACEHOLDER.test(t);
        });
    }

    /* What to press to open a control. The deepest surface that is plausibly the
     * trigger, because a press on a child reaches a listener on the root and a
     * press on the root reaches nothing bound to a child: Tom Select binds its
     * control, react-select binds its control div, Select2 its selection.
     *
     * And never the panel. Choices.js and Tom Select render their list inside
     * the control, with "dropdown" in its class — so "the first thing whose
     * class says dropdown" found the hidden list and pressed that, and both
     * libraries reported "would not open" on every field, for ever. */
    const TRIGGER_HINT = '[class*="dropdown"], [class*="arrow"], [class*="toggle"], [class*="control"], ' +
        '[class*="trigger"], [class*="selection"], [class*="inner"], [role="combobox"]';

    function triggerOf(widget) {
        const panelish = [widget.lib.overlay, GENERIC_OVERLAYS, '[role="listbox"]'].filter(Boolean).join(',');
        const isPanel = (el) => {
            try {
                return el.matches(panelish) || !!el.querySelector(panelish);
            } catch (_) {
                return false;
            }
        };
        // Not an input: PrimeVue ignores container clicks whose target is one, and react-select's is invisible.
        const hit = safeQuery(widget.root, TRIGGER_HINT).find(el =>
            el.tagName !== 'INPUT' && !isPanel(el) && visible(el) && el.getBoundingClientRect().width > 4);
        return hit || widget.root;
    }

    /* Open a widget's overlay and return it. Accepts an empty panel after a short
     * grace period — that is how a dependent select with nothing to offer is told
     * apart from one that never opened — and gives up early when the combobox
     * keeps saying aria-expanded="false". */
    async function openOverlay(widget) {
        const before = new Set(overlayCandidates(widget));
        const wantId = linkedOverlayId(widget);
        press(triggerOf(widget));

        // The overlay this control names cannot belong to anyone else; otherwise only a new one counts.
        const fresh = (o) => (wantId && o.id === wantId) || !before.has(o);
        const withOptions = () => overlayCandidates(widget).filter(liveOverlay)
            .find(o => fresh(o) && optionsIn(o, widget.lib).length) || null;
        const any = () => overlayCandidates(widget).filter(liveOverlay).find(fresh) || null;

        let emptySince = 0;
        const verdict = () => {
            const hit = withOptions();
            if (hit) return hit;
            const empty = any();
            if (!empty) {
                emptySince = 0;
                return null;
            }
            if (!emptySince) emptySince = Date.now();
            return Date.now() - emptySince > 250 ? empty : null;
        };

        const combo = comboOf(widget);
        const declined = () => combo && combo.getAttribute('aria-expanded') === 'false' && !any();

        const tryFor = async (ms) => {
            const until = Date.now() + ms;
            const settleBy = Date.now() + 400;
            for (; ;) {
                const hit = verdict();
                if (hit) return hit;
                if (Date.now() > settleBy && declined()) return null;
                if (Date.now() > until) return null;
                await sleep(25);
            }
        };

        let overlay = await tryFor(1600);
        if (!overlay) {
            // Some comboboxes only open from the keyboard.
            const focusable = widget.root.querySelector('input, [tabindex]') || widget.root;
            try {
                focusable.focus({preventScroll: true});
            } catch (_) {
            }
            key(focusable, 'ArrowDown');
            overlay = await tryFor(1200);
        }
        // Marked so the end-of-fill sweep can close what we opened, and only that.
        if (overlay) {
            try {
                overlay.setAttribute('data-fillsmith-opened', '');
            } catch (_) { /* a node the page has already taken back */
            }
            widget.opened = overlay;
        }
        return overlay;
    }

    /* Closed — and the mark comes off with it. `data-fillsmith-opened` means
     * "ours, and possibly still up"; left on a panel that has gone it lies to
     * both of its readers: the sweep at the end of a fill, and the scan that
     * treats a popup's own furniture as something other than a field. */
    function markClosed(widget) {
        if (!widget.opened) return true;
        try {
            widget.opened.removeAttribute('data-fillsmith-opened');
        } catch (_) { /* already gone from the page */
        }
        widget.opened = null;
        return true;
    }

    /* aria-expanded="true" is proof the control is open; "false" is not proof it
     * has closed — a component tidies its attribute on one tick and its overlay
     * on another, so the DOM decides.
     *
     * Most components close themselves the moment a choice commits, so the first
     * thing asked is whether anything needs doing at all. When something does,
     * the click comes before the key: the value is already committed, clicking
     * away is what a person does, and a component that listens for the outside
     * click and nothing else used to pay a whole key-press budget first. */
    async function closeOverlay(widget) {
        const el = widget.root.querySelector('input, [tabindex]') || widget.root;
        const stillOpen = () => {
            const combo = comboOf(widget);
            if (combo && combo.getAttribute('aria-expanded') === 'true') return true;
            // A panel mid-leave has closed as far as the component is concerned; in a background tab it may never finish.
            return ownOverlays(widget).some(o => liveOverlay(o) && optionsIn(o, widget.lib).length);
        };
        const inDialog = !!dialogOf(widget.root);
        for (let i = 0; i < 3; i++) {
            if (!stillOpen()) return markClosed(widget);
            press(neutralSpot(widget.root));                 // inside a dialog, on the dialog; never on the mask
            if (await settle(() => !stillOpen(), 150)) return markClosed(widget);
            if (!inDialog) {                                 // Escape reaches the dialog's own listener and closes it
                key(el, 'Escape');
                key(document.body, 'Escape');
                await settle(() => !stillOpen(), 150);
            }
        }
        if (stillOpen()) {
            note(`${widget.id}: its list would not close`);
            return false;
        }
        return markClosed(widget);
    }

    // ---------------------------------------------------------------- options ----
    /* An option's text is the whole row. A `[class*="label"]` child is right for
     * a library that wraps the caption in one and wrong for a row built of
     * several spans ("+49 Deutschland DE"), so take the fuller of the two. */
    function optionText(o) {
        const whole = textOf(o);
        const part = textOf(o.querySelector('[class*="label"]'));
        return (part && part.length >= whole.length) ? part : (whole || part);
    }

    const asTexts = (options) => options.map(o => ({
        el: o,
        text: optionText(o),
        value: o.getAttribute('data-value') || o.getAttribute('value') || ''
    }));

    /* Find the option a candidate names: exact, then a 2–3 letter code as a whole
     * word ("DE" inside "+49 Deutschland DE"), then a loose containment where
     * both sides are long enough to mean something. */
    function matchAmong(texts, candidates) {
        const cands = (Array.isArray(candidates) ? candidates : [candidates]).filter(c => c != null && String(c) !== '');
        for (const c of cands) {
            const n = norm(c);
            if (!n) continue;
            const exact = texts.find(t => norm(t.value) === n) || texts.find(t => norm(t.text) === n);
            if (exact) return exact;
        }
        for (const c of cands) {
            const raw = String(c).trim();
            if (raw.length < 2 || raw.length > 3 || !/^[A-Za-z]+$/.test(raw)) continue;
            const word = new RegExp(`(^|[^A-Za-z])${raw}([^A-Za-z]|$)`, 'i');
            const byCode = texts.find(t => word.test(t.text) || word.test(t.value));
            if (byCode) return byCode;
        }
        for (const c of cands) {
            const n = norm(c);
            if (n.length < 3) continue;
            const loose = texts.find(t => {
                const o = norm(t.text);
                return o.includes(n) || (o.length > 2 && n.includes(o));
            });
            if (loose) return loose;
        }
        return null;
    }

    // A match if there is one, otherwise a seeded pick. Callers inside a fill always pass the persona's RNG.
    function chooseOption(options, candidates, rng = Math.random) {
        const texts = options.map(o => o && o.el ? o : asTexts([o])[0]);
        return matchAmong(texts, candidates) || texts[Math.floor(rng() * texts.length)] || null;
    }

    // The element that actually scrolls, found by measurement rather than class name.
    function scrollerFor(overlay) {
        const seen = [];
        for (let el = overlay; el && el !== document.body; el = el.parentElement) seen.push(el);
        seen.push(...safeQuery(overlay, '[class*="scroller"], [class*="scroll"], [class*="list"]'));
        return seen.find(el => el.scrollHeight > el.clientHeight + 8) || null;
    }

    let huntSawWholeList = false;

    /* Binary-search a sorted virtualised list by scroll position. Guarded by
     * sampling three positions: an unsorted list ("most used first") would land
     * somewhere arbitrary, and being wrong costs one jump before the walk. */
    async function jumpToMatch(scroller, overlay, lib, candidates, deadline) {
        const want = (Array.isArray(candidates) ? candidates : [candidates]).find(Boolean);
        if (!want) return null;
        const target = String(want);
        const rows = () => asTexts(optionsIn(overlay, lib)).map(o => o.text).filter(Boolean);

        const at = async (top) => {
            scroller.scrollTop = Math.max(0, Math.min(top, scroller.scrollHeight));
            scroller.dispatchEvent(new Event('scroll', {bubbles: true}));
            await settle(() => rows().length > 0, 120);
            return rows();
        };

        const span = scroller.scrollHeight - scroller.clientHeight;
        if (span < scroller.clientHeight) return null;

        const low = await at(0);
        const mid = await at(span / 2);
        const high = await at(span);
        if (!low.length || !mid.length || !high.length) return null;
        if (!(low[0].localeCompare(mid[0]) <= 0 && mid[0].localeCompare(high[0]) <= 0)) return null;

        let lo = 0, hi = span;
        for (let i = 0; i < 12 && Date.now() < deadline; i++) {
            const here = await at(Math.round((lo + hi) / 2));
            if (!here.length) return null;
            const opts = optionsIn(overlay, lib);
            if (matchAmong(asTexts(opts), candidates)) return opts;
            if (target.localeCompare(here[0]) < 0) hi = Math.round((lo + hi) / 2);
            else if (target.localeCompare(here[here.length - 1]) > 0) lo = Math.round((lo + hi) / 2);
            else return opts;                              // in view, just not matched
            if (hi - lo < scroller.clientHeight / 2) break;
        }
        return null;
    }

    /* Walk a virtualised list until a candidate renders. Always from the top: the
     * control may have been scrolled already, and walking down from there skips
     * anything earlier. Runs to the caller's deadline — a choice that *must*
     * match passes a longer one. */
    async function huntByScrolling(overlay, lib, candidates, budgetEnds, opts) {
        const loading = (opts && opts.loading) || (() => false);
        huntSawWholeList = false;
        const scroller = scrollerFor(overlay);
        if (!scroller) return null;
        const start = scroller.scrollTop;
        // A window that is already rendered answers on the first check; only a lazy one waits.
        const rendered = () => optionsIn(overlay, lib).length > 0;
        const toTop = async () => {
            scroller.scrollTop = 0;
            scroller.dispatchEvent(new Event('scroll', {bubbles: true}));
            await settle(rendered, 90);
        };
        await toTop();

        // One viewport less a row per step: windows just overlap, so nothing is skipped and little is re-read.
        const step = Math.max(80, Math.floor(scroller.clientHeight - 32));
        const deadline = budgetEnds || (Date.now() + 700);

        const jumped = await jumpToMatch(scroller, overlay, lib, candidates, deadline);
        if (jumped && matchAmong(asTexts(jumped), candidates)) return jumped;
        await toTop();

        const seenTexts = new Set();
        let stalled = 0, barren = 0, exhausted = false;
        for (let i = 0; i < 80 && Date.now() < deadline; i++) {
            const opts = optionsIn(overlay, lib);
            if (opts.length && matchAmong(asTexts(opts), candidates)) return opts;
            // A lazy list fetching its next page is not exhausted; wait for its loader, within the budget.
            if (loading()) {
                await settle(() => !loading(), Math.max(0, deadline - Date.now()), 40);
                continue;
            }
            // No new rows after scrolling twice: the list was never virtualised and is all here.
            const before = seenTexts.size;
            opts.forEach(o => seenTexts.add(textOf(o)));
            barren = seenTexts.size > before ? 0 : barren + 1;
            if (barren >= 2) {
                exhausted = true;
                break;
            }
            const was = scroller.scrollTop;
            scroller.scrollTop = was + step;
            scroller.dispatchEvent(new Event('scroll', {bubbles: true}));
            await sleep(35);
            if (scroller.scrollTop <= was) {
                // A lazy scroller extends as you reach the end: one stall means wait, two means done.
                if (loading()) {
                    await settle(() => !loading(), Math.max(0, deadline - Date.now()), 40);
                    stalled = 0;
                } else if (++stalled >= 2) {
                    exhausted = true;
                    break;
                } else await sleep(140);
            } else stalled = 0;
        }
        scroller.scrollTop = start;
        await settle(rendered, 40);
        huntSawWholeList = exhausted;
        return null;
    }

    // Selects without a filter box still support type-ahead.
    async function typeAhead(widget, text) {
        const target = widget.root.querySelector('[role="combobox"], input, [tabindex]') || widget.root;
        try {
            target.focus({preventScroll: true});
        } catch (_) {
        }
        for (const ch of String(text).slice(0, 8)) {
            key(target, ch);
            await sleep(25);
        }
        await sleep(180);
    }

    // ----------------------------------------------------------- date panels ----
    /* A calendar rendered into the page is furniture, not a popup: it is there
     * before the fill and belongs to the form. Libraries mark it on the wrapper
     * (`p-datepicker-inline`) or on the panel itself (`p-datepicker-panel-inline`),
     * and a booking form that shows one had every date field spend a second
     * trying to close the page's own calendar. */
    const INLINE_CALENDAR = '[class*="datepicker-inline"], [class*="datepicker-panel-inline"], [class*="picker-inline"]';
    const isInline = (el) => el.matches(INLINE_CALENDAR) || !!el.closest(INLINE_CALENDAR);

    // This picker's own panel: the one its input names, else any live popup panel.
    function ownPanels(widget) {
        const input = widget.root.querySelector('input, [role="combobox"]') || widget.root;
        const id = input.getAttribute && (input.getAttribute('aria-controls') || input.getAttribute('aria-owns'));
        if (id) {
            const n = document.getElementById(id.split(/\s+/)[0]);
            return n && liveOverlay(n) ? [n] : [];
        }
        return safeQuery(document, PANEL_SELECTOR).filter(el => liveOverlay(el) && !isInline(el));
    }

    /* Close a date panel. It opens a tick after the focus that caused it, so wait
     * for it before deciding there is nothing to close. Escape means *cancel* to
     * a date picker: when a value was just typed, click away instead. */
    async function dismissPanel(widget, opts) {
        const el = widget.root.querySelector('input, [tabindex]') || widget.root;
        // The DOM decides, here as everywhere: aria-expanded="false" is tidied a tick before the panel goes.
        const open = () => ownPanels(widget);
        try {
            el.blur();
        } catch (_) {
        }
        await settle(() => open().length > 0, 150);
        const mayEscape = !(opts && opts.keepTypedValue) && !dialogOf(widget.root);
        for (let i = 0; i < 4; i++) {
            if (!open().length) return true;
            if (mayEscape) {
                key(el, 'Escape');
                key(document.body, 'Escape');
                if (await settle(() => !open().length, 140)) return true;
            }
            press(neutralSpot(widget.root));
            await settle(() => !open().length, 160);
        }
        if (open().length) note(`${widget.id}: its date panel would not close`);
        return !open().length;
    }

    globalThis.FillsmithOverlays = {
        overlayCandidates, optionsIn, liveOverlay, linkedOverlayId, openOverlay,
        closeOverlay, comboOf, chooseOption, matchAmong, asTexts, scrollerFor,
        huntByScrolling, typeAhead, ownPanels, dismissPanel,
        GENERIC_OVERLAYS, PANEL_SELECTOR,
        sawWholeList: () => huntSawWholeList
    };
})();
