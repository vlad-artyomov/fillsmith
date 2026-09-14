/* FormForge — finding, opening and closing a widget's overlay.
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
        note,
        sleep,
        visible,
        textOf,
        norm,
        press,
        key,
        settle,
        waitFor,
        safeQuery,
        PLACEHOLDER, dialogOf, neutralSpot
    } = globalThis.FormForgeDom;

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

    function liveOverlay(el) {
        if (!el) return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
        if (LEAVING.test(cls)) return false;
        return visible(el);
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

    /* Open a widget's overlay and return it. Accepts an empty panel after a short
     * grace period — that is how a dependent select with nothing to offer is told
     * apart from one that never opened — and gives up early when the combobox
     * keeps saying aria-expanded="false". */
    async function openOverlay(widget) {
        const before = new Set(overlayCandidates(widget));
        const wantId = linkedOverlayId(widget);
        // PrimeVue ignores container clicks whose target is an INPUT: press the root or a trigger.
        const trigger = widget.root.querySelector('[class*="dropdown"]:not(input), [class*="arrow"], [class*="toggle"]')
            || widget.root;
        press(trigger);

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
        if (overlay) try {
            overlay.setAttribute('data-formforge-opened', '');
        } catch (_) {
        }
        return overlay;
    }

    /* aria-expanded="true" is proof the control is open; "false" is not proof it
     * has closed — a component tidies its attribute on one tick and its overlay
     * on another, so the DOM decides. */
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
            if (!stillOpen()) return true;
            if (!inDialog) {                                 // Escape reaches the dialog's own listener and closes it
                key(el, 'Escape');
                key(document.body, 'Escape');
                if (await settle(() => !stillOpen(), 160)) return true;
            }
            press(neutralSpot(widget.root));
            await settle(() => !stillOpen(), 180);
        }
        if (stillOpen()) note(`${widget.id}: its list would not close`);
        return !stillOpen();
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

    // A match if there is one, otherwise a seeded pick.
    function chooseOption(options, candidates, rng) {
        const texts = options.map(o => o && o.el ? o : asTexts([o])[0]);
        return matchAmong(texts, candidates)
            || texts[Math.floor((rng ? rng() : Math.random()) * texts.length)]
            || null;
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
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll', {bubbles: true}));
        await sleep(90);

        // One viewport less a row per step: windows just overlap, so nothing is skipped and little is re-read.
        const step = Math.max(80, Math.floor(scroller.clientHeight - 32));
        const deadline = budgetEnds || (Date.now() + 700);

        const jumped = await jumpToMatch(scroller, overlay, lib, candidates, deadline);
        if (jumped && matchAmong(asTexts(jumped), candidates)) return jumped;
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll', {bubbles: true}));
        await sleep(60);

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
        await sleep(40);
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
    // This picker's own panel: the one its input names, else any live panel that is not an inline calendar.
    function ownPanels(widget) {
        const input = widget.root.querySelector('input, [role="combobox"]') || widget.root;
        const id = input.getAttribute && (input.getAttribute('aria-controls') || input.getAttribute('aria-owns'));
        if (id) {
            const n = document.getElementById(id.split(/\s+/)[0]);
            return n && liveOverlay(n) ? [n] : [];
        }
        return safeQuery(document, PANEL_SELECTOR).filter(el => liveOverlay(el) && !el.closest('.p-datepicker-inline'));
    }

    /* Close a date panel. It opens a tick after the focus that caused it, so wait
     * for it before deciding there is nothing to close. Escape means *cancel* to
     * a date picker: when a value was just typed, click away instead. */
    async function dismissPanel(widget, opts) {
        const el = widget.root.querySelector('input, [tabindex]') || widget.root;
        const input = widget.root.querySelector('input');
        const open = () => {
            if (input && input.getAttribute('aria-expanded') === 'false') return [];
            return ownPanels(widget);
        };
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

    globalThis.FormForgeOverlays = {
        overlayCandidates, optionsIn, liveOverlay, linkedOverlayId, openOverlay,
        closeOverlay, comboOf, chooseOption, matchAmong, asTexts, scrollerFor,
        huntByScrolling, typeAhead, ownPanels, dismissPanel,
        GENERIC_OVERLAYS, PANEL_SELECTOR,
        sawWholeList: () => huntSawWholeList
    };
})();
