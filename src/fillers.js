/* FormForge — how to drive each kind of control.
 *
 * One strategy per control shape, and every one ends the same way: read the
 * control back and report what it actually holds — never what was typed or
 * planned. A component that accepts a value and reverts it on the next render
 * is indistinguishable from one that refused it.
 */
(function () {
    'use strict';

    const {
        note, takeNotes, sleep, visible, textOf, norm, press, key, typeInto, setNativeValue,
        commit, settle, waitFor, safeQuery, PLACEHOLDER, neutralSpot, typeIntoRich, clearRich, plainText
    } = globalThis.FormForgeDom;
    const {detect, claimed, labelFor, displayedValue, radioLabel} = globalThis.FormForgeAdapters;
    const O = globalThis.FormForgeOverlays;
    const {
        overlayCandidates, optionsIn, liveOverlay, linkedOverlayId, openOverlay, closeOverlay,
        comboOf, chooseOption, matchAmong, asTexts, scrollerFor, huntByScrolling, typeAhead,
        ownPanels, dismissPanel, PANEL_SELECTOR
    } = O;

    const isSelected = (el) => el && (el.getAttribute('aria-selected') === 'true'
        || /(^|\s|-)selected(\s|$|-)/.test(el.className || ''));
    const first = (candidates) => (Array.isArray(candidates) ? candidates : [candidates]).find(Boolean);

    // Where a dropdown's time goes: open / hunt / pick / close are four different problems.
    const choiceTimings = [];

    /* A list that comes over the network says so while it loads: PrimeVue puts a
     * spinner on the trigger and a loader in the overlay, other libraries mark
     * aria-busy or a "-loading" class. Wait on that, not on a fixed clock — and
     * note that PrimeVue ignores clicks on a trigger that is still loading. */
    const LOADING = '.p-select-loading-icon, .p-virtualscroller-loader, .p-virtualscroller-loading, ' +
        '[data-test-select-loading="true"], [aria-busy="true"], [role="progressbar"], .pi-spin, ' +
        '[class*="-loading"], [class*="-loader"], [class*="spinner"]';
    const EMPTY_MESSAGE = '[class*="empty-message"], [class*="emptyMessage"], [class*="no-option"], ' +
        '[class*="noOption"], [class*="no-result"], [class*="noResult"]';
    const LOAD_CAP_MS = 6000;
    const busy = (el) => !!el && ((el.matches(LOADING) && visible(el)) || safeQuery(el, LOADING).some(visible));
    /* The element a control names through aria-controls is the list itself; the
     * loader and the empty message sit beside it in the panel that wraps it. */
    const PANEL_WRAP = '.p-select-overlay, .p-multiselect-overlay, .p-autocomplete-overlay, .p-select-list-container, ' +
        '.ant-select-dropdown, .MuiPopover-paper, .MuiAutocomplete-popper, [data-radix-popper-content-wrapper], ' +
        '[class*="__menu"], [class*="-menu"], [class*="overlay"], [class*="dropdown"], [class*="popper"]';
    const OVERLAY_ROOTS = '.p-select-overlay, .p-multiselect-overlay, .p-autocomplete-overlay, .p-treeselect-overlay, .p-cascadeselect-overlay';
    const panelOf = (overlay) => {
        const parent = overlay.parentElement;
        // The library's whole overlay first: PrimeVue's filter box is a sibling of the list's scroll container.
        return (parent && (parent.closest(OVERLAY_ROOTS) || parent.closest(PANEL_WRAP))) || overlay;
    };

    /* The options an overlay holds once it has finished loading. Returns [] only
     * when the control has answered — an empty message, or nothing for a while
     * with no loader in sight. */
    async function awaitOptions(source, widget, tt) {
        // `source` may be a getter: the list node is swapped when a server answers, and a fixed node goes stale mid-wait.
        const current = () => (typeof source === 'function' ? source() : source);
        const until = Date.now() + LOAD_CAP_MS;
        let quietSince = 0;
        let last = Date.now();
        for (; ;) {
            const overlay = current();
            const panel = panelOf(overlay);
            const opts = optionsIn(overlay, widget.lib);
            if (opts.length) return opts;
            const now = Date.now();
            if (busy(panel) || busy(widget.root)) {
                quietSince = 0;
                if (tt) tt.load += now - last;         // the page's latency, kept apart from ours
            } else {
                if (safeQuery(panel, EMPTY_MESSAGE).some(visible)) return [];
                if (!quietSince) quietSince = Date.now();
                else if (now - quietSince > 900) return [];
            }
            if (now > until) return [];
            last = now;
            await sleep(40);
        }
    }

    // ----------------------------------------------------------------- choice ----
    async function fillChoice(widget, candidates, ctx, multi) {
        const markBefore = widget.root.innerHTML;
        // `load` is time spent waiting for the page's own loader; the other four are ours.
        const tt = {id: widget.id, label: ctx.label || '', load: 0, open: 0, hunt: 0, pick: 0, close: 0};
        choiceTimings.push(tt);

        const tWait = Date.now();
        await settle(() => !busy(widget.root), LOAD_CAP_MS, 40);
        tt.load = Date.now() - tWait;
        const tOpen = Date.now();
        let overlay = await openOverlay(widget);
        tt.open = Date.now() - tOpen;
        if (!overlay) {
            note(`${ctx.label || widget.id}: would not open`);
            return null;
        }
        overlay.setAttribute('data-formforge-overlay', '1');
        /* The list is rebuilt when the server answers a filter: same id, new node.
         * Every later look goes through here, or it reads a detached list as empty. */
        const live = () => {
            if (!overlay.isConnected && overlay.id) {
                const again = document.getElementById(overlay.id);
                if (again) {
                    overlay = again;
                    overlay.setAttribute('data-formforge-overlay', '1');
                }
            }
            return overlay;
        };

        let options = await awaitOptions(live, widget, tt);

        /* Search — filter, scroll, type-ahead — only for a candidate that could be
         * in the list at all (`requireMatch`: a country, a city, a salutation) and
         * only when rows are out of the document: a virtualised list shows it by
         * scrolling through far more height than its rows hold. An invented company
         * name is not in anybody's organization list, and asking a server-side
         * filter to look for it costs two round trips to learn nothing. */
        const want = ctx.requireMatch ? first(candidates) : null;
        const filterSel = widget.lib.filter || 'input[type="text"], input:not([type])';
        // The list a control names through aria-controls is the ul; the filter box sits beside it in the panel.
        const filter = panelOf(overlay).querySelector(filterSel);
        const scroller = scrollerFor(overlay);
        const rowsTall = options.reduce((n, o) => n + o.getBoundingClientRect().height, 0);
        const moreThanShows = (!!scroller && rowsTall > 0 && scroller.scrollHeight > rowsTall * 1.5)
            || (!options.length && !!filter);

        /* The rows on screen say nothing about what a filter can reach: a virtualised
         * list renders a window, a server-backed one holds a page. When a match is
         * required and not in sight, the filter is asked; a client-side list answers
         * a miss at once with its empty message, so a wrong spelling costs little. */
        if (filter && want && !matchAmong(asTexts(options), candidates)) {
            const panel = panelOf(overlay);
            const listing = () => asTexts(optionsIn(live(), widget.lib)).map(o => o.text).join('\n');
            /* A query has taken only once the list reacts: a loader, different rows,
             * or the empty message. A list that never reacts was not filtered, and
             * reading its untouched first page as "what matched" picks at random. */
            const emptyShown = () => safeQuery(panelOf(live()), EMPTY_MESSAGE).some(visible);
            const search = async (query) => {
                const before = listing();
                const emptyBefore = emptyShown();            // a stale "no results" from the last query is not a reaction to this one
                const reacted = () => busy(panelOf(live())) || listing() !== before || (emptyShown() && !emptyBefore);
                typeInto(filter, query);
                const tReact = Date.now();
                const took = await settle(reacted, 1500, 40);
                if (!took) {
                    tt.load += Date.now() - tReact;
                    return null;
                }
                let found = await awaitOptions(live, widget, tt);
                /* PrimeVue answers from the rows it already holds, then asks the server and
                 * replaces them. A loader that starts within a debounce means the answer is
                 * still coming; the rows on screen now are not it. */
                if (await settle(() => busy(panelOf(live())), 1000, 40)) found = await awaitOptions(live, widget, tt);
                tt.load += Date.now() - tReact;              // the page's debounce and round trips, not ours
                return found;
            };
            // The same country under its other names: a German list has no "United States", it has "Vereinigte Staaten".
            const spellings = [...new Set((Array.isArray(candidates) ? candidates : [candidates])
                .filter(c => typeof c === 'string' && c.trim().length > 2).map(c => c.trim().slice(0, 24)))].slice(0, 3);
            let found = null, asked = '';
            for (const q of spellings) {
                asked = q;
                found = await search(q);
                if (found === null) {
                    note(`${ctx.label || widget.id}: its filter did not react to "${q}"`);
                    break;
                }
                if (found.length) break;
            }
            if (found && found.length) {
                /* A handful of rows for a full name, none reading like it: the server matched a
                 * field the list does not show — an English name under a German label. Its
                 * answer to the persona's country is the persona's country. */
                if (found.length <= 3 && asked.length > 3 && !matchAmong(asTexts(found), candidates)) {
                    const answer = asTexts(found)[0].text;
                    note(`${ctx.label || widget.id}: the list answered "${asked}" with "${answer}" — taking it`);
                    candidates = [answer, ...(Array.isArray(candidates) ? candidates : [candidates])];
                }
                options = found;
            } else {
                // Nothing matched any spelling: clear the query and wait for the full list to come back.
                const restored = await search('');
                options = restored && restored.length ? restored : optionsIn(live(), widget.lib);
            }
        }
        if (!options.length) {
            // A list that stayed empty after its filter was cleared is stale; one fresh opening before giving up.
            live().removeAttribute('data-formforge-overlay');
            await closeOverlay(widget);
            const again = await openOverlay(widget);
            if (again) {
                overlay = again;
                overlay.setAttribute('data-formforge-overlay', '1');
                options = await awaitOptions(overlay, widget, tt);
            }
        }
        if (!options.length) {
            note(`${ctx.label || widget.id}: its list opened with nothing in it`);
            overlay.removeAttribute('data-formforge-overlay');
            await closeOverlay(widget);
            return null;
        }

        /* One budget for the whole hunt, longer when only a match will do (a
         * country picker beside a phone number). Scrolling first, because it is
         * library-agnostic and leaves the match on screen; type-ahead after. */
        const tHunt = Date.now();
        if (want && !multi && moreThanShows && !matchAmong(asTexts(options), candidates)) {
            // A required country is worth a longer walk: a lazy list loads a page at a time on the way down.
            const budgetEnds = tHunt + (ctx.requireMatch ? 4000 : 600);
            let after = await huntByScrolling(live(), widget.lib, candidates, budgetEnds, {loading: () => busy(panelOf(live()))});
            if (after && after.length) {
                options = after;
            } else if (!O.sawWholeList() && Date.now() < budgetEnds - 250) {
                await typeAhead(widget, want);
                after = optionsIn(live(), widget.lib);
                if (after.length && matchAmong(asTexts(after), candidates)) options = after;
            }
        }

        // The control may already hold the wanted option; pressing it would change nothing.
        if (!multi) {
            const already = matchAmong(asTexts(optionsIn(live(), widget.lib)), candidates);
            if (already && isSelected(already.el)) {
                overlay.removeAttribute('data-formforge-overlay');
                await closeOverlay(widget);
                return already.text || displayedValue(widget) || null;
            }
        }

        tt.hunt = Date.now() - tHunt;
        const tPick = Date.now();
        const picked = [];
        const count = multi ? Math.min(options.length, 1 + Math.floor(ctx.rng() * 2)) : 1;
        for (let i = 0; i < count; i++) {
            const fresh = optionsIn(live(), widget.lib).filter(o => !picked.includes(o));
            if (!fresh.length) break;
            /* requireMatch buys a longer search, never a veto: an empty required
             * picker blocks the form and everything that depends on it, where a
             * mismatched country is visibly test data. */
            const wanted = i === 0 ? candidates : null;
            let choice = (ctx.requireMatch && i === 0)
                ? matchAmong(asTexts(fresh), wanted)
                : chooseOption(fresh, wanted, ctx.rng);
            let settledFor = false;
            if (!choice && i === 0) {
                choice = chooseOption(fresh, null, ctx.rng);
                settledFor = !!choice;
            }
            if (i === 0 && (settledFor || !choice)) {
                const seen = asTexts(fresh).map(o => o.text).filter(Boolean);
                const asked = first(wanted) || '';
                note(`${ctx.label || widget.id}: no "${asked}" among ${seen.length} option(s)` +
                    (seen.length ? ` (${seen.slice(0, 3).join(', ')}…)` : '') +
                    (settledFor ? ` — took "${choice.text || choice.value || '?'}"` : ' — nothing to take'));
            }
            if (!choice) break;
            const shownBefore = displayedValue(widget);
            press(choice.el);
            picked.push(choice.el);
            await settle(() => {
                if (displayedValue(widget) !== shownBefore) return true;
                const combo = comboOf(widget);
                return !multi && combo && combo.getAttribute('aria-expanded') === 'false';
            }, 220);
        }

        tt.pick = Date.now() - tPick;
        const tClose = Date.now();
        overlay.removeAttribute('data-formforge-overlay');
        const pickedText = picked.length ? textOf(picked[picked.length - 1]) : '';
        await closeOverlay(widget);
        /* The label is rendered a tick after the choice: wait for it, or for any
         * change at all — a picker whose value is a flag has no text to show. */
        await settle(() => {
            const v = displayedValue(widget);
            return (v && !PLACEHOLDER.test(v)) || widget.root.innerHTML !== markBefore;
        }, 120);
        tt.close = Date.now() - tClose;

        const shown = displayedValue(widget);
        if (shown && !PLACEHOLDER.test(shown)) return shown;

        /* A picker that renders its value as a flag has no text to read, and
         * choosing the app's own default alters no markup. A pressed option that
         * is now selected, or a control that has closed, is what committing looks like. */
        const chosen = picked[picked.length - 1];
        if (isSelected(chosen)) return pickedText || displayedValue(widget) || null;
        if (pickedText && widget.root.innerHTML !== markBefore) return pickedText;
        if (!multi && pickedText) {
            const combo = comboOf(widget);
            if (combo && combo.getAttribute('aria-expanded') === 'false') return pickedText;
        }

        // Some libraries only commit from the keyboard.
        const focusable = widget.root.querySelector('input, [tabindex]') || widget.root;
        key(focusable, 'ArrowDown');
        await sleep(80);
        key(focusable, 'Enter');
        await sleep(120);
        const retry = displayedValue(widget);
        if (retry && !PLACEHOLDER.test(retry)) return retry;
        note(`${ctx.label || widget.id}: pressed "${pickedText || '?'}" but the control still shows ${shown ? `"${shown}"` : 'nothing'}`);
        return null;
    }

    async function fillInlineChoice(widget, candidates, ctx) {
        const options = optionsIn(widget.root, widget.lib);
        if (!options.length) return null;
        const choice = chooseOption(options, candidates, ctx.rng);
        if (!choice) return null;
        press(choice.el);
        await settle(() => isSelected(choice.el) || !!displayedValue(widget), 150);
        return choice.text || displayedValue(widget);
    }

    async function fillRadioGroup(widget, candidates, ctx) {
        const options = widget.members.map(m => {
            const input = m.root.querySelector('input');
            return {el: m.root, input, text: radioLabel(m.root, input), value: (input && input.value) || ''};
        }).filter(o => o.input && !o.input.disabled && visible(o.el));
        if (!options.length) return null;

        // A caption shared by every member is the group's question, not an option's name.
        const unique = new Set(options.map(o => o.text).filter(Boolean));
        if (unique.size < options.length) options.forEach(o => {
            o.text = o.value || o.text;
        });
        const groupLabel = norm(labelFor(widget));
        if (groupLabel) {
            options.forEach((o, i) => {
                const n = norm(o.text);
                if (!n || (n !== groupLabel && !groupLabel.startsWith(n))) return;
                const id = o.input && o.input.id ? String(o.input.id).split(/[.\-_]/).pop() : '';
                o.text = o.value || id || `option ${i + 1}`;
            });
        }

        const choice = chooseOption(options, candidates, ctx.rng);
        if (!choice) return null;
        // The hidden input is the control; the wrapper is the fallback.
        press(choice.input || choice.el);
        await settle(() => choice.input && choice.input.checked, 200);
        if (choice.input && !choice.input.checked) {
            press(choice.el);
            await settle(() => choice.input.checked, 200);
        }
        return choice.text || choice.value || null;
    }

    // ------------------------------------------------------------------- bool ----
    async function fillBool(widget, value, ctx) {
        const input = widget.lib.input ? widget.root.querySelector(widget.lib.input) : null;
        const required = input && (input.required || input.getAttribute('aria-required') === 'true');
        const want = value === true || value === 'true' ? true
            : value === false || value === 'false' ? false
                : required ? true : ctx.rng() > 0.55;
        const isOn = () => {
            if (input && typeof input.checked === 'boolean') return input.checked;
            const a = widget.root.getAttribute('aria-checked') || widget.root.getAttribute('aria-pressed');
            if (a != null) return a === 'true';
            return /checked|active|selected/.test(widget.root.className);
        };
        if (isOn() !== want) {
            // The real input first (PrimeVue keeps it at opacity 0 behind the wrapper), then the wrapper.
            const target = input || widget.root;
            press(target);
            await settle(() => isOn() === want, 200);
            if (isOn() !== want) {
                press(target === widget.root ? input : widget.root);
                await settle(() => isOn() === want, 200);
            }
        }
        return String(isOn());
    }

    // ----------------------------------------------------------- autocomplete ----
    const SAYS_EMPTY = '[class*="empty"], [class*="no-option"], [class*="no-result"],' +
        '[class*="noOption"], [class*="noResult"], [role="status"], [role="alert"]';

    /* Shortest query first, whole candidate last: a backend matches on a prefix,
     * so "Jul" is likelier to return "Julia Koch" than the full string, and
     * ending on the candidate leaves the field holding it if nothing matches.
     * A panel that says "no results" is believed at once; a silent empty panel
     * gets one short grace period. */
    async function fillAutocomplete(widget, candidates, ctx) {
        const input = widget.root.querySelector(widget.lib.input || 'input');
        if (!input) return null;
        const seedText = String(first(candidates) == null ? '' : first(candidates));
        // With nothing to aim at, a single common letter makes the list appear.
        const probe = seedText || String((ctx.persona && (ctx.persona.lastName || ctx.persona.company)) || 'a').slice(0, 2);
        if (!probe) return null;

        const before = new Set(overlayCandidates(widget));
        const wantId = linkedOverlayId(widget);
        const mine = () => overlayCandidates(widget).filter(liveOverlay)
            .filter(o => wantId ? o.id === wantId : !before.has(o));
        const pickOverlay = () => mine().find(o => optionsIn(o, widget.lib).length) || null;

        // A panel counts only once it differs from the one left by the previous attempt.
        let asked = new Map();
        const snapshot = () => {
            asked = new Map(overlayCandidates(widget).filter(liveOverlay).map(o => [o, o.innerHTML.length]));
        };
        const emptyOverlay = () => {
            const panels = mine().filter(o => !asked.has(o) || asked.get(o) !== o.innerHTML.length);
            if (!panels.length || panels.some(o => optionsIn(o, widget.lib).length)) return null;
            return panels.some(o => safeQuery(o, SAYS_EMPTY).some(visible)) ? 'said-empty' : 'empty';
        };

        let overlay = null;
        let sawPanel = false;
        const shorter = seedText ? [probe.slice(0, 3), probe.slice(0, 1)] : ['e', 'a'];
        const attempts = [...new Set(shorter.filter(x => x && x !== probe)), probe];
        const deadline = Date.now() + 1500;
        for (let i = 0; i < attempts.length; i++) {
            const left = deadline - Date.now();
            if (left < 150) break;
            const slice = Math.max(300, Math.floor(left / (attempts.length - i)));
            snapshot();
            typeInto(input, attempts[i]);
            input.dispatchEvent(new Event('keyup', {bubbles: true}));
            const verdict = await waitFor(() => pickOverlay() || emptyOverlay(), Math.min(slice, left));
            if (verdict) sawPanel = true;
            /* Two probes in and nothing at all: no list, no "no results",
             * nothing loading. That is a box which takes free text, and the
             * attempt after this one would spend the rest of the budget
             * learning it again. Measured on a white-label domain field: 1.5s
             * on every fill, eleven fills running, for a list that does not
             * exist. The second probe is the broadest one, so a backend that
             * was going to answer has answered by here. */
            if (i >= 1 && !sawPanel && !mine().length && !busy(widget.root)) break;
            if (verdict && verdict !== 'empty' && verdict !== 'said-empty') {
                overlay = verdict;
                break;
            }
            if (verdict === 'empty') {
                const late = await waitFor(pickOverlay, Math.min(220, Math.max(0, deadline - Date.now())));
                if (late) {
                    overlay = late;
                    break;
                }
            }
        }
        if (overlay) {
            const choice = chooseOption(optionsIn(overlay, widget.lib), candidates, ctx.rng);
            if (choice) {
                press(choice.el);
                await settle(() => (input.value || '').length > 0, 200);
                return displayedValue(widget) || choice.text;
            }
        }

        /* No suggestion. Leave the whole candidate (a free-text autocomplete keeps
         * it) or clear a probe, then wait for the panel that last write triggers
         * and dismiss it — otherwise it lands over the next field. */
        if (!seedText) typeInto(input, '');
        else if (input.value !== seedText) typeInto(input, seedText);
        commit(input);
        if (sawPanel) await settle(() => overlayCandidates(widget).filter(liveOverlay).length > 0, 320);
        await closeOverlay(widget);
        return seedText ? (input.value || null) : null;
    }

    // ------------------------------------------------------------------- date ----
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    const CLOCK = /^\d{1,2}:\d{2}$/;

    function localDate(iso, fmt) {
        const [y, m, d] = iso.split('-');
        const map = {DD: d, TT: d, MM: m, YYYY: y, JJJJ: y};
        return String(fmt).replace(/TT|DD|MM|JJJJ|YYYY/g, k => map[k]);
    }

    /* A control that states its own date format outranks the persona's locale.
     * A tester filling a German application with English data types 11/24/2026
     * into a field that wants 24.11.2026, and the component discards it without
     * a word — the field reads as skipped and nobody can see why. Only an
     * unambiguous, whole mask counts; anything else leaves the locale in charge. */
    const DATE_MASK = /^(TT|DD|MM|JJJJ|YYYY)([.\/-](TT|DD|MM|JJJJ|YYYY)){2}$/i;
    const FORMAT_ATTRS = ['dateformat', 'previewdateformat', 'data-date-format', 'placeholder'];

    function declaredFormat(widget, input) {
        for (const el of [widget.root, input]) {
            for (const a of (el ? FORMAT_ATTRS : [])) {
                const v = (el.getAttribute(a) || '').trim().toUpperCase();
                if (DATE_MASK.test(v)) return v;
            }
        }
        return null;
    }

    // The same day laid out to a different mask; null when the two do not line up.
    function reformatDate(value, from, to) {
        const keys = String(from).toUpperCase().match(/TT|DD|MM|JJJJ|YYYY/g) || [];
        const nums = String(value).match(/\d+/g) || [];
        if (!keys.length || keys.length !== nums.length) return null;
        const at = {};
        keys.forEach((k, i) => (at[k] = nums[i]));
        const day = at.DD || at.TT, month = at.MM, year = at.YYYY || at.JJJJ;
        if (!day || !month || !year) return null;
        return String(to).replace(/TT|DD|MM|JJJJ|YYYY/g,
            k => (k === 'MM' ? month : (k === 'YYYY' || k === 'JJJJ') ? year : day));
    }

    /* A time-only picker is a pair of spinners; its input refuses focus and is
     * written by the component, so the buttons are driven the way a person would. */
    async function fillTimeOnly(widget, hhmm) {
        const input = widget.root.querySelector('input');
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
        if (!m) return null;
        const wantH = Number(m[1]), wantM = Number(m[2]);

        const tOpen = Date.now();
        const before = new Set(ownPanels(widget));
        const wantId = linkedOverlayId(widget);
        press(input || widget.root);
        const panel = await waitFor(() => {
            const now = ownPanels(widget).filter(p => p.querySelector('[class*="time-picker"], [data-pc-section="timepicker"]'));
            return (wantId && now.find(p => p.id === wantId)) || now.find(p => !before.has(p)) || null;
        }, 900);
        if (!panel) return null;

        const group = (kind) => panel.querySelector(`[class*="${kind}-picker"], [data-pc-section="${kind}picker"]`);
        const readNum = (g) => {
            const span = g && [...g.querySelectorAll('span, div')].find(e => /^\d{1,2}$/.test(textOf(e)));
            return span ? Number(textOf(span)) : null;
        };
        const spin = async (g, want, wrap) => {
            if (!g) return false;
            const buttons = g.querySelectorAll('button');
            if (buttons.length < 2) return false;
            const up = buttons[0], down = buttons[buttons.length - 1];
            const start = readNum(g);
            if (start == null) return false;
            if (start === want) return true;
            // The whole distance in one burst, the shorter way round; the spinner updates synchronously.
            const upDist = (want - start + wrap) % wrap;
            const downDist = (start - want + wrap) % wrap;
            const useUp = upDist <= downDist;
            for (let i = 0, n = useUp ? upDist : downDist; i < n; i++) press(useUp ? up : down);
            await settle(() => readNum(g) === want, 200);
            // A component that debounced the burst is finished off one step at a time.
            for (let i = 0; i < wrap && readNum(g) !== want; i++) {
                const cur = readNum(g);
                if (cur == null) break;
                press(((want - cur + wrap) % wrap) <= wrap / 2 ? up : down);
                await settle(() => readNum(g) !== cur, 120);
            }
            return readNum(g) === want;
        };

        const msOpen = Date.now() - tOpen;
        const tSpin = Date.now();
        await spin(group('hour'), wantH, 24);
        await spin(group('minute'), wantM, 60);
        const msSpin = Date.now() - tSpin;
        const tClose = Date.now();

        /* Click away, never Escape — it cancels the edit. Waiting for the value
         * is not the same as waiting for the panel: a form with five opening-hour
         * rows ended every fill with five time panels stacked over it, because
         * each one was left for the end-of-fill sweep to find and the sweep gets
         * three presses for the lot. A control closes its own panel. */
        press(neutralSpot(widget.root));
        await settle(() => String(input && input.value || '') !== '', 450);
        await dismissPanel(widget, {keepTypedValue: true});
        choiceTimings.push({id: 'timeonly', open: msOpen, hunt: msSpin, pick: 0, close: Date.now() - tClose});
        return (input && input.value) || null;
    }

    async function typeDate(widget, input, text) {
        const v = typeInto(input, String(text));
        input.dispatchEvent(new Event('change', {bubbles: true}));
        await dismissPanel(widget, {keepTypedValue: true});
        await settle(() => String(input.value || '') !== '', 220);
        return input.value || null;
    }

    async function fillDate(widget, value, ctx) {
        const input = widget.root.querySelector(widget.lib.input || 'input');
        const locale = (ctx.persona && ctx.persona.dateFormat) || 'YYYY-MM-DD';
        const fmt = declaredFormat(widget, input) || locale;
        // A model can answer in ISO; the control wants a shape it recognises.
        if (ISO_DATE.test(String(value || ''))) value = localDate(String(value), fmt);
        else if (fmt !== locale.toUpperCase()) value = reformatDate(value, locale, fmt) || value;

        if (CLOCK.test(String(value || '')) && input) {
            const viaPanel = await fillTimeOnly(widget, value);
            if (viaPanel) return viaPanel;
            const typed = await typeDate(widget, input, value);
            if (typed) return typed;
        }

        // A specific date (a birth date) is typed; the panel opens on today and prefers the future.
        if (ctx.typeFirst && input && !input.readOnly && value) {
            const typed = await typeDate(widget, input, value);
            if (typed) return typed;
        }

        /* Clicking a cell is format-independent, so try the panel first. It is
         * found by whose it is, not by what it shows: a picker scoped to years
         * never renders a day, and waiting for one spent the whole budget before
         * falling back to typing. */
        const opened = (p) => safeQuery(p, 'td, [class*="day"], [class*="month"], [class*="year"]').some(visible);
        const before = new Set([...safeQuery(document, PANEL_SELECTOR).filter(visible), ...ownPanels(widget)]);
        const findPanel = () => {
            const mine = ownPanels(widget).filter(opened);
            const fresh = mine.find(p => !before.has(p));
            if (fresh) return fresh;
            if (mine.length && !before.size) return mine[0];
            return safeQuery(document, PANEL_SELECTOR)
                .filter(p => visible(p) && opened(p))
                .find(p => !before.has(p)) || null;
        };
        const openPanel = async () => {
            press(input && !input.readOnly ? input : widget.root);
            return await waitFor(findPanel, 700);
        };
        let panel = await openPanel();
        /* A press that lands while another panel is on screen can be spent
         * closing that one instead — including this picker's own, left over from
         * the fill before, which toggles shut rather than open. One more press on
         * a quiet page is the difference between a date and an empty field. A
         * control still saying it is closed declined the press outright: its
         * panel is not going to appear, and a second wait buys nothing. */
        if (!panel && before.size && input && input.getAttribute('aria-expanded') !== 'false') {
            panel = await openPanel();
        }

        if (panel) {
            /* One node per day. The selectors match a `td` and the span inside
             * it, which is the same choice twice — and a library binds its click
             * to the inner one, so pressing the outer did nothing. A pool of both
             * left every second date field empty, at random. */
            const off = (c) => c.getAttribute('aria-disabled') === 'true' || c.classList.contains('p-disabled');
            const enabledCells = () => {
                const all = safeQuery(panel, 'td:not([class*="other-month"]) span, td:not(.p-datepicker-other-month), [class*="day-cell"]:not([class*="other-month"]), [class*="cell"]:not([class*="other"])')
                    .filter(c => visible(c) && /^\d{1,2}$/.test(textOf(c))
                        && !off(c) && !(c.parentElement && off(c.parentElement)));
                return all.filter(c => !all.some(other => other !== c && c.contains(other)));
            };
            let cells = enabledCells();
            // Only a day grid is worth paging through; a year or month grid has no next month.
            const dayGrid = cells.length > 0 || !!panel.querySelector('td');
            // A constrained picker can open on a month with nothing selectable: step forward.
            for (let hop = 0; dayGrid && !cells.length && hop < 3; hop++) {
                const next = panel.querySelector('[class*="next"], [aria-label*="Next"], [aria-label*="Nächst"]');
                if (!next) break;
                press(next);
                await settle(() => enabledCells().length > 0, 400);
                cells = enabledCells();
            }
            // A picker scoped to years or months offers a coarse grid instead of days.
            if (!cells.length) {
                const wantYear = /^\d{4}$/.test(String(value || '')) ? String(value) : null;
                let coarse = safeQuery(panel, 'span, button, td, div')
                    .filter(c => visible(c) && !c.querySelector('span, button, td') &&
                        /^([A-Za-zÄÖÜäöü]{3,12}|\d{4})$/.test(textOf(c)) &&
                        !(c.getAttribute('aria-disabled') === 'true' || c.classList.contains('p-disabled')));
                if (wantYear) {
                    const exact = coarse.find(c => textOf(c) === wantYear);
                    if (exact) coarse = [exact];
                }
                if (coarse.length) {
                    press(coarse[Math.floor(ctx.rng() * coarse.length)] || coarse[0]);
                    const el2 = widget.root.querySelector('input');
                    await settle(() => el2 && el2.value, 300);
                    // A year view may then ask for a month, and a month view for a day.
                    for (let step = 0; step < 2 && el2 && !el2.value; step++) {
                        const next = safeQuery(panel, 'td span, [class*="day-cell"], [class*="month"]')
                            .filter(c => visible(c) && !c.classList.contains('p-disabled'));
                        if (!next.length) break;
                        press(next[Math.floor(ctx.rng() * next.length)]);
                        await settle(() => el2 && el2.value, 300);
                    }
                    await dismissPanel(widget, {keepTypedValue: true});
                    if (el2 && el2.value) return el2.value;
                }
            }
            if (cells.length) {
                // Today or later, since many pickers disable the past; each end of a range takes its own half.
                const todayIdx = cells.findIndex(c => /today/.test(c.className) || /today/.test(c.parentElement?.className || ''));
                let pool = todayIdx >= 0 ? cells.slice(todayIdx) : cells;
                const caption = labelFor(widget);
                const role = /\b(end|return|to|until|bis|rückgabe|ende)\b/i.test(caption) ? 'end'
                    : /\b(start|from|rental|von|beginn|ausleihe)\b/i.test(caption) ? 'start' : '';
                if (role && pool.length > 3) {
                    const half = Math.floor(pool.length / 2);
                    pool = role === 'end' ? pool.slice(half) : pool.slice(0, half);
                }
                const target = pool[Math.floor(ctx.rng() * pool.length)] || pool[0];
                press(target);
                const el = widget.root.querySelector('input');
                await settle(() => el && el.value, 250);
                if (el && el.value) {
                    await dismissPanel(widget);
                    return el.value;
                }
            }
            await dismissPanel(widget);
        }

        // Fall back to typing, in whatever shape the control asked for.
        if (input && !input.readOnly) {
            const persona = ctx.persona || {};
            const fallback = persona.futureDate ? localDate(persona.futureDate, fmt) : (persona.futureDateLocal || '');
            return await typeDate(widget, input, value || fallback);
        }
        return null;
    }

    // ------------------------------------------------------------------- text ----
    async function fillText(widget, value) {
        const input = widget.root.querySelector(widget.lib.input || 'input, textarea, [contenteditable]');
        if (!input) return null;
        const v = Array.isArray(value) ? value[0] : value;
        if (v == null || String(v) === '') return null;      // "null" is not test data

        // An editor keeps what it can model and drops the rest, so what it kept is read back, not what was sent.
        if (input.isContentEditable) return await typeIntoRich(input, v);

        const written = typeInto(input, v);

        commit(input);
        await settle(() => String(input.value || '') !== '', 180);
        if (!input.value) {
            // Second attempt through the native setter, then commit again.
            setNativeValue(input, String(v));
            input.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                composed: true,
                data: String(v),
                inputType: 'insertText'
            }));
            commit(input);
            await settle(() => String(input.value || '') !== '', 180);
        }
        return input.value || written || null;
    }

    // --------------------------------------------------------------- dispatch ----
    async function fill(widget, value, ctx) {
        /* Every choice made below comes from the persona's RNG, so a seed
         * reproduces the whole fill. The default belongs here and nowhere else:
         * a direct call from a test harness need not carry one, and the
         * alternative is the same silent fallback written out five times. */
        ctx = Object.assign({rng: Math.random}, ctx);
        try {
            switch (widget.kind) {
                case 'choice':
                    return await fillChoice(widget, value, ctx, false);
                case 'multichoice':
                    return await fillChoice(widget, value, ctx, true);
                case 'inline-choice':
                    return await fillInlineChoice(widget, value, ctx);
                case 'autocomplete':
                    return await fillAutocomplete(widget, value, ctx);
                case 'date':
                    return await fillDate(widget, value, ctx);
                case 'bool':
                    return await fillBool(widget, value, ctx);
                case 'radio':
                    return await fillBool(widget, value === undefined ? true : value, ctx);
                case 'radio-group':
                    return await fillRadioGroup(widget, value, ctx);
                default:
                    return await fillText(widget, value);
            }
        } catch (err) {
            note(`${widget.id}: threw while being driven — ${err && err.message || err}`);
            return null;
        }
    }

    // Diagnosis for a choice or date widget: does it open, and what does it offer?
    async function probe(widget) {
        const out = {
            id: widget.id,
            kind: widget.kind,
            before: displayedValue(widget),
            opened: false,
            overlay: null,
            options: [],
            count: 0
        };
        if (widget.kind === 'date') {
            const input = widget.root.querySelector('input');
            out.readOnly = !!(input && input.readOnly);
            out.value = input ? input.value : '';
            press(input && !input.readOnly ? input : widget.root);
            const panel = await waitFor(() => ownPanels(widget).find(p => p.querySelector('td, [class*="day"]')), 1200);
            out.opened = !!panel;
            if (panel) {
                const all = safeQuery(panel, 'td span, [class*="day-cell"]').filter(c => /^\d{1,2}$/.test(textOf(c)));
                const on = all.filter(c => !(c.getAttribute('aria-disabled') === 'true'
                    || c.classList.contains('p-disabled')
                    || (c.parentElement && c.parentElement.classList.contains('p-disabled'))));
                out.count = on.length;
                out.options = [`${on.length} of ${all.length} days selectable`];
                const title = panel.querySelector('[class*="title"], [class*="month"]');
                out.overlay = title ? textOf(title).slice(0, 40) : 'panel';
            }
            await dismissPanel(widget);
            return out;
        }
        if (!['choice', 'multichoice', 'autocomplete'].includes(widget.kind)) return out;
        let overlay = null;
        try {
            overlay = await openOverlay(widget);
        } catch (e) {
            out.error = String(e.message || e);
        }
        out.opened = !!overlay;
        if (overlay) {
            out.overlay = (overlay.className || overlay.tagName || '').toString().slice(0, 70);
            const opts = optionsIn(overlay, widget.lib);
            out.count = opts.length;
            out.options = opts.slice(0, 8).map(o => textOf(o));
            const sc = scrollerFor(overlay);
            out.scroller = sc ? {
                cls: (sc.className || sc.tagName || '').toString().slice(0, 60),
                clientHeight: sc.clientHeight, scrollHeight: sc.scrollHeight
            } : null;
            if (sc) {
                const wasTop = sc.scrollTop;
                const seenTexts = new Set(opts.map(o => textOf(o)));
                const step = Math.max(80, Math.floor(sc.clientHeight * 0.85));
                for (let i = 0; i < 25; i++) {
                    const was = sc.scrollTop;
                    sc.scrollTop = was + step;
                    sc.dispatchEvent(new Event('scroll', {bubbles: true}));
                    await sleep(80);
                    optionsIn(overlay, widget.lib).forEach(o => seenTexts.add(textOf(o)));
                    if (sc.scrollTop <= was) break;
                }
                out.afterScroll = seenTexts.size;
                out.sample = [...seenTexts].slice(-6);
                out.overlayStillInDom = document.contains(overlay);
                sc.scrollTop = wasTop;
            }
            try {
                await closeOverlay(widget);
            } catch (_) {
            }
        }
        return out;
    }

    globalThis.FormForgeWidgets = {
        detect, claimed, labelFor, displayedValue, fill, probe,
        takeChoiceTimings: () => choiceTimings.splice(0, choiceTimings.length),
        // content.js reaches the dom layer through this bundle; anything it needs must be listed here.
        helpers: {
            press, key, typeInto, typeIntoRich, clearRich, plainText, setNativeValue, commit, sleep, waitFor, settle,
            visible, textOf, norm, optionsIn, note, takeNotes, neutralSpot, PLACEHOLDER
        }
    };
})();
