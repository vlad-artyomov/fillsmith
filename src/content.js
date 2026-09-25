/* Fillsmith — page scanner and filler.
 *
 * Finds every fillable control (native inputs and component-library widgets),
 * decides a value for each — rule, type default, model, fallback — writes them
 * in DOM order, and then checks the page actually kept them.
 */
(function () {
    'use strict';

    const G = globalThis.FillsmithGen;
    const W = globalThis.FillsmithWidgets;
    const O = globalThis.FillsmithOverlays;
    const U = globalThis.FillsmithUploads;
    const Hud = globalThis.FillsmithHud;
    const H = W.helpers;
    const M = globalThis.FillsmithModel;
    /* Its state is read off the object, because the model outlives the fill
     * that started it: a session built for one press answers the next. */
    const {wake, modelBudget, pageContext, nearbyExamples, sendMessage, mergeDebug, askModel} = M;
    const C = globalThis.FillsmithCollect;
    /* The page-reading layer, pulled in by name so the call sites below read the
     * same as when it lived here. */
    const {
        MARK, SKIP_TYPES, INLINE_OPTIONS, CAPTCHA, APP_CHROME, FIXED_LENGTH, RICH_KINDS,
        isVisible, textOf, describe, limitsOf, sectionOf, inDomOrder,
        popupSurfaces, modalScope, collectFields,
        captionOf, fieldKey, baseKey, captionKey, ruleName, alreadyWritten,
        hasSelection, complaintFor, askedMaxChars, currentValue
    } = C;
    const {progress, toast, ping} = Hud;

    /* Every frame on the page runs this file. A subframe with nothing to fill or
     * clear has nothing to report either: its "cleared 0 fields" otherwise lands
     * in the popup on top of the frame that just cleared forty. */
    const SUBFRAME = (() => {
        try {
            return window.top !== window;
        } catch (_) {
            return true;                 // cross-origin: not the top frame
        }
    })();

    const CHOICE_KINDS = new Set(['choice', 'multichoice', 'inline-choice', 'autocomplete', 'radio', 'radio-group', 'select']);
    /* Two states, and no options for a string to be matched against. */
    const BOOL_KINDS = new Set(['bool', 'checkbox']);
    /* What tells a laid-out answer from prose. Inline tags do not: the model
     * wrapped a whole release note in <em> once, and taken as markup it went in
     * as one italic run, which is the same flat answer with a slant on it. */
    const BLOCK_MARKUP = /<(?:p|div|ul|ol|li|h[1-6]|br|table|blockquote|pre)\b/i;
    // Their options are in the page, not behind a popup, so they can be read at collect time.
    // Page chrome that happens to be a form control: filling a language switcher rewrites every label mid-run.
    /* Choices whose candidate is a real-world fact an application's list may
     * hold — a country, a city, a salutation. Only these are worth filtering and
     * scrolling for; an invented company name is in nobody's list. */
    const REAL_WORLD_CHOICE = /countrylist|countrycode|phonecountry|\b(country|land|staat|city|stadt|ort|state|region|bundesland|province|salutation|anrede|gender|geschlecht|language|sprache|currency|währung)\b/i;
    const TIME_FIELD = /\b(time|uhrzeit|zeit)\b/i;
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

    let rng = Math.random;             // replaced by the persona's RNG at fill time

    // ----------------------------------------------------------- resolution ----
    /* Decide a value locally: rule, then type default. Returns null when only
     * the model or the fallback can answer. The section is deliberately not
     * matched — a legend like "Registered address" would win the address rule
     * for every field inside it. */
    function resolveLocally(f, persona) {
        const hit = G.matchRuleDetail(`${f.label} ${f.autocomplete}`, persona);
        /* A bool has two values and the seed picks one. A rule that matched its
         * name has nothing to say about which: a toggle named
         * `isBillingAddressEnabled` matched the street rule, and its state came
         * out of "8913 Park Avenue" while the report said a rule had decided it.
         * A list is different — there a string is matched against real options. */
        const usable = hit && !(BOOL_KINDS.has(f.type) && typeof hit.value === 'string');
        if (usable) {
            f.matchedRule = hit.pattern;
            if (hit.weak) f.weakRule = true;
        }
        let value = usable ? hit.value : null;
        if (value != null && value !== '') {
            // A rich-text control wants markup even when a prose rule matched it.
            if (f.type === 'richtext' && typeof value === 'string' && !/^\s*</.test(value)) {
                return {value: G.richLayout('', persona, fieldKey(f)), source: 'rule'};
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
            /* Its own text and its own shape. One page carried five editors and
             * every one of them held the same bold "Note:" over the same list. */
            if (f.type === 'richtext') return {value: G.richLayout('', persona, fieldKey(f)), source: 'type'};
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
    const readableList = (f) => CHOICE_KINDS.has(f.type) && !!(f.options && f.options.length)
        && !REAL_WORLD_CHOICE.test(`${f.label} ${f.autocomplete || ''}`);
    /* Worth asking the model about. Module scope, because one field and a whole
     * form have to ask the same question of the same field: filled from the
     * shortcut, a box whose rule is a weak one used to keep the rule, and filled
     * with the rest of its form it got the model's answer instead. */
    const worthAsking = (f) => {
        /* The file is generated in the page from the seed, to match the input's
         * own `accept`. Asked anyway, the model replied "image1.jpeg" and
         * "Technical specifications.pdf" — two slots in a batch of twelve,
         * spent on names nothing reads. */
        if (f.type === 'file') return false;
        if (f.type === 'bool' || f.type === 'checkbox') return false;
        if (CHOICE_KINDS.has(f.type)) return !!(f.options && f.options.length) && !readableList(f);
        return true;
    };
    // A weak rule is a guess the model can better; a strong one it cannot.
    const worthImproving = (f) => f.weakRule && !readableList(f);

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
    /* An upload is the one thing a fill starts and does not finish. The row that
     * comes back with it — the file's caption, its alt text, its "show this one"
     * switch — is a field this fill caused, so the fill waits for it. The deadline
     * runs from the attach, as the model's does from its request: a form with
     * plenty left to do pays nothing for this. */
    const UPLOAD_PATIENCE_MS = 5000;
    /* Only this fill's uploads. Each entry holds the zone the row is expected in,
     * and an entry that outlives its fill keeps a node the framework has since
     * replaced from being collected: on an SPA every fill added a few. */
    let uploads = [];
    const UPLOAD_ZONE = 'fieldset, section, .field, .p-field, .form-group, [class*="field"], [class*="upload"]';
    const controlsIn = (zone) => {
        try {
            return zone.querySelectorAll('input, textarea, select, [contenteditable]').length;
        } catch (_) {
            return 0;
        }
    };

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
                if (names) {
                    filesAttached.add(fieldKey(f));
                    /* Only a control that took the files off us can be uploading them:
                     * a dropzone empties its input, a plain <input type="file"> does
                     * not. Without that test every form with a file field paid the
                     * whole patience for a row that was never coming. */
                    const zone = el.closest(UPLOAD_ZONE) || el.parentElement;
                    const taken = !el.files || el.files.length === 0;
                    if (zone && taken) uploads.push({
                        zone,
                        before: controlsIn(zone),
                        until: Date.now() + UPLOAD_PATIENCE_MS
                    });
                }
                return names;
            }

            if (f.type === 'contenteditable') return await H.typeIntoRich(el, String(value));

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
    const TOUCH = 'data-fillsmith-touch';
    const touchTimers = new WeakMap();

    function touchStyle() {
        if (document.getElementById('fillsmith-touch-style')) return;
        const style = document.createElement('style');
        style.id = 'fillsmith-touch-style';
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

    // ------------------------------------------------------------------ run ----
    async function run(settings) {
        M.beginRequest(settings);
        globalThis.__fillsmithRuns = (globalThis.__fillsmithRuns || 0) + 1;   // observable double-injection
        filesAttached.clear();
        uploads = [];
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
        /* And the ownership marks. `data-fillsmith-opened` says "ours, and possibly
         * still up"; one left over from a previous fill makes the scan read a
         * settled part of the page as a popup's own furniture and skip the fields
         * in it. Anything genuinely on screen is picked up by panelsBefore below,
         * which is the right way to call it not ours. */
        document.querySelectorAll('[data-fillsmith-opened]')
            .forEach(el => el.removeAttribute('data-fillsmith-opened'));

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
            Hud.withdraw();
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
        /* Worth asking about: a field the model can actually improve. A bool has
         * two values and the seed picks one — asking a language model to say
         * "true" spends a slot in the batch, and asked about seven of them it
         * answered "true" seven times, where the seed exercises both branches. A
         * choice is worth a question only when we can show it the list; asked
         * blind it invents, and the filler discards the invention and picks a
         * valid option anyway. Both were being asked, and the answers thrown
         * away, on every fill. */
        /* A list we can already read is a list we can already choose from. The
         * model adds nothing to "01…12" or "Visa, Master Card, American Express,
         * Discover" — it is being told what the page already says, and every one
         * asked costs a slot in a batch and a share of the deadline. It earns a
         * question only where the right option follows from the persona and no
         * rule has said which one: a country, a salutation, a language. */
        // A weak rule on such a list is not worth a question either: the control decides between them.
        const askAbout = unresolved.filter(worthAsking).concat(weakly.filter(worthImproving));
        /* Every field asked, over every request in the fill. The first request's
         * count alone was reported as the denominator while aiUsed counted the
         * answers from all of them, so a fill that asked again about what an
         * upload revealed read "answered 14 of 10". */
        let askedCount = askAbout.length;
        /* The rest of the unresolved decide for themselves, out of what the
         * control offers. That is a decision and the report says so: left to fall
         * through, a toggle the seed set on purpose was listed as a fallback with
         * "the model had no answer for it", which is both untrue and the wrong
         * thing to go looking at when a fill comes out wrong. */
        for (const f of unresolved) {
            if (!worthAsking(f) && picksItsOwn(f)) plan.set(f.idx, {value: null, source: 'choice'});
        }
        const awaiting = new Set(askAbout.map(f => f.idx));

        /* The model is asked, not waited for. Every field a rule already answered
         * is written while the request is in flight, so the form starts filling
         * at once instead of after the model; a field the model owns is written
         * the moment its answer lands, and whatever is still outstanding when the
         * pass ends is collected afterwards — on the same deadline, which runs
         * from the request, so overlapping shortens the fill and never extends
         * the patience the setting promises. */
        const answers = {};                 // grows as each batch lands
        let modelSettled = false;           // the whole request is done, right or wrong
        let pending = null;
        let modelAsked = false;
        let aiUsed = 0;
        M.modelBatch = (values, via) => {
            Object.assign(answers, values || {});
            if (via && !M.modelVia) M.modelVia = via;      // a request that runs out of time never returns one
            wake();
        };
        if (settings.useAI !== false && askAbout.length) {
            modelAsked = true;
            progress('model', `Asking the model about ${askAbout.length} field${askAbout.length === 1 ? '' : 's'}`);
            pending = askModel(askAbout, persona).then(v => {
                Object.assign(answers, v || {});
                modelSettled = true;
                wake();
            });
        }

        const modelAnswer = (f) => {
            const v = answers[String(f.idx)] ?? answers[f.idx];
            if (v == null || String(v).trim() === '') return null;
            /* Prose into a rich-text field is a worse answer than the one it
             * replaces: what such a control is worth testing is what its editor
             * does with bold, italic and a list. The model's words go into the
             * shape the rule would have built, so the words are its and the
             * markup is ours. */
            if (RICH_KINDS.has(f.type) && !BLOCK_MARKUP.test(String(v))) {
                return G.richLayout(H.plainText(String(v)), persona, fieldKey(f));
            }
            return v;
        };
        // Why a field ended up on the filler, in the words of whatever went wrong.
        const whyFallback = (f) => f.matchedRule ? 'a rule matched but produced nothing'
            : settings.useAI === false ? 'no rule matched; the model was switched off'
                : M.modelWarming ? 'no rule matched; the model was still loading'
                    : M.modelTimedOut ? 'no rule matched; the model ran out of time'
                        : M.modelError ? `no rule matched; the model answered with an error: ${M.modelError.slice(0, 120)}`
                            : modelAsked ? 'no rule matched; the model had no answer for it'
                                : 'no rule matched; the model was not available';
        /* What to write, decided as late as possible: the model's answer if it
         * has arrived, the rule underneath it if not, and the filler otherwise. */
        const entryFor = (f) => {
            const fromModel = modelAnswer(f);
            if (fromModel != null) return {value: fromModel, source: 'ai'};
            if (plan.has(f.idx)) return plan.get(f.idx);
            /* A file is not something anything fell back to: the bytes are made in
             * the page from the seed, to match the input's own accept. Reported as
             * a fallback it read as "nothing better was available", and sent the
             * reader of a half-filled form looking in the wrong place. */
            if (f.type === 'file') return {value: null, source: 'type'};
            f.whyFallback = whyFallback(f);
            return {value: picksItsOwn(f) ? null : G.fallbackText(f, persona), source: 'fallback'};
        };

        // First pass: sequential and awaited. Widgets open and close overlays; dependent dropdowns need order.
        progress('fill', 'Filling the form', {done: 0, total: fields.length});
        const tFirst = Date.now();
        const filled = [];
        const skipped = [];
        const wrote = [];
        /* A field can be written twice: once with what was available, and again
         * when the model's answer catches up. The second write replaces the first
         * everywhere it was recorded rather than appearing beside it. */
        const seatOf = new Map();
        const wroteAt = new Map();
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
            // `seat` is the row in `filled` this write reports to; a later repair updates that row and no other.
            const was = seatOf.get(f.idx);
            const commit = {
                f,
                key: fieldKey(f),
                caption: captionKey(f),
                value: entry.value == null ? String(written) : entry.value,
                seat: was == null ? filled.length : was
            };
            if (was == null) {
                seatOf.set(f.idx, filled.length);
                wroteAt.set(f.idx, wrote.length);
                wrote.push(commit);
                if (f.kind === 'widget') widgetCount++;
            } else {
                wrote[wroteAt.get(f.idx)] = commit;
            }
            if (entry.source === 'ai') aiUsed++;
            flash(f.el, entry.source !== 'fallback');
            const row = {
                label: captionOf(f),
                value: String(written).slice(0, 60),
                source: f.kind === 'widget' ? `${entry.source}/${f.lib}` : entry.source,
                why: entry.source === 'rule' ? `matched the ${ruleName(f.matchedRule)} rule`
                    : entry.source === 'type' ? `the control is a ${f.type}`
                        : entry.source === 'ai' ? 'the model answered'
                            : (f.whyFallback || 'nothing else produced a value'),
                rule: entry.source === 'rule' ? String(f.matchedRule || '') : '',
                type: f.type, lib: f.lib || ''
            };
            if (was == null) filled.push(row);
            else filled[was] = row;                 // the model caught up with a field already written
        }

        /* Nothing waits here. Every field is written with the best answer that
         * exists right now — a rule's, the control's own, or the filler's — so
         * the form is complete and usable before the model has said anything. */
        const owed = [];
        for (const f of fields) {
            if (pending && !modelSettled && awaiting.has(f.idx) && modelAnswer(f) == null) owed.push(f);
            await write(f, entryFor(f));
        }
        phase.firstPass = Date.now() - tFirst;

        /* Then the model catches up. Its answers replace what is already in the
         * fields as each batch lands — an upgrade, not a wait, which is the whole
         * difference between "a slow model makes the fill slow" and "a slow model
         * makes the fill less good". Waiting for the batches instead meant a
         * twelve-second fill of which twelve seconds were spent looking at a
         * finished form, and the batches that missed the deadline were thrown
         * away rather than written a moment late. */
        const tWait = Date.now();
        phase.firstLate = null;
        let upgraded = 0;
        const done = new Set();
        const catchUp = async () => {
            for (const f of owed) {
                if (done.has(f.idx)) continue;
                const v = modelAnswer(f);
                if (v == null) continue;
                done.add(f.idx);
                if (phase.firstLate == null) phase.firstLate = Date.now() - tWait;
                if (document.contains(f.el) && isVisible(f.el)) {
                    await write(f, {value: v, source: 'ai'});
                    upgraded++;
                    continue;
                }
                /* The node was replaced between the two writes — a framework
                 * re-rendering the field it had just been given a value. The repair
                 * loop already knows how to find the replacement, and it restores
                 * whatever the field was last recorded as holding, so correcting the
                 * record is what puts the model's answer into the new node. */
                const seat = wroteAt.get(f.idx);
                if (seat == null) continue;
                wrote[seat].value = v;
                const row = filled[seatOf.get(f.idx)];
                if (row) {
                    row.value = String(v).slice(0, 60);
                    row.source = f.kind === 'widget' ? `ai/${f.lib}` : 'ai';
                    row.why = 'the model answered, into the node that replaced the one written first';
                }
                aiUsed++;
                upgraded++;
            }
        };
        await catchUp();
        while (pending && !modelSettled && done.size < owed.length) {
            /* Named for what is actually happening, and counted against what it is
             * actually doing. "Improving the form" over a count of filled fields
             * read as a fill that had stalled at twelve of forty: the form was
             * finished, and the thing taking the time was the model. So the title
             * says which, the count is answers received rather than fields written,
             * and the line underneath says the form is not what is being waited
             * for. The card's shimmer does the rest — there is no pool of phrases
             * to cycle through, because every line here has to be true. */
            const left = owed.length - done.size;
            /* Coming up and answering are different waits and take different
             * times. Reported as "AI is still answering 0/5", a model that was
             * only being loaded read as a model thinking very hard about five
             * fields — the popup said "model starting" and the page did not. */
            if (M.modelLoading) {
                progress('improve', 'Starting the AI', {
                    count: `${Math.round((Date.now() - (M.loadingSince || Date.now())) / 1000)}s`,
                    label: 'the form is filled — the AI takes a moment the first time'
                });
            } else {
                progress('improve', 'AI is still answering', {
                    done: done.size, total: owed.length,
                    label: `the form is filled — ${left} field${left === 1 ? '' : 's'} still to improve`
                });
            }
            /* A clock has to tick, and which of the two waits this is can change
             * between one turn of the loop and the next: a session comes up and
             * the same wait stops being a start and becomes an answer. A batch
             * landing still wakes it at once; the second is only so the card
             * does not sit on one number for half a minute. */
            await Promise.race([new Promise(r => M.waiters.push(r)), H.sleep(1000)]);
            await catchUp();
        }
        if (pending) await pending;                 // its own deadline; the form has not waited on it
        await catchUp();                            // the settle carries the last batch with it
        phase.model = Date.now() - tWait;

        if (modelAsked) {
            ping({
                stage: 'model',
                text: `Asking the model about ${askAbout.length} field${askAbout.length === 1 ? '' : 's'}`,
                detail: M.modelWarming ? 'still loading — try again in a moment'
                    : M.modelTimedOut ? 'out of time'
                        : aiUsed ? `${aiUsed} answered`
                            : M.modelError ? `error — ${M.modelError.slice(0, 80)}`
                                : M.modelVia && M.modelVia !== 'none' ? 'answered none' : 'no model available'
            });
        }

        /* Later passes, until the form stops changing: re-write what reverted,
         * retry what wrote nothing, fill what our writes revealed (a switch that
         * renders the controls it gates). A field is identified by key, so a node
         * the framework rebuilt gets its original value back rather than a new one. */

        /* Nothing else is happening and a file we attached has not come back. On a
         * short form the fill is over in eighty milliseconds and the row lands a
         * second later, so without this the fields it brings are left for the next
         * fill to find — which is what "the metadata only appears on the second
         * run" was. Returns whether something arrived. */
        async function waitForUpload() {
            uploads = uploads.filter(u => Date.now() < u.until);
            const due = uploads.filter(u => controlsIn(u.zone) <= u.before);
            if (!due.length) return false;
            progress('repair', 'Waiting for the upload',
                {label: `${due.length} file field${due.length === 1 ? '' : 's'}`});
            const until = Math.max(...due.map(u => u.until));
            const arrived = await H.settle(() => due.some(u => controlsIn(u.zone) > u.before), until - Date.now(), 120);
            if (!arrived) H.note('an upload did not come back in time; the fields it brings were left empty');
            return arrived;
        }

        const tRevealed = Date.now();
        let revealed = 0;
        let repaired = 0;
        let lateModelCalls = 0;
        let settled = false;
        for (let pass = 0; pass < 5; pass++) {
            /* Short enough for one line of a 272px card. A title that wrapped
             * made the card a line taller for that stage alone, and the last
             * second of a fill moved it three times. The tally goes where
             * tallies go. */
            progress('repair', revealed || repaired ? 'Filling what appeared' : 'Checking the form',
                revealed || repaired ? {count: String(revealed + repaired)} : null);
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

            /* A form complains on its own schedule: the line saying "at most 30
             * characters" lands a few ticks after the value, and this pass used
             * to look for it in the same breath as the write. On a form with
             * other work to do a later pass caught it; on a dialog with one
             * field there is no later pass, and a seventy-character answer sat
             * in a thirty-character box under a red line. Only a long value is
             * worth waiting on, so a form of short ones pays nothing. */
            const risky = wrote.filter(w => !w.shortened && !CHOICE_KINDS.has(w.f.type)
                && !FIXED_LENGTH.has(w.f.type) && document.contains(w.f.el)
                && String(currentValue(w.f) || '').length > 40);
            if (risky.length) {
                await H.settle(() => risky.some(w => askedMaxChars(complaintFor(w.f))), 600, 60);
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
                /* By seat, not by caption: an uploader's rows all read "Alternative
                 * text", and the last row's entry was being marked for a value the
                 * first row holds. */
                const entry = w.seat != null ? filled[w.seat] : null;
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
                    askedCount += needModel.length;
                    const tM = Date.now();
                    Object.assign(lateAnswers, await askModel(needModel, persona));
                    phase.modelLate = (phase.modelLate || 0) + (Date.now() - tM);
                }
            }
            if (!fresh.length && !didSomething) {
                if (!await waitForUpload()) break;
                continue;
            }

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
                wrote.push({f, key, caption: captionKey(f), value, seat: filled.length});
                if (f.kind === 'widget') widgetCount++;
                flash(f.el, !!local);
                const source = local ? local.source : fromModel ? 'ai' : 'fallback';
                filled.push({
                    label: captionOf(f),
                    value: String(written).slice(0, 60),
                    source: f.kind === 'widget' ? `${source}/${f.lib}` : source,
                    why: local ? (local.source === 'rule' ? `matched the ${ruleName(f.matchedRule)} rule` : `the control is a ${f.type}`)
                        : fromModel ? 'the model answered (field appeared mid-fill)'
                            : 'appeared mid-fill; nothing else produced a value',
                    rule: local && local.source === 'rule' ? String(f.matchedRule || '') : '',
                    type: f.type, lib: f.lib || ''
                });
            }
            if (!wroteNow && !didSomething) {
                // One last look a beat later: a re-render provoked by the last write lands after the loop would give up.
                if (settled) break;
                settled = true;
                if (await waitForUpload()) settled = false;     // it arrived; there is work again
                else await H.sleep(250);
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
            const sel = `${O.PANEL_SELECTOR}, [data-fillsmith-opened]`;
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
        /* No ownership mark outlives the fill that made it. It means "ours, and
         * possibly still up", and both of its readers are inside one fill: the
         * sweep just above, and the scan that treats whatever sits under it as a
         * popup's own furniture rather than a field. Left behind — by a panel
         * closeOverlay could not shut, or one that was still mid-leave when the
         * sweep looked — it made the next fill skip real fields.
         *
         * Unconditional, and on its own: the first version of this rode inside
         * the sweep's try, where a throw from the presses above skipped it and
         * put the bug back on a slower machine. What is genuinely still open is
         * already reported in leftOpen and in the notes; the attribute is not
         * the record of that. */
        try {
            document.querySelectorAll('[data-fillsmith-opened]')
                .forEach(el => el.removeAttribute('data-fillsmith-opened'));
        } catch (_) {
        }

        phase.secondPass = Date.now() - tRevealed;
        phase.total = Date.now() - tStart;
        timings.sort((a, b) => b.ms - a.ms);
        const notes = H.takeNotes();

        /* The fill answers with everything the record needs; the worker writes it
         * once, after it has added the frames up. Written from here, every frame
         * wrote its own — a read-modify-write each, so two frames finishing
         * together lost one of them, and the Debug tab described a form that was
         * one of several on the page. */
        toast(`Filled ${filled.length} field${filled.length === 1 ? '' : 's'}`,
            {
                persona, aiUsed, filled, widgets: widgetCount, skipped, ms: phase.total, total: fields.length,
                /* The one ending that otherwise looks like the AI does not work:
                 * every field from a rule, no chip saying "from the model", and
                 * no reason given anywhere the person is looking. */
                warming: modelAsked && !aiUsed && M.modelWarming
            });
        return {
            url: location.href.slice(0, 200), title: document.title.slice(0, 80),
            fieldCount: fields.length,
            count: filled.length,
            persona: stripRng(persona),
            aiUsed,
            widgets: widgetCount,
            revealed,
            repaired,
            upgraded,
            leftOpen,
            notes,
            modelTimedOut: M.modelTimedOut,
            modelWarming: M.modelWarming,
            modelWarmingMs: M.modelWarmingMs,
            modelVia: M.modelVia,
            modelError: M.modelError,
            modelDebug: M.modelDebug,
            modelAsked,
            modelSwitchedOff: settings.useAI === false,
            modelRequestMs: M.modelRequestMs,
            unresolvedCount: askedCount,
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

        M.beginRequest(settings);
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
             * Fillsmith does not recognise, and only one of them is worth acting
             * on. Said on the page, because a fill from the keyboard or the
             * context menu has nowhere else to say it. */
            const off = el.closest('[contenteditable="false"], [disabled], [aria-disabled="true"], [class*="disabled"]');
            const why = off ? 'That field is switched off — turn it on first'
                : 'Fillsmith does not know how to fill that control';
            toast(why, {hint: true});
            return {ok: false, error: why};
        }

        /* Announced as reading, not as filling: the stages are ordered, and a
         * card already showing `fill` refuses anything earlier — which is why
         * the model coming up was never mentioned on this path. Nothing has
         * been written yet at this point either, so it is the truer word. */
        progress('read', 'Filling one field', {done: 0, total: 1, label: captionOf(f)});
        const local = resolveLocally(f, persona);
        let value = local ? local.value : null;
        let source = local ? local.source : 'fallback';
        const ask = settings.useAI !== false
            && ((value == null && worthAsking(f)) || worthImproving(f));
        if (ask) {
            /* One field has no loop to redraw the card, so the clock is wound
             * here: a frozen "Starting the AI" for the length of the window is
             * worse than no clock at all. */
            /* The same two states the whole-form card shows, said the same way:
             * a session coming up is a start, a session that is up is an answer
             * being written. */
            const say = () => (M.modelLoading
                ? progress('model', 'Starting the AI', {
                    count: `${Math.round((Date.now() - (M.loadingSince || Date.now())) / 1000)}s`,
                    label: M.waitLine({alone: true})
                })
                : progress('model', 'AI is still answering', {done: 0, total: 1, label: captionOf(f)}));
            say();                                  // at once, not a second late
            const tick = setInterval(say, 1000);
            try {
                const answers = await askModel([f], persona, {alone: true});
                const v = answers[String(f.idx)] ?? answers[f.idx];
                if (v != null && String(v).trim() !== '') {
                    value = v;
                    source = 'ai';
                }
            } finally {
                clearInterval(tick);
            }
        }
        progress('fill', 'Filling one field', {done: 0, total: 1, label: captionOf(f)});
        if (value == null) value = picksItsOwn(f) ? null : G.fallbackText(f, persona);

        const written = await applyValue(f, value, persona);
        W.takeChoiceTimings();                         // one field's timings are nobody's report; do not let them pile up
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
     * buttons do — but only the ones in a row that names a file we generated.
     * "The nearest ancestor holding any delete button" is the card the uploader
     * sits in as soon as our rows are gone, and the delete button in that card
     * belongs to the record: Clear would have deleted the location. */
    const REMOVE_FILE = [
        '.p-fileupload-file-remove-button', '[data-pc-section="pcremovebutton"]', '[data-pc-section="removebutton"]',
        'button[name="deleteFile"]', '[aria-label*="remove" i]', '[aria-label*="delete" i]', '[aria-label*="löschen" i]',
        '[aria-label*="entfernen" i]', '[title*="remove" i]', '[title*="delete" i]', '[title*="löschen" i]', '[title*="entfernen" i]'
    ].join(', ');
    /* No word boundary on either side. A tile renders the name against its
     * neighbouring labels with nothing between them — "PDFfillsmith-a1.pdf" in
     * front, "fillsmith-a1.pngGröße" behind — and a `\b` there sits between two
     * letters, so a row holding our own file did not look like one and Clear
     * left the attachment on the page. The prefix is ours; it needs no fence. */
    const OUR_FILE = /fillsmith-[a-z0-9]+(?:-\d+)?\.[a-z0-9]{2,4}/i;

    /* The row a remove button belongs to is the nearest ancestor that names one
     * of our files; a container naming one through some other row holds more
     * than this one button, and is the list, not the row. */
    function removesOurFile(button, bound) {
        for (let row = button.parentElement; row && row !== bound.parentElement; row = row.parentElement) {
            if (!OUR_FILE.test(row.textContent || '')) continue;
            return row.querySelectorAll(REMOVE_FILE).length === 1;
        }
        return false;
    }

    function removeAttached(input) {
        for (let node = input.parentElement; node && node !== document.body && node.tagName !== 'FORM'; node = node.parentElement) {
            const buttons = Array.from(node.querySelectorAll(REMOVE_FILE))
                .filter(b => !b.disabled && removesOurFile(b, node));
            if (buttons.length) {
                buttons.forEach(b => H.press(b));
                return buttons.length;
            }
        }
        return 0;
    }

    async function clearAll() {
        let n = 0;
        for (const el of document.querySelectorAll(`[${MARK}]`)) {
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
                await H.clearRich(el);
                n++;
            } else if ('value' in el) {
                H.setNativeValue(el, '');
                fire(el, ['input', 'change']);
                n++;
            } else {
                /* A library's editor is marked on the wrapper it renders, not on
                 * the surface inside it, so the branch above never sees it: the
                 * five editors of a device form were reported cleared and held
                 * their text. */
                const editable = el.querySelector('[contenteditable="true"]');
                const clear = el.querySelector('[class*="clear"], [data-pc-section="clearicon"]');
                if (editable) {
                    await H.clearRich(editable);
                    n++;
                } else if (clear) {
                    H.press(clear);
                    n++;
                }
            }
        }
        /* A file the page took off us is no longer the input's to give back, and
         * the component that took it often rebuilds the input, so the node the
         * fill marked is gone by the time Clear runs. The rows it rendered are
         * still there, naming our own files. Sweep for them by name: the same
         * test that guards a foreign attachment, asked of the whole page. */
        /* One at a time, asking again each time. Removing an attachment re-renders
         * the list, so every other button in a list taken beforehand is a node
         * that is no longer on the page: pressed, it does nothing, and four
         * attachments came off as two. */
        for (let i = 0; i < 40; i++) {
            const button = Array.from(document.querySelectorAll(REMOVE_FILE))
                .find(b => !b.disabled && removesOurFile(b, document.body));
            if (!button) break;
            H.press(button);
            n++;
            await H.sleep(0);
        }
        if (n || !SUBFRAME) toast(`Cleared ${n} fields`, null);
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
    if (globalThis.__fillsmithListening) return;
    globalThis.__fillsmithListening = true;
    let busy = false;

    // Exposed for the test suites, which call these through the content-script world.
    globalThis.__fillsmith = {
        run, fillOne, clearAll, collectFields, describe, pageContext, nearbyExamples,
        pendingUploads: () => uploads.length
    };

    // Chrome's context menu does not say which element was clicked; remember it ourselves.
    let lastContextTarget = null;
    let sawContextMenu = false;
    addEventListener('contextmenu', (e) => {
        sawContextMenu = true;
        lastContextTarget = e.target;
    }, true);

    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

    function exclusive(job, respond) {
        /* A fill that is only waiting for the model is not doing anything the
         * next press should queue behind: the form it wrote is finished. It is
         * cut short instead, and the press that cut it goes ahead. */
        if (busy && M.abandon) {
            M.abandon();
            waitFree().then(() => exclusive(job, respond));
            return true;
        }
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

    // Up to a second for the abandoned fill to let go; longer than it needs.
    const waitFree = () => H.waitFor(() => !busy, 1000, 20);

    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
        // "Are you there?" — the worker's way of telling a live frame from one whose script died with an update.
        if (msg.kind === 'ping') {
            respond({ok: true, busy});
            return false;
        }
        if (msg.kind === 'fill') return exclusive(async () => ({ok: true, ...(await run(msg.settings || {}))}), respond);
        if (msg.kind === 'fill-one') return exclusive(() => fillOne(msg.settings || {}, {focusFirst: !!msg.focusFirst}), respond);
        if (msg.kind === 'clear') return exclusive(async () => ({ok: true, ...(await clearAll())}), respond);
        if (msg.kind === 'nothing-here') {
            toast('No fillable fields found on this page.', null);
            respond({ok: true});
            return false;
        }
        // The worker says when the model has finished loading, so the card can stop saying "warming up".
        // A batch of answers, ahead of the request it belongs to finishing.
        if (msg.kind === 'model-batch') {
            if (M.modelBatch) M.modelBatch(msg.values, msg.via);
            respond({ok: true});
            return false;
        }
        if (msg.kind === 'model-stage') {
            if (busy && M.modelLoading && msg.stage === 'asking') {
                M.modelLoading = false;
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
