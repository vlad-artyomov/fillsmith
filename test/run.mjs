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
    const G = globalThis.FillsmithGen;
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
/* Every rule carries its German spellings beside its English ones, and those
 * spellings used to be covered end to end by the PrimeVue fixture's own labels.
 * The fixture reads in English now — a German label has to be checked here, or
 * the alternatives are a branch nothing ever walks. */
const german = await page.evaluate(() => {
    const G = globalThis.FillsmithGen;
    const p = G.buildPersona('DE001', 'de-DE', {});
    const ask = (label) => {
        const v = G.matchRule(label, p);
        return Array.isArray(v) ? v[0] : v;
    };
    return {
        got: {
            'Straße und Hausnummer': ask('Straße und Hausnummer'),
            'PLZ': ask('PLZ'),
            'Stadt': ask('Stadt'),
            'Land': ask('Land'),
            'Firma': ask('Firma'),
            'Telefonnummer': ask('Telefonnummer'),
            'Rufnummer': ask('Rufnummer'),
            'Ansprechpartner': ask('Ansprechpartner'),
            'E-Mail-Adresse': ask('E-Mail-Adresse')
        },
        want: {
            'Straße und Hausnummer': p.street, 'PLZ': p.postal, 'Stadt': p.city, 'Land': p.country,
            'Firma': p.company, 'Telefonnummer': p.phone, 'Rufnummer': p.phone, 'Ansprechpartner': p.fullName,
            'E-Mail-Adresse': p.email
        }
    };
});
const germanMisses = Object.keys(german.want).filter(k => german.got[k] !== german.want[k]);
check('a German label reaches the same rule as its English twin',
    germanMisses.length === 0,
    germanMisses.map(k => `${k} → ${JSON.stringify(german.got[k])}`).join(', ') || 'all nine matched');

// Dates for widgets travel in the locale's format; a birth date must not become a future date.
const dates = await page.evaluate(() => {
    const G = globalThis.FillsmithGen;
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
    const G = globalThis.FillsmithGen;
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
    const G = globalThis.FillsmithGen;
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
check('fallback still respects maxlength', fallbacks.clipped.length <= 10, fallbacks.clipped);
check('an unlabelled field still gets something', fallbacks.unlabelled.length > 3, fallbacks.unlabelled);

/* A rule that can only ever return the same paragraph — "description",
 * "notes", "comment" — is a floor, not an answer. It stands aside when the
 * model has something to say; a rule encoding a fact the model cannot know
 * does not. */
const strength = await page.evaluate(() => {
    const G = globalThis.FillsmithGen;
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

/* Where a label goes, for the labels that used to go somewhere wrong. "Unit
 * price" was the second address line, "Boarding pass" a password, "Cost center"
 * a sum, "Mobile app version" a phone number, "Land area" a country, and a
 * German Steuernummer came out in the shape of a VAT id — none of which any
 * validator accepts. The right-hand side names the persona field a label must
 * reach, or `none` for a label no rule may claim. */
const routing = await page.evaluate(() => {
    const G = globalThis.FillsmithGen;
    const p = G.buildPersona('ROUTE1', 'de-DE', {});
    const where = (label) => {
        const d = G.matchRuleDetail(label, p);
        if (!d) return 'none';
        const v = Array.isArray(d.value) ? d.value[0] : d.value;
        // The second address line is "Unit 4" for a persona with no street2 of its own.
        const fields = Object.assign({}, p, {street2: p.street2 || 'Unit 4'});
        for (const k of ['password', 'phone', 'street2', 'amount', 'country', 'vatId', 'taxNumber', 'company', 'postal', 'city', 'street', 'jobTitle', 'department']) {
            if (String(fields[k]) === String(v)) return k;
        }
        return 'other';
    };
    const want = {
        'Unit price': 'amount',
        'Business unit': 'none',
        'Unit of measure': 'none',
        'Test suite': 'none',
        'Apt / Suite | address2': 'street2',
        'Address line 2': 'street2',
        'Adresszusatz': 'street2',
        'Boarding pass': 'none',
        'Season pass': 'none',
        'Password': 'password',
        'Passwort': 'password',
        'Confirm password': 'password',
        'Cost center': 'none',
        'Kostenstelle': 'none',
        'Total cost': 'amount',
        'Costs': 'amount',
        'Mobile app version': 'none',
        'Mobile': 'phone',
        'Mobile number': 'phone',
        'Cell phone': 'phone',
        'Land area': 'none',
        'Land': 'country',
        'Country': 'country',
        'Steuernummer': 'taxNumber',
        'Tax number': 'taxNumber',
        'Tax ID': 'vatId',
        'VAT': 'vatId',
        'USt-IdNr': 'vatId',
        'Postal code * | address zip': 'postal',
        'Firma': 'company',
        'Role': 'jobTitle',
        'Team': 'department'
    };
    const wrong = Object.entries(want).map(([label, k]) => [label, k, where(label)]).filter(([, k, got]) => k !== got);
    return {wrong, total: Object.keys(want).length};
});
check(`${routing.total} labels reach the field they mean, and no other`, routing.wrong.length === 0,
    routing.wrong.map(([l, k, got]) => `"${l}" → ${got}, wanted ${k}`).join('; ') || 'all routed');
check('a German tax number and a VAT id have different shapes', await page.evaluate(() => {
    const p = globalThis.FillsmithGen.buildPersona('TAX1', 'de-DE', {});
    return /^\d{2}\/\d{3}\/\d{5}$/.test(p.taxNumber) && /^DE\d{9}$/.test(p.vatId);
}));

/* ------------------------------------------------------- vocabulary ----
 * src/vocab.js is generated from faker (`npm run vocab`) and folded into the
 * curated pools. What matters is what survived that: the reason for taking
 * faker's *words* rather than faker itself was that most of its German is not
 * German, and all of the coherence this project depends on is ours. */
const vocab = await page.evaluate(() => {
    const G = globalThis.FillsmithGen;
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
            /* A phone number outside a range reserved for fiction is somebody's
             * number: US 555-01xx, and the Bundesnetzagentur's Drama-Nummern.
             * And however a form wants it written, it has to be the same one. */
            const DRAMA = {
                'de-DE': /^(493023125|494066969|498999998|492214710|496990009)\d{3}$|^(4917139200|49176040690)\d{2}$/,
                'en-US': /^1\d{3}55501\d{2}$/
            };
            if (!DRAMA[loc].test(p.phoneDigits)) broken.push(`${loc} phone outside the reserved ranges ${p.phoneDigits}`);
            /* One number, four spellings. The pretty form may leave the country
             * code off — "(312) 555-0186" — so what has to agree is the national
             * number inside each of them. */
            const nsn = p.phoneDigits.replace(/^(1|44|49)/, '');
            if (p.phoneE164 !== '+' + p.phoneDigits || !p.phone.replace(/\D/g, '').endsWith(nsn)
                || !p.phoneNational.replace(/\D/g, '').endsWith(nsn)) {
                broken.push(`${loc} phone spellings disagree ${p.phone} / ${p.phoneNational} / ${p.phoneDigits}`);
            }
            if (loc !== 'de-DE') continue;
            pairs.add(p.city + ' ' + p.postal);
            if (!/^\d{5}$/.test(p.postal)) broken.push('postal ' + p.postal);
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
    const G = globalThis.FillsmithGen;
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
        const G = globalThis.FillsmithGen;
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
    for (const f of window.__fillsmith.collectFields({overwrite: true})) {
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
const res = await page.evaluate(async () => await window.__fillsmith.run({
    seed: 'ABC123', locale: 'de-DE', useAI: false, overwrite: true, emailDomain: 'example.com'
}));

/* On a plain form there are no overlays, so the end-of-fill sweep never presses
 * anything and never moves focus as a side effect — which makes this the only
 * place the blur itself can be seen. A control that is still focused at the end
 * is one that can reopen its own list a tick later, after everything watching
 * has stopped looking; and a fill that finishes with the caret parked in the
 * last input it touched is untidy even when nothing reopens. */
/* A long list is answered from the whole of it. The options were truncated at
 * forty before anything chose among them, and on fill.dev's 250-country select
 * that put a US persona in Aruba, Belize or Burkina Faso, ten times out of ten,
 * reported as a rule that had matched. */
const longList = await page.evaluate(() => {
    const el = document.getElementById('cn2');
    return {value: el.value, options: el.options.length, index: el.selectedIndex};
});
check('a country past the fortieth option is still the one chosen',
    longList.options > 60 && /^(Germany|Deutschland)$/.test(longList.value),
    `${longList.value} at ${longList.index} of ${longList.options}`);

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
check('phone is country-code digits, no plus', /^49\d{10,11}$/.test(vals.ph), vals.ph);
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
await page.evaluate(async () => await window.__fillsmith.run({
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
await page.evaluate(async () => await window.__fillsmith.run({
    seed: 'ZZZ999', locale: 'de-DE', useAI: false, overwrite: true, emailDomain: 'example.com'
}));
const other = await page.evaluate(() => document.getElementById('em').value);
check('a different seed gives a different persona', other !== vals.em, `${other} vs ${vals.em}`);

// en-US locale coherence
await page.reload();
for (const f of FILLER) await page.addScriptTag({content: src(f)});
await page.evaluate(async () => await window.__fillsmith.run({
    seed: 'US0001', locale: 'en-US', useAI: false, overwrite: true, emailDomain: 'example.com'
}));
const us = await page.evaluate(() => ({
    ph: document.getElementById('ph').value,
    ct: document.getElementById('ct').value,
    cn: document.getElementById('cn').value,
    pc: document.getElementById('pc').value
}));
check('US locale: phone is country-code digits', /^1\d{10}$/.test(us.ph), us.ph);
// Only 555-0100 to 555-0199 is reserved for fiction; 555-1234 is somebody's number.
check('US phone stays inside the 555-01xx block', /^1\d{3}55501\d{2}$/.test(us.ph), us.ph);
check('US locale: ZIP is 5 digits', /^\d{5}$/.test(us.pc), us.pc);
check('US locale: country select picked US', us.cn === 'US', us.cn);

/* The mark on a written field is a ring that eases in and out, driven by an
 * attribute and one stylesheet; when it is over, the element is as it was. */
const ring = await page.evaluate(async () => {
    await window.__fillsmith.run({seed: 'RING1', locale: 'de-DE', useAI: false, overwrite: true});
    const marked = document.querySelectorAll('[data-fillsmith-touch]').length;
    const styled = !!document.getElementById('fillsmith-touch-style');
    const inlineOutline = Array.from(document.querySelectorAll('input'))
        .some(el => el.style.outline);
    await new Promise(r => setTimeout(r, 2300));
    return {marked, styled, inlineOutline, left: document.querySelectorAll('[data-fillsmith-touch]').length};
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
    const offered = window.__fillsmith.collectFields({overwrite: true})
        .filter(f => f.el && f.el.id === 'dw')
        .flatMap(f => (f.options || []).map(o => o.text));
    const picked = [];
    for (let i = 0; i < 12; i++) {
        await window.__fillsmith.run({seed: `PROMPT${i}`, locale: 'en-US', useAI: false, overwrite: true});
        picked.push(document.getElementById('dw').value);
    }
    return {offered, picked};
});
check('a sentinel prompt is not offered as an option',
    prompted.offered.length === 3 && !prompted.offered.some(t => /select/i.test(t)),
    prompted.offered.join(' | '));
check('and no fill ever writes it', prompted.picked.every(v => v !== '0' && v !== ''),
    `picked ${[...new Set(prompted.picked)].sort().join(',')}`);

/* The popup's colours, read from its stylesheet and measured the way WCAG
 * measures them: 4.5:1 for text, in both themes. The faint grey the footer,
 * the source tags and the section headings were set in read at 3.1:1 in the
 * light theme, and the tags on their own background at 2.7:1 — the smallest
 * text in the window was the hardest to see. */
const css = readFileSync(resolve(root, 'src/popup.css'), 'utf8');
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2].toLowerCase()]));
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const darkBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
const dark = Object.assign({}, light, tokens(darkBlock.slice(0, darkBlock.indexOf('}\n}') + 3)));
const luminance = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
// Text token on the backgrounds it is actually drawn on.
const PAIRS = [['fg', 'bg'], ['muted', 'bg'], ['muted', 'panel'], ['muted', 'line-soft'], ['faint', 'bg'], ['faint', 'panel'],
    ['warn', 'bg'], ['warn', 'warn-soft'], ['accent', 'bg'], ['accent', 'accent-soft'], ['accent-fg', 'accent']];
const low = [];
for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const [a, b] of PAIRS) {
        if (!t[a] || !t[b]) {
            low.push(`${name}: --${a} or --${b} missing`);
            continue;
        }
        const ratio = contrast(t[a], t[b]);
        if (ratio < 4.5) low.push(`${name} --${a} on --${b} ${ratio.toFixed(2)}:1`);
    }
}
check('every text colour in the popup clears WCAG AA on the background it sits on, in both themes',
    low.length === 0, low.join('; ') || `${PAIRS.length * 2} pairs at 4.5:1 or better`);

/* What the control says it accepts, applied the way the browser applies it: a
 * step counts from min, or from zero when there is no min; a pattern is
 * compiled with the flags HTML compiles it with, or \p{L} never matches. */
const limits = await page.evaluate(() => {
    const G = globalThis.FillsmithGen;
    return {
        stepNoMin: G.constrain('12', {min: null, max: null, step: 5}),
        stepMin: G.constrain('12', {min: 1, max: null, step: 5}),
        floatStep: G.constrain('0.34', {min: 0, max: 1, step: 0.1}),
        unicode: G.constrain('Anna Becker', {pattern: '[\\p{L} ]+'}),
        digitsOnly: G.constrain('Anna 12', {pattern: '\\d+'})
    };
});
check('a step with no min counts from zero', limits.stepNoMin === '10', limits.stepNoMin);
check('a step with a min counts from the min', limits.stepMin === '11', limits.stepMin);
check('a fractional step does not leave float noise', limits.floatStep === '0.3', limits.floatStep);
check('a pattern using \\p{L} is honoured, not skipped', limits.unicode === 'Anna Becker', limits.unicode);
check('a digits-only pattern narrows the value to its digits', limits.digitsOnly === '12', limits.digitsOnly);

/* The email domain is whatever the tester typed into a box: "@acme.test",
 * "acme" and "https://acme.test/" all used to reach the address as typed. */
const domains = await page.evaluate(() => {
    const G = globalThis.FillsmithGen;
    const at = (d) => G.buildPersona('DOM1', 'en-US', {emailDomain: d}).email.split('@')[1];
    return {
        at: at('@acme.test'), bare: at('acme'), url: at('https://acme.test/x'),
        upper: at('Example.ORG '), empty: at(''), fine: at('acme.co.uk')
    };
});
check('an email domain is cleaned before it is used', domains.at === 'acme.test' && domains.url === 'acme.test'
    && domains.upper === 'example.org' && domains.fine === 'acme.co.uk', JSON.stringify(domains));
check('and one that cannot be a domain falls back to example.com',
    domains.bare === 'example.com' && domains.empty === 'example.com', JSON.stringify(domains));

/* The model answers a rich-text field in prose, and prose tests nothing the
 * editor does. Its words are laid into the shape the rule builds, so a form
 * exercises the bold, the italic and the list whichever answered the field. */
const laidOut = await page.evaluate(() => {
    const G = globalThis.FillsmithGen;
    const en = G.buildPersona('RICH1', 'en-US', {});
    const de = G.buildPersona('RICH1', 'de-DE', {});
    const prose = 'The release fixes intermittent API failures. Query times are down by 15%. Accessibility was reviewed.';
    return {
        en: G.richLayout(prose, en),
        // Several shapes, so the German half is asked of all of them at once.
        de: ['a', 'b', 'c', 'd', 'e', 'f'].map(k => G.richLayout(prose, de, k)).join(''),
        short: G.richLayout('One sentence only.', en),
        again: G.richLayout('One sentence only.', en),
        // A different seed is a different page, and its made-up half says so.
        elsewhere: G.richLayout('One sentence only.', G.buildPersona('RICH2', 'en-US', {})),
        unsafe: G.richLayout('A <script>alert(1)</script> and an & sign.', en)
    };
});
/* One page carried five editors and every one of them opened with the same bold
 * "Note:" over the same bullet list — one trick, five times, and four of the
 * editor's paths never exercised. */
const shapes = await page.evaluate(() => {
    const G = globalThis.FillsmithGen;
    const p = G.buildPersona('SHAPES1', 'en-US', {});
    const out = ['Description', 'Instructions', 'Didactic notes', 'Accessories', 'Technical data',
        'Internal note', 'Summary', 'Remarks'].map(k => G.richLayout('', p, k));
    return {
        distinct: new Set(out).size,
        openings: new Set(out.map(h => h.slice(0, 24))).size,
        same: G.richLayout('', p, 'Description') === out[0],
        covers: {
            bold: out.some(h => /<strong>/.test(h)), italic: out.some(h => /<em>/.test(h)),
            bullets: out.some(h => /<ul>/.test(h)), numbers: out.some(h => /<ol>/.test(h))
        }
    };
});
check('two editors on one page do not get the same text',
    shapes.distinct === 8, `${shapes.distinct} distinct of 8`);
check('and between them they exercise bold, italic and both kinds of list',
    shapes.openings >= 3 && Object.values(shapes.covers).every(Boolean),
    `${shapes.openings} openings, ${JSON.stringify(shapes.covers)}`);
check('the same field on the same seed still says the same thing',
    shapes.same === true, String(shapes.same));

check('the model\'s words come back as markup an editor can hold',
    /<p>/.test(laidOut.en) && /<strong>|<em>|<li>/.test(laidOut.en),
    laidOut.en.slice(0, 90));
check('and its sentences are the ones used, not replaced',
    /intermittent API failures/.test(laidOut.en) && /Query times are down by 15%/.test(laidOut.en),
    laidOut.en.slice(0, 120));
check('a German fill gets the German words, in every shape that has them',
    /Hinweis|Zusammenfassung|Hintergrund|Checkliste/.test(laidOut.de)
    && /Bitte vor Freigabe prüfen/.test(laidOut.de)
    && !/\bNote:|Please review before release/.test(laidOut.de),
    laidOut.de.slice(0, 110));
check('an answer too short for the shape is made up, and the same seed says the same thing',
    /One sentence only\./.test(laidOut.short) && laidOut.short.length > 120
    && laidOut.short === laidOut.again && laidOut.elsewhere !== laidOut.short,
    laidOut.short.slice(0, 90));
check('and markup the model sent as text is escaped, not run',
    !/<script>/.test(laidOut.unsafe) && /&lt;script&gt;/.test(laidOut.unsafe) && /&amp; sign/.test(laidOut.unsafe),
    laidOut.unsafe.slice(0, 110));

/* Field names as real forms write them: the numbering glued to the word and the
 * vowels gone. Forty of these went to the model instead, and what came back was
 * plausible rather than correct — 555-123-4567 is not in the range reserved for
 * fiction, "1234567890" is not an SSN, and "RDouglas123" is not a card number.
 * Taken from roboform.com/filling-test-all-fields, one fill of it. */
const cryptic = await page.evaluate(() => {
    const G = globalThis.FillsmithGen;
    const p = G.buildPersona('CRYPT1', 'en-US', {emailDomain: 'example.com'});
    const at = (name) => {
        const hit = G.matchRuleDetail(name, p);
        return hit ? String(hit.value) : null;
    };
    return {
        persona: {city: p.city, region: p.region, phone: p.phone, email: p.email},
        got: {
            first: at('02frstname'), middle: at('03middle i'), last: at('04lastname'),
            full: at('04fullname'), line1: at('10address1'), line2: at('11address2'),
            state: at('14adrstate'), home: at('20homephon'), fax: at('22faxphone'),
            cell: at('23cellphon'), email: at('24emailadr'), site: at('25web site'),
            user: at('30 user id'), card: at('41ccnumber'), cvc: at('43cvc'),
            ssn: at('61pers ssn'), licence: at('62driv lic'), sex: at('60pers sex'),
            born: at('67birth pl'), income: at('68 income')
        },
        unmatched: ['45ccissuer', '46cccstsvc', '71 custom'].filter(n => !G.matchRuleDetail(n, p)),
        comment: (G.matchRuleDetail('72 commnt', p) || {}).value,
        /* What the model is shown. Given "46cccstsvc" it answered "XYZ-789";
         * alphabet soup is what a model writes when the label says nothing. */
        readable: ['45ccissuer', '46cccstsvc', '24emailadr', '62driv lic', '72 commnt']
            .map(n => G.readable(n))
    };
});
const c = cryptic.got;
const G0 = (names) => names.every(n => cryptic.unmatched.includes(n));
check('a name with its numbering glued on still reaches its rule',
    c.first && c.last && c.full && c.line1 && c.line2 && c.middle && c.middle.length === 1,
    `${c.first} / ${c.middle} / ${c.last} / ${c.line1} / ${c.line2}`);
check('an abbreviated name reaches it too, where the abbreviation means one thing',
    c.home && c.fax && c.cell && c.email && c.state && c.user && c.card && c.cvc,
    `${c.home} · ${c.email} · ${c.state} · ${c.card}`);
/* The point of answering these ourselves. A model asked the same boxes wrote
 * 555-123-4567, which is a number somebody may well have. */
check('and what the rules write there is reserved, not merely plausible',
    c.home === cryptic.persona.phone && /555-01\d\d/.test(c.home.replace(/[^\d-]/g, ''))
    && /^987-65-432\d$/.test(c.ssn) && c.card.startsWith('4111'),
    `${c.home} · ${c.ssn} · ${c.card}`);
check('the state agrees with the city rather than being invented',
    c.state === cryptic.persona.region, `${c.state} for ${cryptic.persona.city}`);
/* "birth" alone answered a place of birth with a date of birth. */
check('a place of birth is a place',
    c.born === cryptic.persona.city, String(c.born));
check('a salary is an annual figure, not a line total',
    /^\d{5,6}$/.test(c.income || ''), String(c.income));
check('and the model is still left the ones it is better at',
    G0(['45ccissuer', '46cccstsvc', '71 custom']), cryptic.unmatched.join(', '));
check('a misspelt comment box gets prose rather than a guess',
    typeof cryptic.comment === 'string' && cryptic.comment.split(' ').length > 3,
    String(cryptic.comment).slice(0, 50));
check('and what the model is shown is a name a person could read',
    cryptic.readable[0] === 'credit card issuer'
    && cryptic.readable[1] === 'credit card customer service'
    && cryptic.readable[2] === 'email address'
    && cryptic.readable[3] === 'driving licence number',
    cryptic.readable.join(' · '));

// Clear
await page.evaluate(async () => await window.__fillsmith.clearAll());
const cleared = await page.evaluate(() => document.getElementById('fn').value);
check('clear empties the fields', cleared === '');

await browser.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) failed.'}`);
process.exit(failures === 0 ? 0 : 1);
