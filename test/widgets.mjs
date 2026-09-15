/* Widget-layer suite: drives the PrimeVue-shaped fixture and asserts the page's
 * own model (updated only by real events) ends up correct. */
import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = (f) => readFileSync(resolve(root, 'src', f), 'utf8');
// Load order matters: each layer reads the one below it off globalThis.
/* Read from background.js, not restated here. That file owns the list, and a
 * suite carrying its own copy is how a file can be added to the filler and
 * still be missing from everything that loads it — which is what happened when
 * vocab.js arrived. */
const FILLER = [...(readFileSync(resolve(root, 'src/background.js'), 'utf8')
    .match(/const FILLER_FILES = \[([\s\S]*?)\]/) || [, ''])[1]
    /* The quoted names, not everything between the commas: the list has a
     * comment in it, and splitting on `,` swallowed half of one as a path. */
    .matchAll(/['"]([^'"]+\.js)['"]/g)].map(m => m[1].replace(/^src\//, ''));

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  — ' + extra : ''}`);
    if (!cond) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 900, height: 1000}});
page.on('console', m => {
    if (m.type() === 'error') console.log('   page error:', m.text());
});
page.on('pageerror', e => console.log('   pageerror:', e.message));

async function load(query) {
    await page.goto('file://' + resolve(root, 'test/primevue-form.html') + (query ? '?' + query : ''));
    for (const f of FILLER) await page.addScriptTag({content: src(f)});
}

await load();

// What did the scanner see?
const scan = await page.evaluate(() => {
    const fields = window.__formforge.collectFields({overwrite: true});
    return fields.map(f => ({kind: f.kind, type: f.type, lib: f.lib || null, label: (f.label || '').slice(0, 44)}));
});
console.log('\nDetected fields:');
scan.forEach(f => console.log(`  ${String(f.kind).padEnd(7)} ${String(f.type).padEnd(14)} ${String(f.lib || '').padEnd(24)} ${f.label}`));
console.log('');

const widgetKinds = scan.filter(f => f.kind === 'widget').map(f => f.lib);
// Land, Country, Stadt, Standorttyp, the phone country picker, and the
// remote-backed Organization/Location one.
check('detects the single selects', widgetKinds.filter(k => k === 'primevue-select').length === 6, widgetKinds.filter(k => k === 'primevue-select').length + '');
check('detects the multiselect', widgetKinds.includes('primevue-multiselect'));

/* An application wraps a library control in a div of its own and gives it a
 * generic class. `.multiselect` is vue-multiselect's root, so the wrapper
 * matched first and — outermost wins — the real PrimeVue MultiSelect inside it
 * was never seen: no label selector, no options selector, and a read-back that
 * returned the caption the wrapper holds. Found on a live admin, where every
 * multi-select on the page was driven blind. */
const impostor = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML =
        '<div class="multiselect"><div class="multiselect__label-row">' +
        '<label for="ff-wrapped">Wrapped categories</label></div>' +
        '<div class="p-multiselect p-component" data-pc-name="multiselect">' +
        '<span class="p-multiselect-label p-multiselect-label-empty">Bitte wählen</span>' +
        '<input id="ff-wrapped" class="p-hidden-accessible" role="combobox" ' +
        'aria-haspopup="listbox" aria-expanded="false" readonly></div></div>';
    document.body.appendChild(host);
    try {
        const W = globalThis.FormForgeWidgets;
        const A = globalThis.FormForgeAdapters;
        const mine = W.detect(document).filter(w => host.contains(w.root));
        return {
            count: mine.length,
            id: mine[0] && mine[0].id,
            kind: mine[0] && mine[0].kind,
            shown: mine[0] ? A.displayedValue(mine[0]) : null
        };
    } finally {
        host.remove();
    }
});
check('a wrapper class does not impersonate the library inside it',
    impostor.count === 1 && impostor.id === 'primevue-multiselect' && impostor.kind === 'multichoice',
    `${impostor.count} widget(s), ${impostor.id} ${impostor.kind}`);
check('and the wrapped control reads back as empty, not as its own caption',
    impostor.shown === '', JSON.stringify(impostor.shown));

/* A panel keeps its options, its size and its full opacity for the whole leave
 * transition. The class that says it is leaving sits on the overlay wrapper,
 * while `aria-controls` names the list inside it — so a question asked only of
 * the list answered "still open" for every dropdown that had just been used,
 * and each one was then chased with Escapes and clicks for 0.4s it did not
 * need. Half the time a form spent in its dropdowns was this. */
const fading = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML =
        '<div class="p-select-overlay p-anchored-overlay-leave-active p-anchored-overlay-leave-to">' +
        '<ul id="ff-fading-list" role="listbox">' +
        '<li role="option">Alpha</li><li role="option">Beta</li></ul></div>';
    document.body.appendChild(host);
    try {
        const O = globalThis.FormForgeOverlays;
        const list = document.getElementById('ff-fading-list');
        return {
            options: O.optionsIn(list, null).length,
            list: O.liveOverlay(list),
            wrapper: O.liveOverlay(host.firstElementChild)
        };
    } finally {
        host.remove();
    }
});
check('a list inside a panel on its way out is not an open list',
    fading.options === 2 && fading.list === false && fading.wrapper === false,
    JSON.stringify(fading));

/* A rich-text editor the form has switched off — Quill marks it
 * contenteditable="false" until the switch above it is on. Writing to it
 * anyway used to poison the element: the branch for form controls invented a
 * `value` on the <div>, after which every later write took that branch and put
 * the markup in as visible tags, appended rather than replacing. Reported from
 * a real location form, where one press of the focused-field shortcut on a
 * disabled courier-service editor left two copies of the raw HTML on screen. */
const switchedOff = await page.evaluate(() => {
    const D = globalThis.FormForgeDom, W = globalThis.FormForgeWidgets;
    const markup = '<p><strong>Note:</strong> one</p><ul><li>two</li></ul>';
    const host = document.createElement('div');
    host.innerHTML =
        '<div class="p-editor" data-pc-name="editor" label="Courier service">' +
        '<div class="p-editor-toolbar ql-toolbar"></div>' +
        '<div class="p-editor-content ql-container ql-disabled">' +
        '<div class="ql-editor" contenteditable="false"></div></div></div>';
    document.body.appendChild(host);
    try {
        const editor = host.querySelector('.ql-editor');
        const offered = W.detect(document).filter(w => host.contains(w.root)).length;
        const refused = D.typeInto(editor, markup);
        const poisoned = 'value' in editor;
        // The form switches it on, exactly as the courier-service checkbox does.
        editor.setAttribute('contenteditable', 'true');
        host.querySelector('.ql-container').classList.remove('ql-disabled');
        const enabledNow = W.detect(document).filter(w => host.contains(w.root)).length;
        D.typeInto(editor, markup);
        return {offered, refused, poisoned, enabledNow, html: editor.innerHTML};
    } finally {
        host.remove();
    }
});
check('an editor the form has switched off is not offered as a field',
    switchedOff.offered === 0 && switchedOff.enabledNow === 1,
    `${switchedOff.offered} while off, ${switchedOff.enabledNow} once on`);
check('and writing to one reports nothing rather than claiming success',
    switchedOff.refused === null && switchedOff.poisoned === false,
    `returned ${JSON.stringify(switchedOff.refused)}, value invented: ${switchedOff.poisoned}`);
check('so once the form enables it the markup goes in as markup',
    /<strong>/.test(switchedOff.html) && !/&lt;/.test(switchedOff.html),
    switchedOff.html.slice(0, 70));
check('detects the autocomplete', widgetKinds.includes('primevue-autocomplete'));
check('detects the datepicker', widgetKinds.includes('primevue-datepicker'));
check('detects the inputnumber', widgetKinds.includes('primevue-inputnumber'));
check('detects the toggleswitch', widgetKinds.includes('primevue-toggleswitch'));
check('detects the checkbox', widgetKinds.includes('primevue-checkbox'));
check('detects the selectbutton', widgetKinds.includes('primevue-selectbutton'));
/* Three RadioButtons sharing a name are one decision. Ungrouped they were
 * three fields, each clicked in turn, so the form always ended on the last
 * option no matter the seed — found on a real PrimeVue form. */
check('groups the radio buttons into one field',
    scan.filter(f => f.type === 'radio-group').length === 1
    && scan.filter(f => f.type === 'radio').length === 0,
    `radio-group=${scan.filter(f => f.type === 'radio-group').length} loose radio=${scan.filter(f => f.type === 'radio').length}`);
/* A control the app disabled or marked read-only is not ours to write; a
 * readonly attribute on a Select's hidden input is not that signal. */
check('skips the read-only select',
    !scan.some(f => (f.label || '').includes('Zeiteinheit')),
    scan.filter(f => (f.label || '').includes('Zeiteinheit')).length + ' picked up');
/* Filling the language switcher would rewrite every label mid-run. */
check('skips the app language switcher',
    !scan.some(f => /localeSwitcher|Switch language/i.test(f.label || '')));
/* What the model is told about the page. document.title on a single-page app
 * is the product name on every screen; a dialog's own title is the only thing
 * that says what its field wants. */
const ctx = await page.evaluate(() => {
    const dlg = document.getElementById('dlg');
    dlg.hidden = false;
    const inside = window.__formforge.pageContext(document.getElementById('dlg-input'));
    const outside = window.__formforge.pageContext(document.getElementById('name'));
    dlg.hidden = true;
    return {inside, outside};
});
check('a dialog contributes its own title as context',
    /Buchungsvoraussetzung/.test(ctx.inside.dialog), ctx.inside.dialog || '(none)');
check('a field outside any dialog reports no dialog context',
    ctx.outside.dialog === '', ctx.outside.dialog);
check('the page heading is picked up either way',
    !!ctx.inside.heading || !!ctx.inside.title, `${ctx.inside.heading} / ${ctx.inside.title}`);

/* A view is not a field: an inline calendar has no input and mirrors a value
 * another control owns. Counted as a field it is filled, fruitlessly, and can
 * disturb the control it mirrors. */
/* Four real date controls on the fixture (a date, a year, a time-only and one
 * that states its own format), and one inline calendar that is none of them. */
check('ignores an inline calendar',
    scan.filter(f => f.type === 'date').length === 4
    && !scan.some(f => /kalenderansicht/i.test(f.label || '')),
    scan.filter(f => f.type === 'date').map(f => f.label.slice(0, 22)).join(' | '));
check('detects the rich-text editor',
    widgetKinds.includes('primevue-editor'),
    scan.filter(f => f.lib === 'primevue-editor').map(f => f.label).join(''));
/* The Editor's caption exists only as a `label` attribute on the root. */
check('labels the editor from its label attribute',
    scan.some(f => f.lib === 'primevue-editor' && /Hinweise zur Ausleihe/.test(f.label || '')),
    (scan.find(f => f.lib === 'primevue-editor') || {}).label || '');
check('still sees the plain inputs', scan.filter(f => f.kind === 'native').length >= 3,
    scan.filter(f => f.kind === 'native').length + ' native');
check('does not double-count widget-owned inputs',
    !scan.some(f => f.kind === 'native' && /Kapazität|Regionen|Ansprechpartner/.test(f.label)));

const res = await page.evaluate(() => window.__formforge.run({
    seed: 'WID001', locale: 'de-DE', useAI: false, overwrite: true, emailDomain: 'example.com'
}));

const snap = await page.evaluate(() => window.__snapshot());
console.log('Page model after fill:');
for (const [k, v] of Object.entries(snap)) console.log(`  ${k.padEnd(20)} ${JSON.stringify(v)}`);
console.log('');

/* Every field reported by name. `describe()` leads with whatever it found on
 * the native input a widget wraps, and a component-library Select wraps one
 * that is hidden and nameless — so the leading fragment was the chevron glyph
 * its neighbour draws, and the result panel, the Debug tab and the on-page
 * indicator all called three different dropdowns "▾". The caption is the first
 * fragment with letters in it, not the first fragment. */
const captions = (res.filled || []).map(f => f.label);
check('every filled field is reported by a readable name',
    captions.length > 0 && captions.every(c => (String(c).match(/\p{L}/gu) || []).length >= 2)
    && !captions.some(c => /^(select|multiselect|autocomplete|datepicker|choice)$/i.test(String(c).trim())),
    captions.filter(c => (String(c).match(/\p{L}/gu) || []).length < 2
        || /^(select|multiselect|choice)$/i.test(String(c).trim())).join(', ') || 'all named');
check('and by the name its own label gives it',
    ['Land', 'Stadt', 'Standorttyp'].every(n => captions.includes(n)),
    captions.slice(0, 6).join(' · '));

const LAENDER = ['Deutschland', 'Österreich', 'Schweiz', 'Niederlande'];
const TYPEN = ['Filiale', 'Lager', 'Werkstatt', 'Bürostandort', 'Abholstation'];
const REGIONEN = ['Nord', 'Süd', 'Ost', 'West', 'Zentral'];
const STAEDTE = {
    Deutschland: ['Berlin', 'Hamburg', 'München', 'Köln'], 'Österreich': ['Wien', 'Graz'],
    Schweiz: ['Zürich', 'Bern'], Niederlande: ['Amsterdam', 'Rotterdam']
};

check('single select committed a real option', LAENDER.includes(snap.land), snap.land);
check('country rule steered the select to Germany', snap.land === 'Deutschland', snap.land);
check('dependent select filled after its parent', STAEDTE[snap.land]?.includes(snap.stadt), `${snap.stadt} in ${snap.land}`);
check('unlabelled-domain select still picked a valid option', TYPEN.includes(snap.typ), snap.typ);
check('multiselect committed at least one region', snap.regionen.length >= 1, JSON.stringify(snap.regionen));
check('multiselect values are all real options', snap.regionen.every(r => REGIONEN.includes(r)), JSON.stringify(snap.regionen));
check('autocomplete resolved to a suggestion, not raw text',
    ['Anna Becker', 'Petra Schmidt', 'Thomas Fischer', 'Lukas Weber', 'Marie Wagner'].includes(snap.ansprechpartner),
    String(snap.ansprechpartner));
check('datepicker committed a dd.mm.yyyy date', /^\d{2}\.\d{2}\.\d{4}$/.test(snap.datum || ''), String(snap.datum));
// A picker whose panel holds a decade and no day still gets a year out of it.
check('year-only picker committed a year', /^\d{4}$/.test(snap.baujahr || ''), String(snap.baujahr));
check('controlled number input accepted the value via real events', /^\d+$/.test(snap.kapazitaet), snap.kapazitaet);
check('input events actually reached the page', snap.acceptedInputEvents > 0, String(snap.acceptedInputEvents));
check('required checkbox was ticked', snap.agb === true);
check('toggle switch was driven', typeof snap.aktiv === 'boolean');
check('selectbutton committed a choice', ['niedrig', 'mittel', 'hoch'].includes(snap.prio), String(snap.prio));
check('plain text inputs still filled', snap.name.length > 0 && snap.strasse.length > 0, `${snap.name} / ${snap.strasse}`);
check('street looks German', /\d/.test(snap.strasse) && /[a-zäöüß]/i.test(snap.strasse), snap.strasse);
check('textarea filled with a sentence', snap.notiz.length > 20, snap.notiz.slice(0, 40));
check('no overlay was left open', snap.openOverlays === 0, String(snap.openOverlays));
/* The account form's shape: a required picker, and below it a control the app
 * only enables once that picker holds a value. Getting the first one wrong
 * used to leave the second locked, and the placeholder the first one renders
 * was being read back as the value written — so the fill reported success on
 * an empty required field and the repair pass skipped it for not being empty.
 * Three presses to finish a six-field form. */
check('a placeholder is not a value',
    snap.orga && snap.orga !== 'Choose organization or location', String(snap.orga));
check('and a control another field unlocks is filled in the same fill',
    ['Admin MZ', 'Super Teacher', 'Teacher'].includes(snap.rolle), String(snap.rolle));

check('run reports the widgets it drove', (res.widgets || 0) >= 7, `widgets=${res.widgets} count=${res.count}`);

// Determinism across the widget layer too.
await load();
await page.evaluate(() => window.__formforge.run({
    seed: 'WID001', locale: 'de-DE', useAI: false, overwrite: true, emailDomain: 'example.com'
}));
const snap2 = await page.evaluate(() => window.__snapshot());
check('same seed reproduces the same widget choices',
    snap2.land === snap.land && snap2.stadt === snap.stadt && snap2.typ === snap.typ &&
    snap2.prio === snap.prio && snap2.orga === snap.orga && snap2.team === snap.team &&
    JSON.stringify(snap2.regionen) === JSON.stringify(snap.regionen),
    `${snap2.typ}/${snap.typ}, ${snap2.prio}/${snap.prio}, ${snap2.team}/${snap.team}`);

await load();
await page.evaluate(() => window.__formforge.run({
    seed: 'OTHER9', locale: 'de-DE', useAI: false, overwrite: true, emailDomain: 'example.com'
}));
const snap3 = await page.evaluate(() => window.__snapshot());
/* Every choice control on the form, not three of them. Two seeds landing on
 * the same location type and the same priority is ordinary luck — there are
 * three of each — and asking only about those made a true statement about the
 * seed look false as soon as a new control shifted which draw fell where. */
const choicesOf = (s) => JSON.stringify([s.typ, s.prio, s.stadt, s.land, s.regionen, s.orga, s.team]);
check('a different seed moves the widget choices too',
    choicesOf(snap3) !== choicesOf(snap), `${choicesOf(snap3)} vs ${choicesOf(snap)}`);

/* Filling a switch can create fields. A single pass leaves them empty and
 * required — on a real form that meant a screenful of validation
 * errors that were not there before the fill. */
check('a switch that reveals fields gets those fields filled too',
    snap.saOpen && snap.saStart !== '' && snap.saEnd !== '',
    `open=${snap.saOpen} start="${snap.saStart}" end="${snap.saEnd}"`);
check('revealed times get clock values, in the right order',
    snap.saStart === '09:00' && snap.saEnd === '17:00', `${snap.saStart}–${snap.saEnd}`);
check('the run reports how many fields it revealed', (res.revealed || 0) >= 2,
    `revealed=${res.revealed}`);

/* The control's own limits are a contract: a value outside them is refused,
 * and a refusal is indistinguishable from never having written anything. */
const dauer = Number(snap.mindestdauer);
check('widget number is clamped to the inner input min/max',
    snap.mindestdauer !== '' && dauer >= 12 && dauer <= 18, snap.mindestdauer);

/* A null value must never reach a text control as the string "null". */
check('no field was filled with the literal string null',
    !Object.values(snap).some(v => v === 'null' || v === 'undefined'),
    Object.entries(snap).filter(([, v]) => v === 'null' || v === 'undefined').map(([k]) => k).join(',') || 'none');
/* A caption must come from the control's own wrapper, never a neighbour's. */
check('editor label is not polluted by a neighbouring field',
    !/Standortname/.test((scan.find(f => f.lib === 'primevue-editor') || {}).label || ''),
    (scan.find(f => f.lib === 'primevue-editor') || {}).label || '');
/* Prose, not the generic one-line filler: "Hinweise"/"Information" labels are
 * notes fields, and a rich-text editor is a textarea with a toolbar. */
/* A time-only picker takes no typing: its input refuses focus and the value
 * is written by the component from its spinners. Typing looked like it worked
 * — typeInto returned the string it had just set — and the component then
 * discarded it, leaving every opening-hours field empty. */
check('time-only picker is driven by its spinners', snap.oeffnet === '09:00', snap.oeffnet || '(empty)');

/* A field that rebuilds its own DOM node after being written must not be
 * mistaken for a newly revealed one. It was: the replacement carried no
 * marker, a later pass took it for a new field, and — because those passes
 * deliberately skip the model — wrote a fallback over the model's answer. */
check('a re-rendered field is written once, not overwritten',
    snap.rerenderedWrites.length === 1 && snap.rerenderedNow === snap.rerenderedWrites[0],
    `writes=${JSON.stringify(snap.rerenderedWrites)} now="${snap.rerenderedNow}"`);

/* Smooth, not chaotic: each dropdown is opened once, a value chosen, and the
 * fill moves on. Reopening one means a later pass reconsidered a field it had
 * already settled — which shows up as the value changing by itself, and on the
 * real app turned a two-second fill into seventeen.
 *
 * Autocompletes are exempt, and only they: a panel there is the answer to one
 * query, so trying a second query is the control working as designed, not a
 * field being reconsidered. `#lieferant` is the case — its backend has nothing
 * for the first probe and something for the second. */
const AUTOCOMPLETES = new Set(['ansprechpartner', 'lieferant']);
const reopened = Object.entries(snap.opens || {})
    .filter(([id, n]) => n > 1 && !AUTOCOMPLETES.has(id));
check('each dropdown is opened exactly once',
    reopened.length === 0, reopened.map(([k, n]) => `${k}×${n}`).join(', ') || 'none reopened');

/* A rich-text editor is there to hold formatting; filling it with a flat
 * paragraph exercises none of what makes it different from a textarea. */
check('editor received real markup, not flat text',
    /<(strong|em|ul|li|p)\b/i.test(snap.hinweiseHtml),
    (snap.hinweiseHtml || '').slice(0, 60));

check('editor received prose through real input events',
    snap.hinweise.length > 20 && /\s/.test(snap.hinweise) && !/^Brightmoor/.test(snap.hinweise),
    snap.hinweise.slice(0, 48));
check('read-only select was left untouched', snap.zeiteinheitText === 'Tage', snap.zeiteinheitText);
check('language switcher was left untouched', snap.spracheText === 'Deutsch', snap.spracheText);

// The group must commit exactly one option, and the same seed must commit the
// same one — the bug this replaces always selected whichever came last.
const BOOKING = ['AUTOMATIC', 'MANUAL', 'HYBRID'];
check('radio group selected exactly one option',
    snap.radiosChecked === 1 && BOOKING.includes(snap.bookingConfirmation),
    `${snap.bookingConfirmation} (${snap.radiosChecked} checked)`);
check('radio group choice is reproducible from the seed',
    snap2.bookingConfirmation === snap.bookingConfirmation && snap2.radiosChecked === 1,
    `${snap2.bookingConfirmation}/${snap.bookingConfirmation}`);

// A nonsense guess must still land on a real option, groups included.
await load();
const radioForced = await page.evaluate(async () => {
    const g = globalThis.FormForgeGen;
    const W = globalThis.FormForgeWidgets;
    const persona = g.buildPersona('XX1', 'de-DE', {});
    const widget = W.detect(document).find(w => w.kind === 'radio-group');
    const written = await W.fill(widget, 'Not A Real Option', {rng: persona._rng, persona});
    return {
        written,
        model: window.__model.bookingConfirmation,
        checked: document.querySelectorAll('.p-radiobutton input:checked').length
    };
});
check('a nonsense guess still commits one real radio option',
    BOOKING.includes(radioForced.model) && radioForced.checked === 1,
    `${radioForced.written} / ${radioForced.model}`);

// Asking for an option by name must select that one, not a seeded guess.
await load();
const radioNamed = await page.evaluate(async () => {
    const g = globalThis.FormForgeGen;
    const W = globalThis.FormForgeWidgets;
    const persona = g.buildPersona('XX1', 'de-DE', {});
    const widget = W.detect(document).find(w => w.kind === 'radio-group');
    await W.fill(widget, 'Manuell', {rng: persona._rng, persona});
    return window.__model.bookingConfirmation;
});
check('a named option is honoured over a seeded pick', radioNamed === 'MANUAL', radioNamed);

// A model guess that matches no option must still land on a real one.
await load();
const forced = await page.evaluate(async () => {
    const g = globalThis.FormForgeGen;
    const W = globalThis.FormForgeWidgets;
    const persona = g.buildPersona('XX1', 'de-DE', {});
    const widget = W.detect(document).find(w => w.root.id === 'typ');
    const written = await W.fill(widget, 'Totally Nonexistent Option', {rng: persona._rng, persona});
    return {written, model: window.__model.typ};
});
check('a nonsense model guess still commits a valid option',
    TYPEN.includes(forced.model), `${forced.written} / ${forced.model}`);

/* ------------------------------------------------ required, and why not --
 * Country kept coming back empty on a form that visibly requires it. Two
 * things had to be true for that: the field was not recognised as required —
 * the application marks it with an asterisk in the label and nothing else — so
 * "a wrong country is worse than none" applied and left it blank; and the
 * report said only "planned but wrote nothing", which does not distinguish a
 * bug in the search from a persona asking for a country the list does not
 * have. */
await load();
const refused = await page.evaluate(async () => {
    const W = globalThis.FormForgeWidgets;
    const D = globalThis.FormForgeDom;
    const root = document.getElementById('land');
    const widget = W.detect(document).find(w => w.root === root);

    D.takeNotes();
    const wrote = await W.fill(widget, 'Kiribati', {
        rng: Math.random, persona: {}, label: 'Land',
        requireMatch: true, required: false
    });
    const notes = D.takeNotes();

    // Marked required by its asterisk alone — no required, no aria-required.
    const attrs = root.matches('[required], [aria-required="true"]')
        || !!root.querySelector('[required], [aria-required="true"]');
    const seen = window.__formforge.collectFields({overwrite: true})
        .find(f => f.el === root);
    return {wrote, notes, attrs, detectedRequired: !!(seen && seen.required)};
});

/* `requireMatch` buys a longer search, not a veto. It used to leave the field
 * as it found it — on the reasoning that "+690 Tokelau" beside a German number
 * reads as a bug in the application where an empty picker merely reads as
 * unfilled. That trade does not hold up: an empty Country blocks the form,
 * blocks every control that depends on it, and is the one thing a tester
 * cannot work around, while a country that does not match the address is
 * visibly test data among other test data. */
check('a picker that must match and cannot takes a valid option anyway',
    typeof refused.wrote === 'string' && refused.wrote.length > 0
    && refused.wrote !== 'Kiribati',
    JSON.stringify(refused.wrote));
/* And says so, in words that answer the next question rather than posing it:
 * what was wanted, what the list held, and what went in instead. */
check('and says what it wanted and what it took instead',
    refused.notes.some(n => /no "Kiribati" among \d+ option/.test(n) && /took "/.test(n)),
    refused.notes.join(' | ') || '(said nothing)');
/* The other half: most applications mark a required field with an asterisk in
 * the caption and never set an attribute, so reading only the attributes
 * called a visibly-required Country optional. */
check('an asterisk in the caption counts as required',
    refused.attrs === false && refused.detectedRequired === true,
    `attributes=${refused.attrs} detected=${refused.detectedRequired}`);

/* -------------------------------------------------- what was already there --
 * An inline calendar is a permanent part of the page — the booking form
 * renders one beside its date inputs — and it matches the very selector a date
 * popup does. The end-of-fill sweep found it every time, pressed the body
 * three times trying to close something that is not a popup, and then logged a
 * warning into the tester's extension error list that read like a crash in
 * FormForge. About 400ms and one false alarm per fill of that page. */
await load();
const permanent = await page.evaluate(async () => {
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => {
        warned.push(a.join(' '));
        realWarn(...a);
    };
    const before = document.querySelectorAll('#kalenderansicht .p-datepicker-panel').length;
    const res = await window.__formforge.run({locale: 'de-DE', useAI: false, overwrite: true});
    console.warn = realWarn;
    return {
        before,
        after: document.querySelectorAll('#kalenderansicht .p-datepicker-panel').length,
        warned: warned.filter(w => /left open/.test(w)),
        leftOpen: res.leftOpen || [],
        datum: window.__snapshot().datum,
        skipped: (res.skipped || []).map(s => s.label)
    };
});

check('an inline calendar is there before and after, untouched',
    permanent.before === 1 && permanent.after === 1,
    `${permanent.before} -> ${permanent.after}`);
/* The rule this project uses for every other overlay question: a panel that
 * was there before we started is not one we opened. */
check('and is not mistaken for a panel somebody left open',
    permanent.leftOpen.length === 0 && permanent.warned.length === 0,
    permanent.leftOpen.join(', ') || permanent.warned.join(' | ') || 'clean');
/* It must also not stop the real date field from working — the picker beside
 * it has to find its own panel among the two. */
check('the date field beside it still fills',
    !!permanent.datum && !permanent.skipped.includes('Eröffnungsdatum'),
    `Eröffnungsdatum = ${JSON.stringify(permanent.datum)}`);

/* A panel is this control's or it is not; what it happens to show is a second
 * question. Deciding it had opened only once a day cell appeared meant a
 * year-scoped picker never counted as open at all: the search ran to its
 * 1.2-second budget, then the month-paging loop ran to its own, and the value
 * arrived from typing at the end. Measured at 2.4 seconds a field on a real
 * device-management form, against 0.2 once the question was asked properly. */
const yearPicker = await page.evaluate(async () => {
    const W = globalThis.FormForgeWidgets;
    const G = globalThis.FormForgeGen;
    const persona = G.buildPersona('YEAR01', 'de-DE', {});
    const widget = W.detect(document).find(w => w.root.id === 'baujahr');
    const input = document.querySelector('#baujahr input');
    input.value = '';
    const t0 = Date.now();
    const written = await W.fill(widget, String(new Date().getFullYear() - 3),
        {rng: persona._rng, persona, label: 'Baujahr'});
    return {ms: Date.now() - t0, written, value: input.value};
});
check('a year-scoped picker is driven through its own panel',
    /^\d{4}$/.test(String(yearPicker.value || '')), JSON.stringify(yearPicker.written));
check('and does not spend a day-cell budget looking for days',
    yearPicker.ms < 1200, `${yearPicker.ms}ms`);

/* The day grid matches twice over: once as the <td> and once as the day inside
 * it. Pressing the outer one does nothing — PrimeVue binds the click to the day
 * — so a pool holding both filled roughly half the date fields and left the rest
 * empty, differently on every seed. Eight of them, because one proves nothing. */
const everySeed = await page.evaluate(async () => {
    const W = globalThis.FormForgeWidgets, G = globalThis.FormForgeGen;
    const widget = W.detect(document).find(w => w.root.id === 'datum');
    const input = document.querySelector('#datum input');
    const missed = [];
    for (const seed of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']) {
        const persona = G.buildPersona(seed, 'de-DE', {});
        input.value = '';
        const written = await W.fill(widget, persona.futureDateLocal, {rng: persona._rng, persona});
        if (!/^\d{2}\.\d{2}\.\d{4}$/.test(String(written || ''))) missed.push(`${seed}:${written}`);
    }
    return missed;
});
check('a date picker commits on every seed, not on half of them',
    everySeed.length === 0, everySeed.join(', ') || '8 of 8');

/* A control closes its own panel rather than leaving it for the end-of-fill
 * sweep, which gets three presses for whatever it finds: a real location form
 * with five opening-hour rows ended every fill under a stack of them. This
 * fixture has one row and closes on the first press either way, so the check
 * guards the invariant rather than reproducing that form. */
const timePanel = await page.evaluate(async () => {
    const W = globalThis.FormForgeWidgets, G = globalThis.FormForgeGen, D = globalThis.FormForgeDom;
    const persona = G.buildPersona('T1', 'de-DE', {});
    const widget = W.detect(document).find(w => w.root.id === 'oeffnet');
    const written = await W.fill(widget, '14:20', {rng: persona._rng, persona});
    const up = [...document.querySelectorAll('.p-datepicker-panel')]
        .filter(p => D.visible(p) && !p.closest('.p-datepicker-inline') && !p.dataset.leaving);
    return {written, up: up.length};
});
check('a time picker closes its own panel rather than leaving it to the sweep',
    timePanel.up === 0 && /^\d{1,2}:\d{2}$/.test(String(timePanel.written || '')),
    `${timePanel.written}, ${timePanel.up} panel(s) still up`);

/* A control that states its own date format outranks the language the data is
 * in. A tester filling a German application with English data handed the
 * booking form's rental date 11/24/2026 — a shape it discards without a word,
 * leaving a required field empty and the report saying only "wrote nothing". */
const declaredFmt = await page.evaluate(async () => {
    const W = globalThis.FormForgeWidgets, G = globalThis.FormForgeGen;
    const persona = G.buildPersona('FMT1', 'en-US', {});
    const widget = W.detect(document).find(w => w.root.id === 'vertrag');
    const written = await W.fill(widget, persona.futureDateLocal, {rng: persona._rng, persona});
    return {asked: persona.futureDateLocal, written, value: document.getElementById('vertragsdatum').value};
});
check('a date goes in the shape the control asks for, not the persona\'s',
    /^\d{2}\.\d{2}\.\d{4}$/.test(String(declaredFmt.value || '')),
    `asked ${declaredFmt.asked}, wrote ${JSON.stringify(declaredFmt.value)}`);

/* --------------------------------------------------- a list from a server --
 * The account form's Organization/Location picker: it lists nothing until it
 * has been asked something, the answer takes a round trip, and it says "No
 * results found" for a query it cannot match. Handed the model's answer for a
 * field that had no rule — an invented email address — it searched for that,
 * found nothing, and was left empty, with seven real entries one click away. */
await load('latency=slow');
const remote = await page.evaluate(async () => {
    const W = globalThis.FormForgeWidgets;
    const D = globalThis.FormForgeDom;
    const root = document.getElementById('orga');
    const widget = W.detect(document).find(w => w.root === root);
    const typed = [];
    // Watch what, if anything, gets typed into the search box.
    new MutationObserver(() => {
        const box = document.querySelector('.p-select-overlay[data-owner="orga"] .p-select-filter');
        if (box) box.addEventListener('input', () => typed.push(box.value), {once: false});
    }).observe(document.body, {childList: true, subtree: true});

    D.takeNotes();
    const wrote = await W.fill(widget, 'nils.rohan@sonnenfeld-systeme.com',
        {rng: Math.random, persona: {}, label: 'Organization/Location', required: true});
    const box = document.querySelector('.p-select-overlay[data-owner="orga"] .p-select-filter');
    return {
        wrote, held: window.__snapshot().orga, notes: D.takeNotes(),
        typed: typed.filter(Boolean), leftInBox: box ? box.value : ''
    };
});

const ORGS = ['NRW KMZ', 'Medienzentrum Köln', 'Medienzentrum Bonn', 'Kreis Düren',
    'Stadt Aachen', 'Schulamt Essen', 'Sonnenfeld Systeme GmbH'];
/* The list is empty for a moment after it opens, because it comes over the
 * network. `openOverlay` accepts an empty panel — that is how it tells a
 * dependent select with nothing to offer from one that never opened — so the
 * wait belongs here, or every remote-backed picker reads as having no options
 * at all. */
check('a list that arrives over the network is waited for, not written off',
    ORGS.includes(remote.wrote) && remote.held === remote.wrote,
    `${JSON.stringify(remote.wrote)}${remote.notes.length ? ' · ' + remote.notes.join(' | ') : ''}`);
/* An invented candidate — a persona's company, a model's email — is in nobody's
 * organization list, so it is not searched for at all: the picker takes one of
 * the rows it has. Searching is reserved for real-world candidates (a country,
 * a city) behind a virtualised list, where the round trip can pay off. */
check('a query the list cannot match still ends in a selection',
    ORGS.includes(remote.wrote), JSON.stringify(remote.wrote));
check('and the search box is not left holding it',
    !remote.leftInBox, JSON.stringify(remote.leftInBox));

/* -------------------------------------- a widget's own furniture ---------
 * A dropdown's search box, a date panel's month and year selects, a menu's
 * filter: visible controls the page put on screen to drive a widget with, and
 * not one of them is a field. The scan collected them, and a search box has no
 * label — so the model was asked what belongs in an unnamed text box beside a
 * person, answered with an email address, and that went into the account
 * form's Organization/Location filter. It matched nothing, the required field
 * stayed empty, and the query sat there in the box.
 *
 * Two pickers, deliberately: one from a library we have selectors for, and one
 * built out of nothing but the ARIA a combobox is supposed to carry. If only
 * the first is skipped, the rule is a list of libraries rather than a rule. */
await load();
const furniture = await page.evaluate(async () => {
    const count = () => window.__formforge.collectFields({overwrite: false});
    const closed = count().length;
    // The picker ignores clicks while its list is loading, as PrimeVue does; a person waits for the spinner.
    while (document.querySelector('#orga .p-select-loading-icon')) await new Promise(r => setTimeout(r, 50));
    document.getElementById('orga').dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    document.getElementById('team').click();
    await new Promise(r => setTimeout(r, 900));
    const open = count();
    const inside = (sel) => open.filter(f => f.el && f.el.closest(sel))
        .map(f => f.label || f.el.id || f.el.className);
    return {
        closed, open: open.length,
        bothUp: !!document.querySelector('.p-select-overlay') && !!document.getElementById('team-pop'),
        branded: inside('.p-select-overlay'), unbranded: inside('#team-pop')
    };
});
check('both pickers were actually open for this', furniture.bothUp);
check('a dropdown\'s own search box is not a field',
    !furniture.branded.length, furniture.branded.join(' | ') || 'none');
check('nor is one in a popup from a library we have never seen',
    !furniture.unbranded.length, furniture.unbranded.join(' | ') || 'none');
/* The cleanest way to say it: opening a picker does not change what the form
 * is. Anything else means a fill can be steered by its own side effects. */
check('an open popup does not change what the form is',
    furniture.open === furniture.closed, `${furniture.closed} closed, ${furniture.open} open`);
/* The other side of the same rule, and the one that would hurt. A modal is
 * opened by a control that names it and it floats — every signal a picker's
 * popup gives off — but it is a form, and the field inside it is the whole
 * reason it was opened. */
const modal = await page.evaluate(() => {
    const dlg = document.getElementById('dlg');
    dlg.hidden = false;
    const seen = window.__formforge.collectFields({overwrite: true})
        .filter(f => f.el && f.el.closest('#dlg')).map(f => f.label);
    dlg.hidden = true;
    return seen;
});
check('but a modal dialog is still a form', modal.length > 0, modal.join(' | ') || 'nothing in it');

/* ------------------------------------------------------ closing up ------
 * A fill that ends with a dropdown hanging over the form looks broken however
 * correct every field is, and the phone country picker was the one that did
 * it — sometimes, which is the part that made it hard to see. */
await load();
const closing = await page.evaluate(async () => {
    const W = globalThis.FormForgeWidgets;
    const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

    /* The defect itself, reached directly. The close check returned "closed" the
     * moment the combobox said aria-expanded="false", without looking at the
     * page — so a component that tidies its attributes on one tick and its
     * overlay on another was believed over a list still on screen. */
    const root = document.getElementById('telland');
    const widget = W.detect(document).find(w => w.root === root);
    const O = globalThis.FormForgeOverlays;
    const overlay = await O.openOverlay(widget);
    const opened = !!overlay && O.optionsIn(overlay, widget.lib).length > 0;
    // Marked as ours the moment it opens; the end-of-fill sweep looks for this
    // and nothing else, which is what makes it safe on a page full of the
    // application's own panels.
    const markedWhileOpen = !!overlay && overlay.hasAttribute('data-formforge-opened');
    root.querySelector('[role="combobox"]').setAttribute('aria-expanded', 'false');
    const believedClosed = await O.closeOverlay(widget);
    const reallyClosed = !document.querySelector('.p-select-overlay[data-owner="telland"]:not([data-leaving])');

    await new Promise(r => setTimeout(r, 500));
    const res = await window.__formforge.run({locale: 'de-DE', useAI: false, overwrite: true});
    const left = [...document.querySelectorAll(
        '.p-select-overlay,.p-multiselect-overlay,.p-autocomplete-overlay,.p-datepicker-panel')]
        // The inline calendar is page furniture, not a popup anybody left open.
        .filter(o => vis(o) && !o.dataset.leaving && !o.closest('.p-datepicker-inline'))
        .map(o => o.dataset.owner || o.className);
    return {
        opened, markedWhileOpen, believedClosed, reallyClosed, left,
        focus: document.activeElement.tagName,
        country: window.__snapshot().telland,
        phone: document.getElementById('tel').value,
        // An overlay mid-leave is closed already; PrimeVue keeps it in the DOM for the transition.
        marked: [...document.querySelectorAll('[data-formforge-opened]')].filter(o => !o.dataset.leaving).length
    };
});

check('a panel still on screen is not closed just because the attribute says so',
    closing.opened && closing.reallyClosed,
    `opened=${closing.opened} closed=${closing.reallyClosed}`);
check('and the fill leaves nothing open behind it',
    closing.left.length === 0, closing.left.join(', ') || 'nothing');
/* The other half of the same problem: a control that still has focus can
 * reopen its own list a tick later, after everything watching has stopped. */
check('the fill lets go of the field it finished on', closing.focus === 'BODY', closing.focus);
/* The sweep can only touch what we opened, which is what makes it safe to run
 * over a page whose own dialogs we know nothing about. */
check('the sweep is scoped to overlays FormForge opened',
    closing.markedWhileOpen === true && closing.marked === 0,
    `marked when open: ${closing.markedWhileOpen}, still marked after: ${closing.marked}`);
/* "+690 Tokelau" beside a German number reads as a bug in the app, so this
 * picker is one where only a match will do. */
check('a phone country picker matches the number beside it',
    closing.country === 'Deutschland' && /^49/.test(closing.phone),
    `${closing.country} / ${closing.phone}`);

/* ------------------------------------------------------------ uploads --
 * The one control a tester always had to fill by hand — and on a form that
 * requires one, the whole form blocked behind it. Nothing is fetched and
 * nothing is read from disk: the bytes are made in the page, which is the only
 * version of this that is safe to run on somebody else's site. */
await load();
const files = await page.evaluate(async () => {
    await window.__formforge.run({seed: 'FILE1', locale: 'de-DE', useAI: false, overwrite: true});
    const list = (id) => Array.from((document.getElementById(id).files || []))
        .map(f => ({name: f.name, type: f.type, size: f.size}));
    const bytes = async (id, n) => {
        const f = document.getElementById(id).files[0];
        return f ? Array.from(new Uint8Array(await f.slice(0, n).arrayBuffer())) : null;
    };
    return {
        foto: list('foto'), vertrag: list('vertrag'),
        dropped: window.__snapshot().anhaenge,
        png: await bytes('foto', 4), pdf: await bytes('vertrag', 5)
    };
});

check('a file input is given a file', files.foto.length === 1 && files.foto[0].size > 0,
    files.foto.map(f => `${f.name} ${f.size}B`).join(', ') || 'none');

/* Once, and only once. A dropzone takes the files out of the input, keeps its
 * own list, and clears the input so the same file can be chosen again — so an
 * empty file input is what *success* looks like here, and is the opposite of
 * what it means for every other control. Read the usual way, the repair pass
 * saw a field it had written come back blank and wrote it again, and the
 * reveal pass then collected it as untouched and wrote it a third time: four
 * uploads for two files, each one flagged as a duplicate by the form. */
check('a dropzone that empties its input is not uploaded to twice',
    files.dropped.length === 2 && new Set(files.dropped).size === 2,
    `${files.dropped.length} uploads: ${files.dropped.join(', ')}`);
/* `accept` is the only statement the form makes about what it will take, and a
 * PNG offered to a field that says .pdf comes back with a message the tester
 * then has to read. */
check('and one the field said it would accept',
    files.foto[0] && files.foto[0].type === 'image/png'
    && files.vertrag[0] && files.vertrag[0].type === 'application/pdf',
    `${files.foto[0] && files.foto[0].type} / ${files.vertrag[0] && files.vertrag[0].type}`);
check('a multiple input gets more than one', files.dropped.length > 1,
    `${files.dropped.length} files`);
/* Real bytes, not a name with the right extension: anything that looks inside
 * — which is most of what is worth testing — rejects the latter. The PDF is
 * checked by rendering it, not by trusting this file. */
/* Every generated image used to be the same green rectangle, which made two
 * attachments in one field byte-for-byte identical — indistinguishable on
 * screen, and dropped outright by any uploader that deduplicates by hash. */
const palette = await page.evaluate(async () => {
    const seen = [];
    const sizes = [];
    // Straight to the upload layer: what varies is the file, not the fill around it.
    const G = globalThis.FormForgeGen, U = globalThis.FormForgeUploads;
    for (let i = 0; i < 14; i++) {
        const persona = G.buildPersona('PAL' + i, 'de-DE', {});
        await U.attachFiles(document.getElementById('foto'), persona, 'n:foto', persona._rng);
        const f = document.getElementById('foto').files[0];
        if (!f) continue;
        sizes.push(f.size);
        const bmp = await createImageBitmap(f);
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        // Bottom-left: furthest from the wash, so this is the background itself.
        const d = c.getContext('2d').getImageData(6, bmp.height - 8, 1, 1).data;
        seen.push([d[0], d[1], d[2]]);
        document.getElementById('foto').value = '';
    }
    /* Contrast measured on what was actually drawn, not on a list of hex codes
     * someone typed — the caption is white and has to stay readable on all of
     * them. WCAG AA for body text is 4.5:1. */
    const lum = ([r, g, b]) => {
        const f = (v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrast = seen.map(c => 1.05 / (lum(c) + 0.05));
    return {
        distinct: new Set(seen.map(c => c.join(','))).size, samples: seen.length,
        worst: Math.min(...contrast), sizeKB: Math.round(Math.max(...sizes) / 1024)
    };
});

check('generated images vary in colour from file to file',
    palette.distinct >= 5, `${palette.distinct} distinct backgrounds in ${palette.samples}`);
check('and white stays readable on every one of them',
    palette.worst >= 4.5, `worst contrast ${palette.worst.toFixed(2)}:1`);
/* A smooth radial gradient cost 106KB at a third of today's size, for a
 * difference nobody could see; flat shapes at 1200×800 stay well under what
 * any upload field refuses. */
check('without the picture becoming something a form would refuse',
    palette.sizeKB < 128, `${palette.sizeKB}KB`);

/* Two files in one field have to differ, or an uploader that dedupes by hash
 * silently keeps one of them. */
const twoFiles = await page.evaluate(async () => {
    const el = document.getElementById('anhaenge');
    const caught = [];
    // The dropzone empties the input as soon as it has them; catch them in flight.
    el.addEventListener('change', () => {
        for (const f of el.files) caught.push(f);
    }, true);
    await window.__formforge.run({seed: 'TWO1', locale: 'de-DE', useAI: false, overwrite: true});
    const digest = async (f) => {
        const b = new Uint8Array(await f.arrayBuffer());
        let h = 0;
        for (const x of b) h = (h * 31 + x) | 0;
        return h;
    };
    return {count: caught.length, digests: await Promise.all(caught.map(digest))};
});
/* A uniform draw from fifteen repeats about one time in fifteen, and a repeat
 * is the only thing anybody notices — two pictures that came out the same
 * colour look like the same file, which is what the palette exists to avoid. */
const consecutive = await page.evaluate(async () => {
    const seen = [];
    const G = globalThis.FormForgeGen, U = globalThis.FormForgeUploads;
    for (let i = 0; i < 10; i++) {
        const persona = G.buildPersona('SEQ' + i, 'de-DE', {});
        await U.attachFiles(document.getElementById('foto'), persona, 'n:foto', persona._rng);
        const f = document.getElementById('foto').files[0];
        const bmp = await createImageBitmap(f);
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        const d = c.getContext('2d').getImageData(6, bmp.height - 8, 1, 1).data;
        seen.push([d[0], d[1], d[2]].join(','));
        document.getElementById('foto').value = '';
    }
    return seen;
});
check('no two files in a row get the same background',
    consecutive.every((c, i) => i === 0 || c !== consecutive[i - 1]),
    `${new Set(consecutive).size} distinct across ${consecutive.length} fills`);

/* Every PDF used to be the same bytes but for the seed, so two of them in one
 * field were near-identical and a reader had no way to tell them apart. */
const pdfs = await page.evaluate(async () => {
    const got = [];
    const G = globalThis.FormForgeGen, U = globalThis.FormForgeUploads;
    for (let i = 0; i < 3; i++) {
        const persona = G.buildPersona('PDF' + i, 'de-DE', {});
        await U.attachFiles(document.getElementById('vertrag'), persona, 'n:vertrag', persona._rng);
        const f = document.getElementById('vertrag').files[0];
        got.push(await f.text());
        document.getElementById('vertrag').value = '';
    }
    return got;
});
check('PDFs differ from one file to the next',
    new Set(pdfs).size === 3 && pdfs.every(p => p.startsWith('%PDF-')),
    `${new Set(pdfs).size} distinct of ${pdfs.length}`);
/* Helvetica in WinAnsi through a File, which encodes UTF-8: a "ß" would arrive
 * as two bytes the viewer reads as two wrong characters. */
check('and carry no character a PDF viewer would mangle',
    pdfs.every(p => {
        const body = (p.match(/\(([^)]*)\) Tj/g) || []).join('');
        return !/[^\x20-\x7e()\\]/.test(body);
    }),
    (pdfs[0].match(/\(([^)]*)\) Tj/g) || []).slice(0, 2).join(' '));

/* Files a tester attaches get opened: a 480px flat card and a business-card
 * sized PDF looked like stubs. The picture is a real size with a composition,
 * the PDF a full A4 page set in two faces with a body of text. */
const looks = await page.evaluate(async () => {
    const G = globalThis.FormForgeGen, U = globalThis.FormForgeUploads;
    const persona = G.buildPersona('LOOK1', 'de-DE', {});
    await U.attachFiles(document.getElementById('foto'), persona, 'n:foto', persona._rng);
    const bmp = await createImageBitmap(document.getElementById('foto').files[0]);
    document.getElementById('foto').value = '';
    await U.attachFiles(document.getElementById('vertrag'), persona, 'n:vertrag', persona._rng);
    const pdf = await document.getElementById('vertrag').files[0].text();
    document.getElementById('vertrag').value = '';
    return {
        w: bmp.width, h: bmp.height, a4: /MediaBox \[0 0 595 842\]/.test(pdf), bold: /Helvetica-Bold/.test(pdf),
        lines: (pdf.match(/\) Tj/g) || []).length
    };
});
check('the picture is a real size', looks.w >= 1200 && looks.h >= 800, `${looks.w}×${looks.h}`);
check('the PDF is an A4 page with a body of text in two faces', looks.a4 && looks.bold && looks.lines >= 14,
    `a4=${looks.a4} bold=${looks.bold} ${looks.lines} text runs`);

check('two attachments in one field are different files',
    twoFiles.count === 2 && new Set(twoFiles.digests).size === 2,
    `${twoFiles.count} files, ${new Set(twoFiles.digests).size} distinct`);

check('the bytes are the format they claim to be',
    String(files.png) === '137,80,78,71' && String(files.pdf) === '37,80,68,70,45',
    `png=${files.png} pdf=${files.pdf}`);

/* ------------------------------------------------------ the long walk --
 * Built here rather than in the fixture, because the thing under test is one
 * function and the interesting variable is how the list is ordered. The real
 * control this is about — a country select with 245 entries behind a virtual
 * scroller and no filter input — is the one that kept leaving Country empty. */
const hunt = await page.evaluate(async () => {
    const O = globalThis.FormForgeOverlays;
    const lib = {option: '.p-select-option, li[role="option"]', label: '.p-select-option-label'};
    const build = (shuffle) => {
        document.getElementById('hunt-rig')?.remove();
        const names = [];
        for (let i = 0; i < 245; i++) names.push('Land ' + String(i).padStart(3, '0'));
        names[243] = 'United States';
        if (shuffle) for (let i = names.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [names[i], names[j]] = [names[j], names[i]];
        }
        const box = document.createElement('div');
        box.id = 'hunt-rig';
        box.innerHTML = '<div class="p-virtualscroller" style="height:196px;overflow:auto;position:relative">' +
            '<ul style="position:relative;margin:0;padding:0"></ul></div>';
        document.body.appendChild(box);
        const sc = box.querySelector('.p-virtualscroller'), ul = box.querySelector('ul'), ROW = 28;
        const render = () => {
            ul.style.height = names.length * ROW + 'px';
            const first = Math.max(0, Math.floor(sc.scrollTop / ROW) - 2);
            const last = Math.min(names.length, first + Math.ceil(196 / ROW) + 4);
            ul.textContent = '';
            for (let i = first; i < last; i++) {
                const li = document.createElement('li');
                li.className = 'p-select-option';
                li.setAttribute('role', 'option');
                li.style.cssText = 'position:absolute;left:0;right:0;height:28px;top:' + (i * ROW) + 'px';
                li.innerHTML = '<span class="p-select-option-label">' + names[i] + '</span>';
                ul.appendChild(li);
            }
        };
        sc.addEventListener('scroll', render);
        render();
        return {box, index: names.indexOf('United States')};
    };
    const run = async (shuffle) => {
        const {box, index} = build(shuffle);
        const t0 = Date.now();
        const hit = await O.huntByScrolling(box, lib, ['United States'], Date.now() + 6000);
        return {found: !!hit, ms: Date.now() - t0, index};
    };
    const sorted = await run(false);
    const shuffled = await run(true);
    document.getElementById('hunt-rig')?.remove();
    return {sorted, shuffled};
});

/* The walk used to cap itself at 700ms with a Math.min, throwing away the
 * 2500ms that requireMatch asks for precisely because a match matters there.
 * Row 243 of 245 was unreachable, every time — which is a required Country
 * left empty while the dropdown visibly opens, searches and closes again. */
check('an entry at the end of a long list is reachable at all',
    hunt.sorted.found, `row ${hunt.sorted.index}, ${hunt.sorted.ms}ms`);
/* And reachable quickly, because a sorted list can be halved rather than
 * walked: eight jumps instead of forty-five. */
check('and found by halving the list, not walking it',
    hunt.sorted.found && hunt.sorted.ms < 800, `${hunt.sorted.ms}ms`);
/* Plenty of lists are not sorted — most-used first, grouped by region — and a
 * binary search over those lands somewhere arbitrary. The check that the rows
 * are in order is what makes the jump safe; failing it costs one wasted jump. */
check('an unsorted list is still walked, and still found',
    hunt.shuffled.found, `row ${hunt.shuffled.index}, ${hunt.shuffled.ms}ms`);

/* ------------------------------------------------- long and dependent --
 * A 247-entry country list behind a virtual scroller, and a city list that has
 * nothing to offer until the country is chosen. Both were reported from the
 * real app and neither was reachable here before: the fixture's lists were
 * short enough that every path through them worked.
 *
 * Run in both locales on purpose. The failure was "often, but not every time",
 * and what it actually depended on was the first letter of the value being
 * looked for — "Deutschland" is fifty rows down and was found at once, while
 * "United States" is past two hundred and ran the search budget out. */
for (const locale of ['de-DE', 'en-US']) {
    await load();
    const dep = await page.evaluate(async (locale) => {
        const t0 = Date.now();
        const res = await window.__formforge.run({locale, useAI: false, overwrite: true});
        const s = window.__snapshot();
        return {
            ms: Date.now() - t0, land: s.land, stadt: s.stadt, staat: s.staat, sastaat: s.sastaat,
            notes: res.notes || [],
            skipped: (res.skipped || []).map(x => x.label),
            // Our own cost per control; `load` is time spent on the page's loading indicator.
            choices: Object.fromEntries((res.choiceTimings || [])
                .map(c => [c.label || '?', c.open + c.hunt + c.pick + c.close]))
        };
    }, locale);

    /* The list is virtualised, so only about eleven rows are ever in the DOM.
     * Filtering was gated on more than twelve options being *rendered*, which is
     * exactly backwards — the one case that needed the filter never got it. */
    /* The application's list is German only. "United States" typed into its filter
     * finds nothing, so the persona's country has to be looked for under the
     * name the list uses — or a random country goes in beside a Portland address. */
    const wantedCountry = locale === 'en-US' ? 'Vereinigte Staaten' : 'Deutschland';
    check(`[${locale}] a virtualised list of 247 finds the wanted entry under the list's own spelling`,
        dep.staat === wantedCountry && !dep.skipped.includes('Country'), `Country = ${JSON.stringify(dep.staat)}`);
    /* The application's Country is a server-paged picker, and two of its three
     * live in blocks a switch reveals mid-fill. One page of fifty is not the
     * list, and a fill that reads it as one leaves the field empty or random. */
    check(`[${locale}] a server-paged country revealed mid-fill is found under the list's own spelling`,
        dep.sastaat === wantedCountry, `Zweiter Staat = ${JSON.stringify(dep.sastaat)}`);
    /* Empty leaves the form unsubmittable and every control that depends on this
     * one with nothing to offer. A country that does not match the address is
     * visibly test data among other test data; an empty one is a blocker. */
    check(`[${locale}] a choice control is never left empty`,
        !!dep.land && !dep.skipped.includes('Land'), `Land = ${JSON.stringify(dep.land)}`);
    check(`[${locale}] the dependent select follows it`,
        !!dep.stadt, `Stadt = ${JSON.stringify(dep.stadt)}`);
    /* A control that declines to open says so through aria-expanded on the first
     * frame. Reading it is the difference between half a second and the 2.8s of
     * running out both the press budget and the keyboard retry after it. */
    /* The note has to survive the trip out of the fill, which means going
     * through `FormForgeWidgets.helpers` — the seam content.js reaches the dom
     * layer by. `note` was added to dom.js and not to that bundle, so every
     * H.note() threw into a catch and the result carried nothing. Asserted on
     * the *run result*, not on the dom module, or the seam is not covered. */
    if (locale === 'en-US') {
        check('[en-US] the fill result carries the note about the country',
            dep.notes.some(n => /^Land: no "United States" among \d+ option/.test(n)),
            dep.notes.join(' | ') || '(no notes on the result)');
    }
    check(`[${locale}] no single control costs more than a second`,
        Object.values(dep.choices).every(ms => ms < 1000),
        Object.entries(dep.choices).map(([k, v]) => `${k} ${v}ms`).join(', '));
}

/* ------------------------------------------------------- one field only --
 * The context-menu entry. Chrome does not say which element was clicked, so
 * the filler takes the target of its own contextmenu listener where it has
 * one, and the focused element otherwise — right-clicking an input focuses it,
 * which covers the first use of a page, before anything of ours was listening. */
await load();
const one = await page.evaluate(async () => {
    const out = {};
    const fire = (el) => el.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true}));

    // A plain input, reached through the focus fallback alone.
    const strasse = document.getElementById('strasse');
    strasse.focus();
    out.native = await window.__formforge.fillOne({seed: 'ONE1', locale: 'de-DE', useAI: false});
    out.nativeHeld = strasse.value;

    /* A component-library Select: a div with a hidden input behind it, which
     * Chrome never focuses — so only the recorded right-click can find it, and
     * the widget's root is what gets driven, not the span that was clicked. */
    fire(document.querySelector('#land .p-select-label'));
    out.widget = await window.__formforge.fillOne({seed: 'ONE2', locale: 'de-DE', useAI: false});

    // Right-clicking the page rather than a field: an instruction, not silence.
    document.activeElement.blur();
    fire(document.body);
    out.onThePage = await window.__formforge.fillOne({seed: 'ONE3', locale: 'de-DE', useAI: false});
    return out;
});

/* The keyboard shortcut. The caret decides, even when something else was
 * right-clicked earlier; the caret stays put, so pressing again rolls a new value. */
const keyed = await page.evaluate(async () => {
    const farbe = document.getElementById('farbe');
    document.querySelector('#land .p-select-label').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true}));
    farbe.focus();
    const a = await window.__formforge.fillOne({seed: 'KEY1', locale: 'de-DE', useAI: false}, {focusFirst: true});
    const stillFocused = document.activeElement === farbe;
    const b = await window.__formforge.fillOne({seed: 'KEY2', locale: 'de-DE', useAI: false}, {focusFirst: true});
    return {
        first: a.filled && a.filled[0] && a.filled[0].label, v1: a.filled && a.filled[0] && a.filled[0].value,
        v2: b.filled && b.filled[0] && b.filled[0].value, stillFocused, held: farbe.value
    };
});
check('the shortcut fills the focused field, not the last right-clicked one',
    /farbe/i.test(keyed.first || ''), String(keyed.first));
check('the caret stays in the field, and pressing again gives another value',
    keyed.stillFocused && keyed.v1 && keyed.v2 && keyed.v1 !== keyed.v2 && keyed.held === keyed.v2,
    `${keyed.v1} -> ${keyed.v2}, focused=${keyed.stillFocused}`);

check('filling one field writes that field and no other',
    one.native && one.native.ok && one.native.count === 1
    && /\d/.test(one.nativeHeld) && one.native.filled[0].label === 'Straße und Hausnummer',
    `${one.native && one.native.filled[0] && one.native.filled[0].label} = "${one.nativeHeld}"`);
check('right-clicking inside a widget fills the widget, not the span',
    one.widget && one.widget.ok && one.widget.widgets === 1
    && one.widget.filled[0].label === 'Land',
    one.widget && one.widget.filled && one.widget.filled[0]
        ? `${one.widget.filled[0].label} = ${one.widget.filled[0].value}` : (one.widget || {}).error);
check('and pointing at the page rather than a field says so',
    one.onThePage && !one.onThePage.ok && /not on a field/.test(one.onThePage.error || ''),
    (one.onThePage || {}).error || '');

/* ------------------------------------------------------- the page's CSS --
 * The indicator is a guest inside an application's own stylesheet, and a real
 * one reaches a guest element through a universal selector, through `div`, and
 * through `!important`. This box came out magenta, uppercase and in Comic Sans
 * on a page doing nothing out of the ordinary — and an inline style.display
 * could not even hide a row, because an important rule outranks it. */
await load();
const hostile = await page.evaluate(async () => {
    const st = document.createElement('style');
    st.textContent = `
    *{ font-family:"Comic Sans MS",cursive!important; box-sizing:content-box!important;
       text-transform:uppercase!important; letter-spacing:3px!important; }
    div{ display:block!important; position:static!important; float:left!important;
         padding:20px!important; margin:8px!important; background:#f0f!important;
         color:#0f0!important; border:4px dashed red!important; }
    span,b,button,i{ display:block!important; font-size:22px!important; }`;
    document.head.appendChild(st);
    await window.__formforge.run({seed: 'CSS1', locale: 'de-DE', useAI: false, overwrite: true});
    const hud = document.getElementById('formforge-hud');
    if (!hud) return {missing: true};
    const cs = getComputedStyle(hud);
    const tag = hud.querySelector('.ff-tag');
    /* Hidden by us, not by whatever the fill happened to produce: which rows
     * carry `.ff-off` depends on whether anything was skipped, and a test that
     * waits for the right fill to come along is a test that fails on a Tuesday. */
    const hidden = hud.querySelector('.ff-now') || hud.querySelector('.ff-bar');
    if (hidden) hidden.classList.add('ff-off');
    return {
        position: cs.position,
        fixedToCorner: cs.right === '14px' && cs.bottom === '14px',
        font: cs.fontFamily.toLowerCase(),
        textTransform: cs.textTransform,
        background: cs.backgroundColor,
        width: cs.width,
        borderBox: cs.boxSizing,
        tagInline: tag ? getComputedStyle(tag).display : null,
        hiddenIsHidden: hidden ? getComputedStyle(hidden).display === 'none' : null,
        height: Math.round(hud.getBoundingClientRect().height),
        rowFloat: getComputedStyle(hud.querySelector('.ff-top')).float,
        rowMargin: getComputedStyle(hud.querySelector('.ff-top')).marginTop
    };
});
check('the indicator keeps its own layout on a hostile page',
    hostile.position === 'fixed' && hostile.fixedToCorner && hostile.width === '272px'
    && hostile.borderBox === 'border-box',
    `${hostile.position} ${hostile.width} ${hostile.borderBox}`);
/* And its children keep theirs. Floats and margins the page pushed onto every
 * `div` are what turned a 70px card into a ragged column half the screen high;
 * the properties this file never thought to name are exactly the ones a reset
 * has to cover. */
check('and so do the rows inside it',
    hostile.rowFloat === 'none' && hostile.rowMargin === '0px' && hostile.height < 120,
    `float=${hostile.rowFloat} margin=${hostile.rowMargin} height=${hostile.height}px`);
check('the indicator keeps its own type and colour',
    !/comic/.test(hostile.font || '') && hostile.textTransform === 'none'
    && !/255, 0, 255/.test(hostile.background || ''),
    `${(hostile.font || '').split(',')[0]} / ${hostile.textTransform} / ${hostile.background}`);
/* The reset has to be `!important` to beat the page, which means an inline
 * style.display can no longer hide anything — so hiding is a class. */
check('a row the indicator hides stays hidden', hostile.hiddenIsHidden === true,
    String(hostile.hiddenIsHidden));

/* ----------------------------------------------------- the indicator ----
 * Sampled mid-fill, because everything interesting about it is only true while
 * it is working. The reset that makes the box survive a hostile page is
 * `all: initial !important`, and an important declaration beats a
 * non-important one whatever its specificity — and beats an inline style too.
 * So a plain `style.width` on the progress fill did nothing, and every
 * animation in the stylesheet was overridden into `none`: the card looked
 * exactly right in a screenshot and was completely still in life. */
await load();
const live = await page.evaluate(async () => {
    /* Sampled all the way through, because the property that matters is about
     * the whole run rather than any moment in it. */
    const widths = [];
    const watch = setInterval(() => {
        const f = document.querySelector('#formforge-hud .ff-bar i');
        const b = document.querySelector('#formforge-hud .ff-bar');
        if (f && b) widths.push(+(f.getBoundingClientRect().width / b.getBoundingClientRect().width).toFixed(3));
    }, 60);
    const running = window.__formforge.run({seed: 'HUD1', locale: 'de-DE', useAI: false, overwrite: true});
    await new Promise(r => setTimeout(r, 1100));
    const box = document.getElementById('formforge-hud');
    const fill = box.querySelector('.ff-bar i');
    const mid = {
        busy: box.classList.contains('ff-busy'),
        fillWidth: fill.getBoundingClientRect().width,
        barWidth: box.querySelector('.ff-bar').getBoundingClientRect().width,
        count: box.querySelector('.ff-count').textContent,
        animations: document.getAnimations().map(a => a.animationName).filter(Boolean).sort(),
        // The sweep of the spinner's arc, sampled twice a third of a second apart.
        arc: [getComputedStyle(box.querySelector('.ff-spin')).getPropertyValue('--ff-arc').trim()],
        titleVisible: getComputedStyle(box.querySelector('.ff-title')).webkitTextFillColor
    };
    await new Promise(r => setTimeout(r, 340));
    mid.arc.push(getComputedStyle(box.querySelector('.ff-spin')).getPropertyValue('--ff-arc').trim());

    await running;
    // The fill's width is transitioned, so it is still travelling when run()
    // returns. Measure where it settles, not where it was passing through.
    await new Promise(r => setTimeout(r, 300));
    clearInterval(watch);
    const done = {
        busy: box.classList.contains('ff-busy'),
        fillWidth: box.querySelector('.ff-bar i').getBoundingClientRect().width
    };
    // The card leaves on its own, but not while you are reading it.
    box.querySelector('.ff-x').dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await new Promise(r => setTimeout(r, 320));
    return {mid, done, widths, closed: !document.getElementById('formforge-hud')};
});

/* One bar for the whole job. It used to belong to whichever stage was current,
 * so it ran 0 to 100 for the filling, went back to sweeping for the repair
 * pass, and finished at 100 again — three bars wearing the same clothes. A
 * progress bar that restarts says the thing you were waiting for has begun
 * again, which is the opposite of what is happening. */
const w = live.widths;
const backwards = w.map((v, i) => i && v < w[i - 1] - 0.01 ? `${w[i - 1]}→${v}` : null).filter(Boolean);
check('the progress bar never goes backwards',
    w.length > 8 && backwards.length === 0,
    backwards.length ? `${backwards.length} restarts: ${backwards.slice(0, 3).join(', ')}` : `${w.length} samples, monotonic`);
check('and it crosses the bar once, ending full',
    w[0] < 0.5 && w[w.length - 1] > 0.98 && w.some(v => v > 0.2 && v < 0.8),
    `${w[0]} … ${w[w.length - 1]}`);
/* The count is about the filling stage; the bar is about the whole job, so
 * they do not read the same and must not be asserted against each other. */
check('the bar is ahead of nothing and behind the end while filling',
    live.mid.fillWidth > 1 && live.mid.fillWidth < live.mid.barWidth,
    `${Math.round(live.mid.fillWidth)}px of ${Math.round(live.mid.barWidth)}px at ${live.mid.count}`);

/* A bar that only grows moves once per field and is frozen in between, which
 * is exactly when the fill is inside one slow control and being doubted. */
check('the indicator is actually moving while it works',
    live.mid.busy && ['formforge-sheen', 'formforge-shimmer', 'formforge-spin']
        .every(n => live.mid.animations.includes(n)),
    live.mid.animations.join(', ') || 'nothing is animating');
check('and stops the moment the result lands', live.done.busy === false);

/* A ring of fixed length rotating at thirteen pixels is hard to tell from a
 * static circle. The arc has to change length as it goes round, which means a
 * registered custom property being animated — and that only works because
 * `all: initial` leaves custom properties alone. */
check('the spinner arc grows and shrinks, not just turns',
    live.mid.animations.includes('formforge-breathe')
    && live.mid.arc[0] !== live.mid.arc[1]
    && live.mid.arc.every(a => /deg$/.test(a)),
    live.mid.arc.join(' -> ') || '(--ff-arc never resolved)');
/* The shimmer paints the title with a gradient and makes the text itself
 * transparent to show it through. Get that wrong and the title is invisible —
 * which it was, because the gradient was written in currentColor. */
check('the shimmering title is still legible',
    /rgba\(0, 0, 0, 0\)|transparent/.test(live.mid.titleVisible)
    && live.mid.animations.includes('formforge-shimmer'),
    live.mid.titleVisible);

check('the close button dismisses the card', live.closed === true);

/* And it stays dismissed. The fill carries on after the click, so without this
 * the next field redraws the card a moment later — the worst possible answer
 * to being closed, since it would then keep coming back. */
await load();
const dismissed = await page.evaluate(async () => {
    const running = window.__formforge.run({seed: 'HUD2', locale: 'de-DE', useAI: false, overwrite: true});
    await new Promise(r => setTimeout(r, 500));
    document.querySelector('#formforge-hud .ff-x')
        .dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await running;
    await new Promise(r => setTimeout(r, 400));
    return document.querySelectorAll('#formforge-hud').length;
});
check('and the rest of the fill does not bring it back', dismissed === 0, `${dismissed} box(es)`);

/* ---------------------------------------------------------- autocomplete --
 * Driven directly, on a fresh page, because these are about what the control
 * is left holding when its backend has nothing to offer — which the whole-form
 * fill above cannot isolate. */
await load();
const ac = await page.evaluate(async () => {
    const W = globalThis.FormForgeWidgets;
    const run = async (id, candidate) => {
        const root = document.getElementById(id);
        const w = W.detect(document).find(x => x.root === root);
        const t0 = performance.now();
        const written = await W.fill(w, candidate, {rng: Math.random, persona: {lastName: 'Schneider'}});
        return {written, ms: Math.round(performance.now() - t0), held: root.querySelector('input').value};
    };
    const out = {};
    out.match = await run('ansprechpartner', 'Marie Wagner');
    out.silentMiss = await run('ansprechpartner', 'Zoltan Nobody');
    out.saysEmpty = await run('lieferant', 'Zoltan Nobody GmbH');
    out.noCandidate = await run('lieferant', null);
    return out;
});

check('an autocomplete commits a real suggestion when one matches',
    ac.match.written === 'Marie Wagner' && ac.match.held === 'Marie Wagner', ac.match.written);

/* The bug this is here for: the search types the whole candidate, then shorter
 * and shorter prefixes of it, and gave up holding whichever prefix it tried
 * last — so a contact field ended up containing "Emm", reported as the value
 * written. Nothing found means the field keeps the whole candidate. */
check('a candidate no backend knows is kept whole, not as a prefix',
    ac.silentMiss.held === 'Zoltan Nobody' && ac.silentMiss.written === 'Zoltan Nobody',
    `held="${ac.silentMiss.held}"`);
check('and the same for a backend that answers "no results"',
    ac.saysEmpty.held === 'Zoltan Nobody GmbH', `held="${ac.saysEmpty.held}"`);

/* A panel that is up and says "no results" has answered. Waiting out the rest
 * of the search budget in case it changes its mind is the dearest thing this
 * function used to do — so it must be measurably quicker than the control that
 * answers a miss with silence, on the same page, on the same machine. */
check('an explicit "no results" ends the search early',
    ac.saysEmpty.ms < ac.silentMiss.ms - 200,
    `says-empty ${ac.saysEmpty.ms}ms vs silent ${ac.silentMiss.ms}ms`);

/* With no rule to aim at, the probe exists only to make the list appear. Two
 * letters off the persona's surname is an arbitrary query a real backend
 * answers with nothing, which left the field empty on a form that required it. */
check('an autocomplete with nothing to aim at still commits a real option',
    !!ac.noCandidate.held && ac.noCandidate.held === ac.noCandidate.written,
    `held="${ac.noCandidate.held}"`);

/* Last, and on a fresh page: this runs a fill of its own, and a second fill
 * over the same form would open every dropdown again and invalidate the
 * assertions above. */
await load();
/* A fill that takes a few seconds must look like it is working. The page says
 * what it is doing at each stage, and the last thing it says becomes the
 * result — one box, not two. */
const announced = await page.evaluate(async () => {
    const seen = [];
    const note = () => {
        const el = document.getElementById('formforge-hud');
        const t = el ? el.innerText.replace(/\s+/g, ' ').trim() : null;
        if (t && seen[seen.length - 1] !== t) seen.push(t);
    };
    const obs = new MutationObserver(note);
    obs.observe(document.documentElement, {childList: true, subtree: true, characterData: true});
    await window.__formforge.run({
        seed: 'PRG1',
        locale: 'de-DE',
        useAI: false,
        overwrite: true,
        emailDomain: 'example.com'
    });
    obs.disconnect();
    const spinner = !!document.querySelector('#formforge-spin-style');
    return {seen, spinner};
});
check('the page names the stage it is in',
    announced.seen.some(t => /Reading the form|Asking the model|Filling the form/.test(t)),
    announced.seen.slice(0, 2).join(' -> ') || '(nothing)');
/* A count that moves, and the field it is on. A static "Filling 36 fields…"
 * held for three seconds is indistinguishable from a fill that has hung. */
const counted = announced.seen.map(t => (t.match(/\b(\d+)\/(\d+)\b/) || [])[1]).filter(Boolean);
check('progress advances field by field, and names the field',
    new Set(counted).size > 2 && /\d+\/\d+\s+\S/.test(announced.seen.find(t => /\d+\/\d+/.test(t)) || ''),
    `${new Set(counted).size} distinct counts`);
check('progress and result share one box, and it ends on the result',
    /Filled \d+ field/.test(announced.seen[announced.seen.length - 1] || ''),
    announced.seen[announced.seen.length - 1] || '(nothing)');
check('the progress indicator animates', announced.spinner);

/* While the model is the only thing left, nothing on the page moves, so this is
   the one line a reader needs — and it was the line that got cut. Everything in
   the indicator is nowrap-with-ellipsis, which is right for a field name the
   page supplied and wrong for our own sentence: "Waiting for the model — 15
   fields left" showed as "Waiting for the model — 1...", which reads as a hang
   with the reason hidden. The stage takes the first line and what it is waiting
   on takes the second, the way every other stage already reads. */
const waiting = await page.evaluate(() => {
    FormForgeHud.reset();
    FormForgeHud.progress('fill', 'Waiting for the model',
        {done: 21, total: 36, label: '15 fields left'});
    const cut = (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    const title = document.querySelector('#formforge-hud .ff-title');
    const sub = document.querySelector('#formforge-hud .ff-now');
    // Read before the next stage overwrites the same nodes; reset() reuses the card.
    const out = {
        stage: title.textContent, stageCut: cut(title),
        sub: sub.textContent, subCut: cut(sub),
        counter: document.querySelector('#formforge-hud .ff-count').textContent
    };
    // A title long enough to need the clamp: it may wrap, it may not be cut to a fragment.
    FormForgeHud.reset();
    FormForgeHud.progress('fill', 'FormForge does not know how to fill that control', {done: 1, total: 2});
    const long = document.querySelector('#formforge-hud .ff-title');
    out.longLines = Math.round(long.getBoundingClientRect().height / parseFloat(getComputedStyle(long).lineHeight));
    return out;
});
check('the stage and what it is waiting on get a line each, neither cut off',
    !waiting.stageCut && !waiting.subCut
    && waiting.stage === 'Waiting for the model' && waiting.sub === '15 fields left',
    `"${waiting.stage}" / "${waiting.sub}" cut=${waiting.stageCut}/${waiting.subCut}`);
check('and the count beside them survives it', waiting.counter === '21/36', waiting.counter);
check('a sentence too long for one line wraps instead of losing its end',
    waiting.longLines === 2, `${waiting.longLines} line(s)`);

/* Fill, clear, fill again without reloading. Clearing the organization locks the
 * role template, so at the second collect it is disabled and skipped; it must
 * still be found by the later passes once the organization is chosen again. */
await load();
const again = await page.evaluate(async () => {
    const opts = {seed: 'TWICE1', locale: 'de-DE', useAI: false, overwrite: true, emailDomain: 'example.com'};
    await window.__formforge.run(opts);
    const first = window.__snapshot();
    window.__formforge.clearAll();
    const cleared = window.__snapshot();
    const res = await window.__formforge.run({...opts, seed: 'TWICE2'});
    const second = window.__snapshot();
    return {
        first: first.rolle, cleared: {orga: cleared.orga, rolle: cleared.rolle}, second: second.rolle,
        skipped: (res.skipped || []).map(x => x.label)
    };
});
check('clearing the organization locks the role template again',
    !again.cleared.orga && !again.cleared.rolle, JSON.stringify(again.cleared));
/* A maximum that exists only in the form's validation schema reached the DOM
 * as a red line under a 32-character value; the fill left it there. */
await load();
const limited = await page.evaluate(async () => {
    const res = await window.__formforge.run({seed: 'LIMIT1', locale: 'de-DE', useAI: false, overwrite: true});
    const entry = (res.filled || []).find(x => /Voraussetzung/.test(x.label)) || {};
    return {
        value: window.__snapshot().voraussetzung, why: entry.why || '',
        complaint: !document.getElementById('voraussetzung-fehler').hidden
    };
});
check('a limit the form states only as a complaint is respected',
    limited.value.length > 0 && limited.value.length <= 30 && !limited.complaint,
    `${limited.value.length} chars: "${limited.value}"${limited.complaint ? ' — still complained' : ''}`);
check('and the result says the value was shortened for it', /shortened to 30 characters/.test(limited.why), limited.why);

/* A create dialog over a list page. The fill closed the dialog — Escape, sent to
 * close a dropdown inside it, reached the dialog's own listener — and then
 * typed into the page's search box behind the mask. While a modal is up, it is
 * the whole form, and nothing under its mask is a field. */
await load();
const modalFill = await page.evaluate(async () => {
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search';
    search.id = 'page-search';
    document.body.prepend(search);
    document.getElementById('dlg-open').click();
    const res = await window.__formforge.run({seed: 'MODAL1', locale: 'de-DE', useAI: false, overwrite: true});
    const snap = window.__snapshot();
    const out = {
        open: snap.dialogOpen, input: snap.dlgInput, status: snap.dlgStatus, search: search.value,
        labels: (res.filled || []).map(f => f.label), count: res.count
    };
    search.remove();
    document.getElementById('dlg-cancel').click();
    return out;
});
check('a fill inside a modal dialog leaves the dialog open', modalFill.open === true, JSON.stringify(modalFill));
check('and fills what the dialog holds', modalFill.input.length > 0 && modalFill.labels.includes('Anzeigestatus')
    && ['Sichtbar', 'Versteckt', 'Archiviert'].includes(modalFill.status), `input="${modalFill.input}" status=${modalFill.status}`);
check('and touches nothing under the mask', modalFill.search === '' && modalFill.labels.every(l => !/search/i.test(l)),
    `search="${modalFill.search}" filled: ${modalFill.labels.join(', ')}`);

/* Clear left every upload in place: the dropzone had taken the files out of
 * the input, so emptying the input changed nothing the tester could see. */
await load();
const unfiled = await page.evaluate(async () => {
    await window.__formforge.run({seed: 'FILE2', locale: 'de-DE', useAI: false, overwrite: true});
    const before = {dropped: window.__snapshot().anhaenge.length, foto: document.getElementById('foto').files.length};
    window.__formforge.clearAll();
    await new Promise(r => setTimeout(r, 100));
    return {before, dropped: window.__snapshot().anhaenge.length, foto: document.getElementById('foto').files.length};
});
check('Clear removes the files an uploader keeps in its own list',
    unfiled.before.dropped > 0 && unfiled.dropped === 0, `${unfiled.before.dropped} → ${unfiled.dropped} attached`);
check('and empties a plain file input', unfiled.before.foto === 1 && unfiled.foto === 0, `${unfiled.before.foto} → ${unfiled.foto}`);

check('a second fill after Clear fills the control the first fill had revealed',
    !!again.first && !!again.second && !again.skipped.includes('Selected role template'),
    `first=${JSON.stringify(again.first)} second=${JSON.stringify(again.second)} skipped=${again.skipped.join(', ') || 'none'}`);

// Loose matching needs substance on both sides: "United States" contains "es", which is not Spain.
const loose = await page.evaluate(() => {
    const O = globalThis.FormForgeOverlays;
    const texts = ['Estonia', 'Spain', 'ES', 'Deutschland'].map(text => ({text, value: ''}));
    const hit = (c) => {
        const h = O.matchAmong(texts, c);
        return h ? h.text : null;
    };
    return {us: hit(['United States', 'US']), de: hit(['Deutschland', 'Germany', 'DE']), code: hit(['Spain', 'ES'])};
});
check('a long candidate does not loosely match a two-letter option', loose.us === null, String(loose.us));
check('an exact option and a country code still match', loose.de === 'Deutschland' && loose.code === 'Spain', JSON.stringify(loose));

await browser.close();
console.log(`\n${failures === 0 ? 'All widget checks passed.' : failures + ' check(s) failed.'}`);
process.exit(failures === 0 ? 0 : 1);
