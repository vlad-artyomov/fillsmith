/* The conversation with the model, and nothing else.
 *
 * It lives apart from the fill because it is the one part of the page that has
 * a life of its own: a session that outlives the fill that started it, a
 * request nobody is waiting for any more, batches that land after the form is
 * already complete. The fill reads the outcome off `S` and never waits on it.
 */
(function () {
    'use strict';

    const H = globalThis.FormForgeWidgets.helpers;
    const {textOf, RICH_KINDS} = globalThis.FormForgeCollect;
    const {readable} = globalThis.FormForgeGen;
    const {progress} = globalThis.FormForgeHud;

    const S = {
        modelWarm: false,
        modelCalls: 0,
        modelSettings: {},
        modelTimedOut: false,
        modelDebug: null,
        modelVia: '',
        modelError: '',
        modelWarming: false,
        modelWarmingMs: 0,
        modelLoading: false,
        modelRequestMs: 0,
        warmProbe: null,
        // Set while a fill is doing nothing but wait for the model; see abandon().
        abandon: null,
        // When the wait for a session began, for the clock on the card.
        loadingSince: 0,
        modelBatch: null,
        waiters: []
    };

    // ---------------------------------------------------------------- model ----
    /* Budgets. The first call after a browser start also pays for bringing the
     * model into memory, so it is budgeted separately (SESSION_ALLOWANCE_MS) from
     * patience with the model's answer (modelBudget). Later passes in one fill
     * get half the window, and there are at most two of them. */
    /* Bringing the model into memory takes as long as it takes — twenty-eight
     * seconds, measured, on a cold one. That is not a wait to put in front of
     * somebody who has just pressed Fill for the first time, so the allowance is
     * a grace on top of the work the fill is doing anyway, not the model's whole
     * cold start: a session that comes up while the form is being written costs
     * nothing, and one that does not is left to finish in the background, ready
     * for the fill after this one. A first fill without the model is a form
     * filled from the rules; a first fill that hangs is an uninstall. */
    /* One window for the whole request, inside which bringing a session up and
     * answering the prompt share the time as it falls out. They used to be
     * budgeted apart and then added, which took three lines to explain and came
     * to seventy seconds of card for a big ask on a cold model — while a small
     * ask got twenty-five plus six against a cold create measured at
     * twenty-eight, and so lost by three seconds every time.
     *
     * Longer than that measurement on purpose. The form is complete in eighty
     * milliseconds either way, so the window costs nothing but the card staying
     * up; it says what it is waiting for, and a second press cuts it short. */
    const REQUEST_WINDOW_MS = 45000;
    const LATER_PASS_SHARE = 0.5;

    /* Answers arriving mid-request: the worker sends each batch as it lands, and
     * whoever is waiting on a field is woken by it rather than by the whole
     * request finishing. */

    function wake() {
        const w = S.waiters;
        S.waiters = [];
        for (const r of w) r();
    }

    function modelBudget(n, settings) {
        const override = Number(settings && settings.modelTimeout) || 0;
        if (override > 0) return override * 1000;
        /* Measured against Gemini Nano: a batch of twelve answers in four to eight
         * seconds, and the batches of one request run one after another, because
         * one session answers one prompt at a time. A ceiling of twelve seconds
         * was therefore below the work on any form of more than two batches: a
         * form of twenty-eight fields needs about eighteen, so its last batch was
         * cut off on every fill, for ever, and the fields it held went to the
         * filler — twenty-four of twenty-eight, three runs out of three.
         *
         * Nothing blocks on this window. The form is complete before it opens, so
         * a longer one costs a better answer arriving later, never a wait. */
        /* The slope was read off big batches, and it undercounts a small one:
         * most of a request is fixed cost, not per-field work. Asked about two
         * fields the window came to 2.7s, and a warm model answered two fields in
         * anything from 2.0s to 3.3s — so a third of those fills threw away an
         * answer that was on its way. The floor costs nothing: the form is
         * complete before the window opens. */
        /* What one prompt may take, not what the fill will wait: the window
         * above is the patience, and this only stops a single wedged batch
         * holding the one session for the whole of it. */
        return Math.min(45000, Math.max(6000, 1500 + 600 * n));
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

    /* One record per request, and a fill can make more than one: the form's own
     * fields first, then whatever an upload or a switch revealed. Keeping only
     * the last one left the Debug tab showing the second prompt and no trace of
     * the first — which is the half that explains most of the form. The session
     * and the page context belong to the fill, not to the request, so the first
     * answer for them stands. */
    function mergeDebug(before, next) {
        if (!before) return next;
        if (!next) return before;
        return Object.assign({}, before, next, {
            at: before.at,
            sessionMs: before.sessionMs != null ? before.sessionMs : next.sessionMs,
            context: before.context || next.context,
            examples: before.examples && before.examples.length ? before.examples : next.examples,
            batches: (before.batches || []).concat(next.batches || []),
            pending: !!next.pending
        });
    }

    /* Ask the model about the fields nothing local could answer. Always bounded:
     * whatever has not answered by the deadline is filled by the rules. */
    async function askModel(unresolved, persona) {
        if (!unresolved.length) return {};
        const payload = {
            persona: {
                fullName: persona.fullName, email: persona.email, company: persona.company,
                city: persona.city, country: persona.country, jobTitle: persona.jobTitle,
                locale: persona.locale, language: persona.language, seed: persona.seed
            },
            pageTitle: document.title.slice(0, 120),
            context: pageContext(unresolved[0] && unresolved[0].el),
            examples: nearbyExamples(),
            // The field's whole contract, so the answer arrives inside it rather than being clipped.
            fields: unresolved.map(f => ({
                id: f.idx,
                /* The name as a person would read it. Only fields no rule claimed
                 * reach the model, and those are the ones whose names are worst. */
                label: readable(f.label).slice(0, 140),
                section: f.section.slice(0, 60),
                required: f.required || undefined,
                placeholder: f.placeholder || undefined,
                min: f.min != null ? f.min : undefined,
                max: f.max != null ? f.max : undefined,
                richText: RICH_KINDS.has(f.type) || undefined,
                type: f.type,
                maxLength: f.maxLength,
                pattern: f.pattern,
                options: f.options ? f.options.map(o => o.text).slice(0, 20) : undefined
            }))
        };
        try {
            /* Whether the session is already up decides how long to wait, and the
             * answer is wanted here rather than a round trip later: run() sends
             * this probe before it reads the form, so by now it has usually come
             * back. A probe that has not is not worth blocking on. */
            if (!S.warmProbe) S.warmProbe = sendMessage({kind: 'nano-warm'});
            const warm = await Promise.race([S.warmProbe, H.sleep(120).then(() => null)]);
            /* The probe is now; modelWarm is a memory, and a session dies with
             * the worker that holds it. A page that got one answer went on
             * believing there was a model for the rest of its life, so the fill
             * after the worker had gone added no allowance for the session being
             * built in its place: the card said the AI was starting and the fill
             * ended anyway. Believe the probe; fall back on memory only when it
             * did not answer in time. */
            if (warm) S.modelWarm = !!warm.ready;
            const loading = !S.modelWarm;
            /* A timeout the tester set replaces the window; it is the whole of
             * the patience they asked for. */
            const asked = Number(S.modelSettings && S.modelSettings.modelTimeout) || 0;
            const whole = asked ? asked * 1000 : REQUEST_WINDOW_MS;
            const window = S.modelCalls === 0 ? whole : Math.round(whole * LATER_PASS_SHARE);
            S.modelCalls++;
            if (loading) {
                S.modelLoading = true;
                S.loadingSince = Date.now();
                /* Said in full, because this is the moment the promise looks
                 * broken: the form is done, nothing is happening, and the reason
                 * is a one-off cost nobody was told about. */
                progress('model', 'Starting the AI', {
                    label: 'the form is filled — the AI takes a moment the first time'
                });
            }
            payload.budgetMs = Math.min(window, modelBudget(unresolved.length, S.modelSettings));
            payload.sessionWaitMs = window;
            const tAsk = Date.now();
            /* Pressing Fill again while the last one is only waiting for the
             * model should start the new fill, not be told the page is busy.
             * The wait gives up instead; the worker keeps building, and the fill
             * that follows is the one that gets the session. */
            const dropped = new Promise(r => {
                S.abandon = () => r({ok: false, timedOut: true, abandoned: true});
            });
            const res = await Promise.race([
                chrome.runtime.sendMessage({kind: 'generate', payload}),
                dropped,
                new Promise(r => setTimeout(() => r({
                    ok: false,
                    timedOut: true
                }), window))
            ]);
            S.abandon = null;
            S.modelLoading = false;
            S.loadingSince = 0;
            S.modelRequestMs += Date.now() - tAsk;
            if (res && !res.timedOut) S.modelWarm = true;
            if (res && res.debug) S.modelDebug = mergeDebug(S.modelDebug, res.debug);
            if (res && res.via) S.modelVia = res.via;
            if (res && res.error) S.modelError = String(res.error);
            S.modelWarming = !!(res && res.warming);
            S.modelWarmingMs = (res && res.warmingMs) || 0;
            if (res && res.timedOut) {
                S.modelTimedOut = true;
                // The worker keeps generating; the popup collects the late answer for the Debug tab.
                S.modelDebug = S.modelDebug || {
                    at: tAsk, asked: unresolved.length, waitedMs: Date.now() - tAsk,
                    note: `gave up after ${Date.now() - tAsk}ms of a ${window}ms window`,
                    batches: [], pending: true
                };
            }
            return (res && res.ok && res.values) ? res.values : {};
        } catch (err) {
            H.note(`the model could not be reached — ${err && err.message || err}`);
            return {};
        }
    }

    globalThis.FormForgeModel = Object.assign(S, {
        wake, modelBudget, pageContext, nearbyExamples, sendMessage, mergeDebug, askModel
    });
})();
