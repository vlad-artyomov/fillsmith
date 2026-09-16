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
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
    if (!cond) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => {
    if (m.type() === 'error') console.log('   page error:', m.text());
});
await page.goto('file://' + resolve(root, 'test/form.html'));
for (const f of FILLER) await page.addScriptTag({content: src(f)});

/* Rule matching against labels taken verbatim from a real PrimeVue admin form.
 * `describe()` folds the name attribute into the label, so `address.zip`
 * reads as "address zip" — which a general street/address rule placed above
 * the specific ones claims, writing a street into the postcode, the city and
 * the country alike. Ordering is the whole fix, so it needs a guard. */
const ruleCases = await page.evaluate(() => {
    const G = globalThis.FormForgeGen;
    const p = G.buildPersona('LIVE001', 'de-DE', {});
    const ask = (label) => {
        const v = G.matchRule(label, p);
        return Array.isArray(v) ? v[0] : v;
    };
    return {
        zip: ask('Postal code * | Postal code * | address zip | address zip'),
        city: ask('City * | City * | address city | address city'),
        street: ask('Street and house number * | address streetAndNumber'),
        country: ask('Country | address countryId | address countryId | Country *'),
        person: ask('Contact Person * | contactPersons 0 name'),
        phone: ask('Phone Number * | Phone Number | (99) 999 9999 | contactPersons 0 phone'),
        phoneCountry: ask('Phone Number | contactPersons 0 phoneCountryList | contactPersons 0 phoneCountryList'),
        want: {postal: p.postal, city: p.city, street: p.street, country: p.country, full: p.fullName}
    };
});
check('postcode rule beats the generic address rule', ruleCases.zip === ruleCases.want.postal, ruleCases.zip);
check('city rule beats the generic address rule', ruleCases.city === ruleCases.want.city, ruleCases.city);
check('country rule beats the generic address rule', ruleCases.country === ruleCases.want.country, ruleCases.country);
check('street still resolves to a street', ruleCases.street === ruleCases.want.street, ruleCases.street);
check('"Contact Person" resolves to a person, not a company', ruleCases.person === ruleCases.want.full, ruleCases.person);
// Dates for widgets travel in the locale's format; a birth date must not become a future date.
const dates = await page.evaluate(() => {
    const G = globalThis.FormForgeGen;
    const p = G.buildPersona('BD1', 'de-DE', {});
    return {
        de: G.formatDate('1978-04-09', 'DD.MM.YYYY'), us: G.formatDate('1978-04-09', 'MM/DD/YYYY'),
        birth: G.matchRule('Geburtsdatum *', p), fmt: p.dateFormat,
        initialStock: G.matchRule('Initial stock', p), middleInitial: G.matchRule('Middle initial', p)
    };
});
check('formatDate writes the locale shape', dates.de === '09.04.1978' && dates.us === '04/09/1978', `${dates.de} ${dates.us}`);
check('a birth date is a past ISO date and the persona knows its format',
    /^(19|20)\d\d-\d\d-\d\d$/.test(dates.birth) && dates.birth < new Date().toISOString().slice(0, 10) && dates.fmt === 'DD.MM.YYYY', `${dates.birth} ${dates.fmt}`);
check('"Initial stock" is not an initial, "Middle initial" is',
    dates.initialStock === null && typeof dates.middleInitial === 'string' && dates.middleInitial.length === 1,
    `${dates.initialStock} / ${dates.middleInitial}`);

/* A pair of numeric fields must read as a range, not as the same number
 * twice: "minimum 3 / maximum 3" exercises nothing. */
const numbers = await page.evaluate(() => {
    const G = globalThis.FormForgeGen;
    const p = G.buildPersona('NUM001', 'de-DE', {});
    return {
        min: Number(G.numberFor('Minimum booking duration *', p)),
        max: Number(G.numberFor('Maximum booking duration *', p)),
        lead: Number(G.numberFor('Minimum lead time before pick-up *', p)),
        plain: Number(G.numberFor('Kapazität', p))
    };
});
check('a maximum comes out larger than a minimum',
    numbers.max > numbers.min, `min=${numbers.min} max=${numbers.max}`);
check('numeric fields get whole, positive values',
    [numbers.min, numbers.max, numbers.lead, numbers.plain].every(n => Number.isInteger(n) && n >= 0),
    JSON.stringify(numbers));

/* The last resort is the thing most likely to be read by a human wondering
 * what happened, so it should name the field it landed in rather than the
 * generator that produced it. */
const fallbacks = await page.evaluate(() => {
    const G = globalThis.FormForgeGen;
    const p = G.buildPersona('H65RFM', 'en-US', {});
    const f = (label, maxLength) => G.fallbackText({label, maxLength: maxLength || null}, p);
    return {
        prereq: f('Prerequisite * | Prerequisite | prerequisite'),
        area: f('Area of Responsibility * | contactPersons 0 responsibilityArea'),
        clipped: f('Prerequisite * | Prerequisite', 10),
        unlabelled: f('')
    };
});
/* It used to be the caption with a number after it — "Prerequisite 43" — which
   traces nicely and exercises nothing, and makes a filled form look in a
   screenshot like the filler gave up. Which field got what is the Debug tab's
   job, not the value's. */
check('fallback text reads as content, not as the field\'s own caption',
    !/prerequisite/i.test(fallbacks.prereq) && /[\p{L}]{3}/u.test(fallbacks.prereq), fallbacks.prereq);
check('two fields in a row do not get the same text',
    fallbacks.prereq !== fallbacks.area, `${fallbacks.prereq} / ${fallbacks.area}`);
check('a field too narrow for a phrase still gets a word, not a bare number',
    /[\p{L}]{3}/u.test(fallbacks.clipped), fallbacks.clipped);
check('fallback still respects maxlength', fallbacks.clipped.length <= 8, fallbacks.clipped);
check('an unlabelled field still gets something', fallbacks.unlabelled.length > 3, fallbacks.unlabelled);

/* A rule that can only ever return the same paragraph — "description",
 * "notes", "comment" — is a floor, not an answer. It stands aside when the
 * model has something to say; a rule encoding a fact the model cannot know
 * does not. */
const strength = await page.evaluate(() => {
    const G = globalThis.FormForgeGen;
    const p = G.buildPersona('W1', 'de-DE', {});
    const tag = (l) => {
        const d = G.matchRuleDetail(l, p);
        return d ? (d.weak ? 'weak' : 'strong') : 'none';
    };
    return {
        info: tag('Booking information'), desc: tag('Description'), subject: tag('Betreff'),
        email: tag('E-mail *'), postcode: tag('Postal code'), iban: tag('IBAN'), phone: tag('Phone number')
    };
});
check('generic content rules are weak', [strength.info, strength.desc, strength.subject]
    .every(x => x === 'weak'), JSON.stringify(strength));
check('rules encoding a fact stay strong', [strength.email, strength.postcode, strength.iban, strength.phone]
    .every(x => x === 'strong'), JSON.stringify(strength));

/* ------------------------------------------------------- vocabulary ----
 * src/vocab.js is generated from faker (`npm run vocab`) and folded into the
 * curated pools. What matters is what survived that: the reason for taking
 * faker's *words* rather than faker itself was that most of its German is not
 * German, and all of the coherence this project depends on is ours. */
const vocab = await page.evaluate(() => {
    const G = globalThis.FormForgeGen;
    const seen = {};
    const broken = [];
    const pairs = new Set();
    for (let i = 0; i < 2000; i++) {
        for (const loc of ['de-DE', 'en-US']) {
            const p = G.buildPersona(G.newSeed(), loc, {});
            const at = (seen[loc] = seen[loc] || {});
            for (const k of ['firstName', 'lastName', 'jobTitle', 'color', 'productName']) {
                (at[k] = at[k] || new Set()).add(p[k]);
            }
            if (loc !== 'de-DE') continue;
            pairs.add(p.city + ' ' + p.postal);
            if (!/^\d{5}$/.test(p.postal)) broken.push('postal ' + p.postal);
            if (!/^49\d{9}$/.test(p.phoneDigits)) broken.push('phone ' + p.phoneDigits);
            if (!/^DE\d{20}$/.test(p.iban)) broken.push('iban ' + p.iban);
            if (/\b(lorem|ipsum|dolor|repellendus)\b/i.test(p.paragraph)) broken.push('latin prose');
            if (/\b(Manager|Executive|Officer|Specialist|Director|Analyst)\b/.test(p.jobTitle)) {
                broken.push('English job title in de: ' + p.jobTitle);
            }
        }
    }
    return {
        counts: Object.fromEntries(Object.entries(seen).map(([l, g]) =>
            [l, Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.size]))])),
        pairs: [...pairs], broken: [...new Set(broken)].slice(0, 3), brokenCount: broken.length
    };
});

/* Twenty first names meant a tester saw the same person every few fills. */
check('the vendored words widen the name pools',
    vocab.counts['de-DE'].firstName > 300 && vocab.counts['de-DE'].lastName > 300
    && vocab.counts['en-US'].firstName > 300,
    `de ${vocab.counts['de-DE'].firstName}/${vocab.counts['de-DE'].lastName}, en ${vocab.counts['en-US'].firstName}`);
/* faker has no German job titles — `fakerDE.person.jobTitle()` answers
 * "Regional Security Executive" — so those are written by hand and the
 * English ones vendored. English words under a German locale label are worse
 * test data than a short list of real ones. */
check('German stays German', vocab.brokenCount === 0, vocab.broken.join(' | ') || 'clean');
check('and English gets faker\'s breadth', vocab.counts['en-US'].jobTitle > 200,
    `${vocab.counts['en-US'].jobTitle} job titles`);

/* The line that decided against the library itself: faker's German cities are
 * invented from name fragments and its postcodes do not match them — 75605 is
 * Alpirsbach, not Berlin. Twelve real pairs beat three thousand wrong ones on
 * any form that checks them, so the city table stayed ours. */
check('every city still carries its own postcode',
    vocab.pairs.length === 12 && vocab.pairs.every(p => /^[^\d]+ \d{5}$/.test(p)),
    vocab.pairs.slice(0, 3).join(', '));

/* The point of the exercise: a category the vocabulary unlocked is a field the
 * model no longer has to be asked about. */
const unlocked = await page.evaluate(() => {
    const G = globalThis.FormForgeGen;
    const p = G.buildPersona('VOC1', 'de-DE', {});
    const ask = (l) => {
        const v = G.matchRule(l, p);
        return Array.isArray(v) ? v[0] : v;
    };
    return {
        colour: ask('Farbe'), product: ask('Gerätebezeichnung'), role: ask('Funktion'),
        want: {colour: p.color, product: p.productName, role: p.jobTitle}
    };
});
check('a colour field is answered locally now',
    unlocked.colour === unlocked.want.colour && !!unlocked.colour, unlocked.colour);
check('and an equipment field', unlocked.product === unlocked.want.product, unlocked.product);
check('and a role field', unlocked.role === unlocked.want.role, unlocked.role);

/* src/vocab.js is generated, and a generated file can be missing or
 * half-written. The vendored words are folded *into* the curated pools rather
 * than replacing them, so without the file a fill gets shorter lists — never
 * an exception, and never a field with nothing in it. */
const alone = await (async () => {
    const solo = await browser.newPage();
    const errors = [];
    solo.on('pageerror', e => errors.push(String(e.message)));
    await solo.setContent('<html></html>');
    await solo.addScriptTag({content: src('generator.js')});      // deliberately no vocab.js
    const out = await solo.evaluate(() => {
        const G = globalThis.FormForgeGen;
        const p = G.buildPersona('NOVOC', 'de-DE', {});
        const names = new Set();
        for (let i = 0; i < 400; i++) names.add(G.buildPersona(G.newSeed(), 'de-DE', {}).firstName);
        return {
            name: p.fullName, job: p.jobTitle, color: p.color, product: p.productName,
            postal: p.postal, distinct: names.size
        };
    });
    await solo.close();
    return {...out, errors};
})();
check('the generator works with the generated file missing',
    alone.errors.length === 0 && !!alone.name && !!alone.job && !!alone.color && !!alone.product
    && /^\d{5}$/.test(alone.postal),
    alone.errors[0] || `${alone.name} · ${alone.job} · ${alone.color} · ${alone.product}`);
check('and simply has less to choose from', alone.distinct <= 25 && alone.distinct > 5,
    `${alone.distinct} first names without it`);

/* A field's section should be the heading above it, not whatever sits at the
 * top of the form — the same label on every field sounds specific and says
 * nothing. */
const sections = await page.evaluate(() => {
    const seen = {};
    for (const f of window.__formforge.collectFields({overwrite: true})) {
        const k = f.label.split('|')[0].trim();
        if (k) seen[k] = f.section;
    }
    return seen;
});
const distinct = new Set(Object.values(sections).filter(Boolean));
check('fields report the heading nearest above them', distinct.size >= 2,
    [...distinct].join(' / ') || '(none)');

check('the phone number field still gets a number', /^\+/.test(ruleCases.phone || ''), ruleCases.phone);
check('a phone country picker gets a country, not the number',
    ruleCases.phoneCountry === ruleCases.want.country, ruleCases.phoneCountry);

// Deterministic path only (no extension runtime here, so no model).
const res = await page.evaluate(async () => await window.__formforge.run({
    seed: 'ABC123', locale: 'de-DE', useAI: false, overwrite: true, emailDomain: 'example.com'
}));

/* On a plain form there are no overlays, so the end-of-fill sweep never presses
 * anything and never moves focus as a side effect — which makes this the only
 * place the blur itself can be seen. A control that is still focused at the end
 * is one that can reopen its own list a tick later, after everything watching
 * has stopped looking; and a fill that finishes with the caret parked in the
 * last input it touched is untidy even when nothing reopens. */
const parked = await page.evaluate(() => document.activeElement.tagName
    + (document.activeElement.id ? '#' + document.activeElement.id : ''));
check('the fill lets go of the field it finished on', parked === 'BODY', parked);

const vals = await page.evaluate(() => {
    const g = id => document.getElementById(id);
    return {
        fn: g('fn').value, ln: g('ln').value, em: g('em').value, ph: g('ph').value,
        co: document.querySelector('[name="orgName"]').value, jt: g('jt').value,
        s1: g('s1').value, pc: g('pc').value, ct: g('ct').value, cn: g('cn').value,
        ib: g('ib').value, vt: g('vt').value,
        pcode: g('pcode').value, just: g('just').value, sla: g('sla').value,
        hc: g('hc').value, sd: g('sd').value,
        risk: (document.querySelector('input[name="risk"]:checked') || {}).value,
        terms: document.querySelector('[name="terms"]').checked,
        captcha: document.querySelector('[name="captcha_answer"]').value,
        scope: g('scope').value,
        csrf: document.querySelector('[name="csrf"]').value,
        disabled: document.querySelector('[name="disabled_field"]').value,
        events: window.__events
    };
});

console.log('\nFilled values:');
for (const [k, v] of Object.entries(vals)) if (k !== 'events') console.log(`  ${k.padEnd(8)} ${JSON.stringify(v)}`);
console.log('');

const DE_CITIES = ['Berlin', 'Hamburg', 'München', 'Köln', 'Frankfurt am Main', 'Stuttgart',
    'Düsseldorf', 'Leipzig', 'Dresden', 'Hannover', 'Nürnberg', 'Bremen'];

check('fills a meaningful number of fields', res.count >= 15, `count=${res.count}`);
check('first name is a real name', /^[A-ZÄÖÜ][a-zäöüß]+$/.test(vals.fn), vals.fn);
check('email matches the persona name', vals.em.startsWith(vals.fn.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')), vals.em);
check('email is syntactically valid', /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(vals.em), vals.em);
/* Digits, country code, no plus. The real form accepts 49xxxxxxxxx and
 * rejects the same number written with a plus or with spaces, so a phone
 * field gets the plain-digit form regardless of how pretty the alternative
 * looks. Eleven digits is what a German number comes to. */
check('phone is country-code digits, no plus', /^49\d{9}$/.test(vals.ph), vals.ph);
check('city is a real German city', DE_CITIES.includes(vals.ct), vals.ct);
check('postcode fits the city', vals.pc.length === 5 && /^\d{5}$/.test(vals.pc), vals.pc);
check('street has a house number', /\d/.test(vals.s1), vals.s1);
check('country select landed on Germany', vals.cn === 'DE', vals.cn);
check('job title is from the vocabulary, not noise', vals.jt.length > 3 && /[A-Za-z]/.test(vals.jt), vals.jt);
check('respects maxlength on postcode', vals.pc.length <= 10);
check('number input honours min/max', Number(vals.hc) >= 1 && Number(vals.hc) <= 50, vals.hc);
check('date input is a valid ISO date', /^\d{4}-\d{2}-\d{2}$/.test(vals.sd), vals.sd);
check('radio group got exactly one selection', ['low', 'medium', 'high'].includes(vals.risk), vals.risk);
check('required consent checkbox is ticked', vals.terms === true);
check('select with no rule still picked a real option', ['Bronze', 'Silver', 'Gold'].includes(vals.sla), vals.sla);
check('project code field was filled with something', vals.pcode.length > 0 && vals.pcode.length <= 12, vals.pcode);
check('free-text field got a sentence, not junk', vals.just.length > 20 && !/asdf|lorem|test123/i.test(vals.just));
check('captcha field left alone', vals.captcha === '');
// "Umfang" contains "mfa"; the CAPTCHA/MFA skip must match whole words only.
check('a label that merely contains "mfa" is still filled', vals.scope.length > 0, vals.scope);
check('hidden field left alone', vals.csrf === 'xyz');
check('disabled field left alone', vals.disabled === '');
check('input events fired for framework bindings', vals.events.input >= 15, JSON.stringify(vals.events));
check('change events fired', vals.events.change >= 15);

// IBAN mod-97
const ibanOk = (() => {
    const s = vals.ib.replace(/\s/g, '');
    if (!/^DE\d{20}$/.test(s)) return false;
    const re = s.slice(4) + s.slice(0, 4);
    let rem = 0;
    for (const ch of re) {
        const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
        for (const d of v) rem = (rem * 10 + Number(d)) % 97;
    }
    return rem === 1;
})();
check('IBAN passes the mod-97 checksum', ibanOk, vals.ib);

// German USt-IdNr check digit
const vatOk = (() => {
    const s = vals.vt;
    if (!/^DE\d{9}$/.test(s)) return false;
    const base = s.slice(2, 10), expect = Number(s[10]);
    let p = 10;
    for (const ch of base) {
        let x = (Number(ch) + p) % 10;
        if (x === 0) x = 10;
        p = (2 * x) % 11;
    }
    return ((11 - p) % 10) === expect;
})();
check('VAT ID passes the German check-digit algorithm', vatOk, vals.vt);

// Determinism
await page.reload();
for (const f of FILLER) await page.addScriptTag({content: src(f)});
await page.evaluate(async () => await window.__formforge.run({
    seed: 'ABC123', locale: 'de-DE', useAI: false, overwrite: true, emailDomain: 'example.com'
}));
const again = await page.evaluate(() => ({
    fn: document.getElementById('fn').value,
    em: document.getElementById('em').value,
    ib: document.getElementById('ib').value,
    ct: document.getElementById('ct').value,
    sla: document.getElementById('sla').value,
    risk: (document.querySelector('input[name="risk"]:checked') || {}).value,
    news: document.querySelector('[name="newsletter"]').checked
}));
check('same seed reproduces the same persona',
    again.fn === vals.fn && again.em === vals.em && again.ib === vals.ib && again.ct === vals.ct,
    `${again.fn}/${vals.fn}`);
check('same seed reproduces the same dropdown/radio/checkbox choices',
    again.sla === vals.sla && again.risk === vals.risk,
    `sla ${again.sla}/${vals.sla}, risk ${again.risk}/${vals.risk}`);

// Different seed -> different persona
await page.reload();
for (const f of FILLER) await page.addScriptTag({content: src(f)});
await page.evaluate(async () => await window.__formforge.run({
    seed: 'ZZZ999', locale: 'de-DE', useAI: false, overwrite: true, emailDomain: 'example.com'
}));
const other = await page.evaluate(() => document.getElementById('em').value);
check('a different seed gives a different persona', other !== vals.em, `${other} vs ${vals.em}`);

// en-US locale coherence
await page.reload();
for (const f of FILLER) await page.addScriptTag({content: src(f)});
await page.evaluate(async () => await window.__formforge.run({
    seed: 'US0001', locale: 'en-US', useAI: false, overwrite: true, emailDomain: 'example.com'
}));
const us = await page.evaluate(() => ({
    ph: document.getElementById('ph').value,
    ct: document.getElementById('ct').value,
    cn: document.getElementById('cn').value,
    pc: document.getElementById('pc').value
}));
check('US locale: phone is country-code digits', /^1\d{10}$/.test(us.ph), us.ph);
// The fiction block survives the reshaping: 555 is never a real subscriber.
check('US phone stays inside the 555 range', /^1\d{3}555/.test(us.ph), us.ph);
check('US locale: ZIP is 5 digits', /^\d{5}$/.test(us.pc), us.pc);
check('US locale: country select picked US', us.cn === 'US', us.cn);

/* The mark on a written field is a ring that eases in and out, driven by an
 * attribute and one stylesheet; when it is over, the element is as it was. */
const ring = await page.evaluate(async () => {
    await window.__formforge.run({seed: 'RING1', locale: 'de-DE', useAI: false, overwrite: true});
    const marked = document.querySelectorAll('[data-formforge-touch]').length;
    const styled = !!document.getElementById('formforge-touch-style');
    const inlineOutline = Array.from(document.querySelectorAll('input'))
        .some(el => el.style.outline);
    await new Promise(r => setTimeout(r, 2300));
    return {marked, styled, inlineOutline, left: document.querySelectorAll('[data-formforge-touch]').length};
});
check('written fields carry the touch ring, through a stylesheet rather than inline styles',
    ring.marked > 0 && ring.styled && !ring.inlineOutline, JSON.stringify(ring));
check('and the ring is gone two seconds later', ring.left === 0, `${ring.left} still marked`);

/* A prompt is not a choice. "(Select Card Type)", "Month", "Year" are all
 * value="0" beside real options, so a filter that only drops value="" keeps
 * them, and a seeded pick lands on one every few fills — writing the control's
 * empty state into the report as if the page had accepted it. Twelve seeds is
 * enough: with four options one in four picks would be the prompt. */
const prompted = await page.evaluate(async () => {
    const offered = window.__formforge.collectFields({overwrite: true})
        .filter(f => f.el && f.el.id === 'dw')
        .flatMap(f => (f.options || []).map(o => o.text));
    const picked = [];
    for (let i = 0; i < 12; i++) {
        await window.__formforge.run({seed: `PROMPT${i}`, locale: 'en-US', useAI: false, overwrite: true});
        picked.push(document.getElementById('dw').value);
    }
    return {offered, picked};
});
check('a sentinel prompt is not offered as an option',
    prompted.offered.length === 3 && !prompted.offered.some(t => /select/i.test(t)),
    prompted.offered.join(' | '));
check('and no fill ever writes it', prompted.picked.every(v => v !== '0' && v !== ''),
    `picked ${[...new Set(prompted.picked)].sort().join(',')}`);

// Clear
await page.evaluate(() => window.__formforge.clearAll());
const cleared = await page.evaluate(() => document.getElementById('fn').value);
check('clear empties the fields', cleared === '');

await browser.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) failed.'}`);
process.exit(failures === 0 ? 0 : 1);
