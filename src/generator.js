/* FormForge — deterministic test-data generator.
 *
 * Everything derives from a seed, so the same seed always yields the same
 * persona and the same choices. No DOM, no network: every function here is
 * pure and testable on its own.
 */
(function () {
    'use strict';

    // ------------------------------------------------------------------ rng ----
    function mulberry32(a) {
        return function () {
            a |= 0;
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function seedFromString(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function newSeed() {
        return Math.random().toString(36).slice(2, 8).toUpperCase();
    }

    const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
    const pad = (n) => String(n).padStart(2, '0');

    // ---------------------------------------------------------- locale data ----
    /* Cities, postcodes and area codes are real and agree with each other, which
     * is why they are curated here rather than taken from faker. Phone numbers
     * come from ranges reserved for fiction (US 555-01xx, DE 23125 xxx). */
    const LOCALES = {
        'en-US': {
            label: 'English',
            prose: 'en',
            first: ['James', 'Michael', 'Robert', 'David', 'Daniel', 'Christopher', 'Matthew', 'Andrew', 'Joshua', 'Ryan',
                'Mary', 'Jennifer', 'Linda', 'Patricia', 'Elizabeth', 'Susan', 'Jessica', 'Sarah', 'Karen', 'Emily'],
            last: ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
                'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin'],
            streets: ['Maple Street', 'Oak Avenue', 'Cedar Lane', 'Park Avenue', 'Washington Street', 'Lakeview Drive',
                'Highland Road', 'Sunset Boulevard', 'Chestnut Street', 'Birch Court'],
            places: [
                {city: 'New York', region: 'NY', postal: '10001', area: '212'},
                {city: 'Los Angeles', region: 'CA', postal: '90012', area: '213'},
                {city: 'Chicago', region: 'IL', postal: '60601', area: '312'},
                {city: 'Houston', region: 'TX', postal: '77002', area: '713'},
                {city: 'Phoenix', region: 'AZ', postal: '85003', area: '602'},
                {city: 'Philadelphia', region: 'PA', postal: '19103', area: '215'},
                {city: 'San Diego', region: 'CA', postal: '92101', area: '619'},
                {city: 'Dallas', region: 'TX', postal: '75201', area: '214'},
                {city: 'Austin', region: 'TX', postal: '78701', area: '512'},
                {city: 'Seattle', region: 'WA', postal: '98101', area: '206'},
                {city: 'Denver', region: 'CO', postal: '80202', area: '303'},
                {city: 'Boston', region: 'MA', postal: '02108', area: '617'},
                {city: 'Portland', region: 'OR', postal: '97204', area: '503'},
                {city: 'Atlanta', region: 'GA', postal: '30303', area: '404'}
            ],
            companySuffix: ['Inc.', 'LLC', 'Corp.', 'Group', 'Partners'],
            country: 'United States', countryCode: 'US',
            phone: (r, place) => `(${place.area}) 555-01${String(10 + Math.floor(r() * 89)).padStart(2, '0')}`,
            phoneNational: (r, place) => `${place.area}55501${String(10 + Math.floor(r() * 89)).padStart(2, '0')}`,
            phoneDigits: (r, place) => `1${place.area}555${String(1000 + Math.floor(r() * 8999))}`,
            phoneE164: (r, place) => `+1${place.area}55501${String(10 + Math.floor(r() * 89)).padStart(2, '0')}`,
            address: (r, place, street) => `${100 + Math.floor(r() * 8900)} ${street}`,
            dateFormat: 'MM/DD/YYYY'
        },

        'de-DE': {
            label: 'Deutsch',
            prose: 'de',
            first: ['Lukas', 'Jonas', 'Leon', 'Felix', 'Maximilian', 'Paul', 'Thomas', 'Stefan', 'Andreas', 'Michael',
                'Anna', 'Lena', 'Sophie', 'Marie', 'Emma', 'Laura', 'Katharina', 'Julia', 'Claudia', 'Petra'],
            last: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann',
                'Koch', 'Richter', 'Klein', 'Wolf', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Krüger', 'Hofmann'],
            streets: ['Hauptstraße', 'Bahnhofstraße', 'Lindenweg', 'Gartenstraße', 'Schillerstraße', 'Goethestraße',
                'Ringstraße', 'Amselweg', 'Mozartstraße', 'Kirchgasse'],
            places: [
                {city: 'Berlin', region: 'Berlin', postal: '10115', area: '30'},
                {city: 'Hamburg', region: 'Hamburg', postal: '20095', area: '40'},
                {city: 'München', region: 'Bayern', postal: '80331', area: '89'},
                {city: 'Köln', region: 'Nordrhein-Westfalen', postal: '50667', area: '221'},
                {city: 'Frankfurt am Main', region: 'Hessen', postal: '60311', area: '69'},
                {city: 'Stuttgart', region: 'Baden-Württemberg', postal: '70173', area: '711'},
                {city: 'Düsseldorf', region: 'Nordrhein-Westfalen', postal: '40213', area: '211'},
                {city: 'Leipzig', region: 'Sachsen', postal: '04109', area: '341'},
                {city: 'Dresden', region: 'Sachsen', postal: '01067', area: '351'},
                {city: 'Hannover', region: 'Niedersachsen', postal: '30159', area: '511'},
                {city: 'Nürnberg', region: 'Bayern', postal: '90402', area: '911'},
                {city: 'Bremen', region: 'Bremen', postal: '28195', area: '421'}
            ],
            companySuffix: ['GmbH', 'AG', 'GmbH & Co. KG', 'SE', 'KG'],
            country: 'Deutschland', countryCode: 'DE',
            phone: (r, place) => `+49 ${place.area} 23125 ${String(Math.floor(r() * 900) + 100)}`,
            phoneNational: (r, place) => `${place.area} 23125 ${String(Math.floor(r() * 900) + 100)}`,
            // Country code, no plus, no spaces: the shape strict phone validators accept.
            phoneDigits: (r, place) => {
                const nsn = (place.area + '23125' + String(Math.floor(r() * 100)).padStart(2, '0')).slice(0, 9);
                return `49${nsn.padEnd(9, '0')}`;
            },
            phoneE164: (r, place) => `+49${place.area}23125${String(Math.floor(r() * 900) + 100)}`,
            address: (r, place, street) => `${street} ${1 + Math.floor(r() * 180)}`,
            dateFormat: 'DD.MM.YYYY'
        }
    };

    /* The generated vocabulary (src/vocab.js) is folded into the curated lists,
     * not swapped in for them: the hand-written names are the common ones, and a
     * missing vocab file must mean shorter lists rather than an exception. */
    const V = globalThis.FormForgeVocab || {};
    const vocab = (localeKey, key) => (V[localeKey === 'de-DE' ? 'de' : 'en'] || {})[key] || [];
    const widen = (localeKey, key, base) => {
        const more = vocab(localeKey, key);
        return more.length ? base.concat(more.filter(x => !base.includes(x))) : base;
    };
    for (const key of Object.keys(LOCALES)) {
        LOCALES[key].first = widen(key, 'first', LOCALES[key].first);
        LOCALES[key].last = widen(key, 'last', LOCALES[key].last);
    }

    const COMPANY_STEMS = ['Nordwind', 'Blauberg', 'Sonnenfeld', 'Kranich', 'Steinbach', 'Waldner', 'Elbtal',
        'Rheinlicht', 'Silverpine', 'Redstone', 'Clearwater', 'Northgate', 'Brightmoor',
        'Kestrel', 'Halcyon', 'Meridian'];
    const COMPANY_TAIL = ['Systeme', 'Technik', 'Logistik', 'Software', 'Industrie', 'Consulting', 'Medien',
        'Energie', 'Analytics', 'Digital', 'Labs', 'Solutions'];

    // Per locale: faker has no German job titles, so the German lists are hand-written.
    const JOB_TITLES = {
        'en-US': ['Software Engineer', 'QA Engineer', 'Product Manager', 'Operations Lead', 'Data Analyst',
            'Account Manager', 'Technical Writer', 'Support Specialist', 'Finance Controller', 'UX Designer'],
        'de-DE': ['Softwareentwickler', 'Projektmanagerin', 'Sachbearbeiter', 'Disponentin',
            'Fuhrparkleiter', 'Qualitätsmanagerin', 'Buchhalter', 'Kundenberaterin',
            'Systemadministrator', 'Werkstattleiterin']
    };
    const DEPARTMENTS = {
        'en-US': ['Engineering', 'Quality Assurance', 'Operations', 'Finance', 'Marketing', 'Customer Support',
            'Human Resources', 'Legal', 'Procurement', 'Research'],
        'de-DE': ['Entwicklung', 'Qualitätssicherung', 'Betrieb', 'Finanzen', 'Marketing', 'Kundendienst',
            'Personalwesen', 'Recht', 'Einkauf', 'Forschung']
    };
    const localeList = (table, localeKey, key) => widen(localeKey, key, table[localeKey] || table['en-US']);

    // Deliberately dull and obviously synthetic: this text ends up in other people's screenshots.
    const PROSE = {
        en: [
            'Recorded during automated testing; the content carries no business meaning.',
            'Collected for a scheduled review and kept for reference only.',
            'Entered while checking the form, and safe to remove at any time.',
            'Provisional wording, to be replaced once the final copy is agreed.',
            'Noted here so the process can be followed end to end.',
            'Added for completeness while the workflow was being walked through.',
            'Kept short on purpose; there is nothing further to report.',
            'Placeholder text supplied by the test harness rather than by a person.'
        ],
        de: [
            'Im Rahmen eines automatisierten Tests erfasst; der Inhalt hat keine fachliche Bedeutung.',
            'Für eine geplante Durchsicht aufgenommen und nur zur Referenz hinterlegt.',
            'Beim Prüfen des Formulars eingetragen und jederzeit entfernbar.',
            'Vorläufige Formulierung, die nach Abstimmung des endgültigen Textes ersetzt wird.',
            'Hier vermerkt, damit der Vorgang vollständig nachvollzogen werden kann.',
            'Zur Vollständigkeit ergänzt, während der Ablauf durchgegangen wurde.',
            'Bewusst kurz gehalten; es gibt nichts weiter zu berichten.',
            'Platzhaltertext aus der Testumgebung, nicht von einer Person verfasst.'
        ]
    };

    function someSentences(r, langKey, n) {
        const pool = PROSE[langKey] || PROSE.en;
        const out = [];
        const used = new Set();
        for (let i = 0; i < n && used.size < pool.length; i++) {
            let idx;
            do {
                idx = Math.floor(r() * pool.length);
            } while (used.has(idx));
            used.add(idx);
            out.push(pool[idx]);
        }
        return out;
    }

    // A rich-text editor exists to hold formatting, so give it some to exercise.
    function richHtml(r, langKey) {
        const s = someSentences(r, langKey, 4);
        const de = langKey === 'de';
        return [
            `<p><strong>${de ? 'Hinweis' : 'Note'}:</strong> ${s[0]}</p>`,
            `<p>${s[1]} <em>${de ? 'Bitte vor Freigabe prüfen.' : 'Please review before release.'}</em></p>`,
            '<ul>',
            `<li>${s[2]}</li>`,
            `<li>${s[3] || s[0]}</li>`,
            '</ul>'
        ].join('');
    }

    // ------------------------------------------------------------ checksums ----
    function digits(r, n) {
        let s = '';
        for (let i = 0; i < n; i++) s += Math.floor(r() * 10);
        return s;
    }

    const IBAN_SPECS = {
        DE: {body: (r) => digits(r, 8) + digits(r, 10)},
        GB: {body: (r) => 'NWBK' + digits(r, 6) + digits(r, 8)}
    };

    function mod97(str) {
        let rem = 0;
        for (const ch of str) {
            const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
            for (const d of v) rem = (rem * 10 + Number(d)) % 97;
        }
        return rem;
    }

    function makeIBAN(r, cc) {
        const country = IBAN_SPECS[cc] ? cc : 'DE';
        const body = IBAN_SPECS[country].body(r);
        const check = 98 - mod97(body + country + '00');
        return country + String(check).padStart(2, '0') + body;
    }

    // German USt-IdNr: DE + 8 digits + Modulo 11,10 check digit.
    function makeUstId(r) {
        const base = digits(r, 8);
        let p = 10;
        for (const ch of base) {
            let s = (Number(ch) + p) % 10;
            if (s === 0) s = 10;
            p = (2 * s) % 11;
        }
        return 'DE' + base + (11 - p) % 10;
    }

    function luhn(partial) {
        let sum = 0, dbl = true;
        for (let i = partial.length - 1; i >= 0; i--) {
            let d = Number(partial[i]);
            if (dbl) {
                d *= 2;
                if (d > 9) d -= 9;
            }
            dbl = !dbl;
            sum += d;
        }
        return String((10 - (sum % 10)) % 10);
    }

    // 4111 11… is the universally recognised test PAN family.
    function makeTestCard(r) {
        const base = '411111' + digits(r, 9);
        return base + luhn(base);
    }

    // -------------------------------------------------------------- persona ----
    function slugify(s) {
        return s.toLowerCase()
            .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '');
    }

    const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    /* A date in a locale's own format ("DD.MM.YYYY", "MM/DD/YYYY", "TT.MM.JJJJ").
     * Accepts a Date or an ISO string. */
    function formatDate(d, fmt) {
        if (typeof d === 'string') {
            const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
            if (!m) return d;
            d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        }
        const map = {
            DD: pad(d.getDate()), MM: pad(d.getMonth() + 1), YYYY: String(d.getFullYear()),
            TT: pad(d.getDate()), JJJJ: String(d.getFullYear())
        };
        return String(fmt || 'YYYY-MM-DD').replace(/TT|DD|MM|JJJJ|YYYY/g, m => map[m] ?? m);
    }

    /* The persona's country as the lists of other languages spell it. A German
     * form offers "Vereinigte Staaten"; typing "United States" into its filter
     * finds nothing, and a random country then goes in beside a US address. */
    const COUNTRY_NAMES = {
        US: ['United States', 'Vereinigte Staaten', 'USA', 'United States of America', 'Vereinigte Staaten von Amerika', 'États-Unis'],
        GB: ['United Kingdom', 'Vereinigtes Königreich', 'Großbritannien', 'Great Britain', 'Royaume-Uni'],
        DE: ['Deutschland', 'Germany', 'Allemagne', 'Alemania', 'Germania']
    };

    function buildPersona(seed, localeKey, opts) {
        opts = opts || {};
        const L = LOCALES[localeKey] || LOCALES['en-US'];
        const r = mulberry32(seedFromString(String(seed) + '|' + localeKey));

        const first = pick(r, L.first);
        const last = pick(r, L.last);
        const place = pick(r, L.places);
        const street = pick(r, L.streets);
        const companyName = `${pick(r, COMPANY_STEMS)} ${pick(r, COMPANY_TAIL)} ${pick(r, L.companySuffix)}`;
        const companySlug = slugify(`${companyName.split(' ')[0]}${companyName.split(' ')[1]}`);

        const domain = opts.emailDomain || 'example.com';
        const tag = String(seed).toLowerCase().slice(0, 6);
        const emailLocal = `${slugify(first)}.${slugify(last)}`;
        const email = opts.plusTag === false ? `${emailLocal}@${domain}` : `${emailLocal}+${tag}@${domain}`;

        const birthYear = 1965 + Math.floor(r() * 38);
        const birthMonth = 1 + Math.floor(r() * 12);
        const birthDay = 1 + Math.floor(r() * 28);

        const now = new Date();
        const future = new Date(now.getTime() + (7 + Math.floor(r() * 90)) * 864e5);
        const past = new Date(now.getTime() - (7 + Math.floor(r() * 400)) * 864e5);
        const futureLate = new Date(future.getTime() + (7 + Math.floor(r() * 21)) * 864e5);

        return {
            seed: String(seed),
            locale: localeKey,
            localeLabel: L.label,
            dateFormat: L.dateFormat,
            firstName: first,
            lastName: last,
            fullName: `${first} ${last}`,
            initials: first[0] + last[0],
            username: `${slugify(first)}${slugify(last).slice(0, 4)}${Math.floor(r() * 90) + 10}`,
            email,
            emailAlt: `${slugify(first)[0]}${slugify(last)}@${companySlug}.example`,
            password: `Tst-${tag.toUpperCase()}-${Math.floor(r() * 9000) + 1000}!aZ`,
            phone: L.phone(r, place),
            phoneNational: L.phoneNational(r, place),
            phoneDigits: L.phoneDigits(r, place),
            phoneE164: L.phoneE164(r, place),
            company: companyName,
            companyDomain: `${companySlug}.example`,
            jobTitle: pick(r, localeList(JOB_TITLES, localeKey, 'jobTitle')),
            department: pick(r, localeList(DEPARTMENTS, localeKey, 'department')),
            color: pick(r, vocab(localeKey, 'color')) || (localeKey === 'de-DE' ? 'Blau' : 'blue'),
            state: pick(r, vocab(localeKey, 'state')) || '',
            productName: pick(r, vocab(localeKey, 'product')) || 'Notebook',
            noun: pick(r, vocab(localeKey, 'noun')) || '',
            street: L.address(r, place, street),
            street2: r() > 0.6 ? (localeKey === 'de-DE' ? `${1 + Math.floor(r() * 5)}. OG` : `Apt ${1 + Math.floor(r() * 40)}`) : '',
            city: place.city,
            region: place.region,
            postal: place.postal,
            country: L.country,
            countryEn: {US: 'United States', GB: 'United Kingdom', DE: 'Germany'}[L.countryCode],
            countryNames: COUNTRY_NAMES[L.countryCode] || [L.country],
            countryCode: L.countryCode,
            birthDate: `${birthYear}-${pad(birthMonth)}-${pad(birthDay)}`,
            futureDate: isoDate(future),
            futureDateLocal: formatDate(future, L.dateFormat),
            // The far end of a range: a return date must fall after the rental date.
            futureDateLate: isoDate(futureLate),
            futureDateLateLocal: formatDate(futureLate, L.dateFormat),
            pastDate: isoDate(past),
            pastDateLocal: formatDate(past, L.dateFormat),
            iban: makeIBAN(r, L.countryCode),
            vatId: localeKey === 'de-DE' ? makeUstId(r) : `${L.countryCode}${digits(r, 9)}`,
            cardNumber: makeTestCard(r),
            cardCvc: digits(r, 3),
            cardExpiry: `${pad(1 + Math.floor(r() * 12))}/${String(now.getFullYear() + 2 + Math.floor(r() * 3)).slice(2)}`,
            website: `https://www.${companySlug}.example`,
            amount: (Math.floor(r() * 90000) + 1000) / 100,
            quantity: 1 + Math.floor(r() * 20),
            sentence: someSentences(r, L.prose, 1)[0],
            paragraph: someSentences(r, L.prose, 2 + Math.floor(r() * 2)).join(' '),
            richText: richHtml(r, L.prose),
            _rng: r
        };
    }

    // ---------------------------------------------------------------- rules ----
    /* Ordered: the first matching pattern wins, so specific rules sit above
     * general ones (`address.zip` contains "address" and must reach the postcode
     * rule first). An array value is a list of candidates: a dropdown tries each
     * against its real options, a text input takes the first.
     *
     * A rule tagged WEAK is a floor, not an answer: generic content ("notes",
     * "description") is offered to the model, and the rule fills the field only
     * if the model does not. Everything else is authoritative because it encodes
     * something the model cannot know — a checksum, an email matching the name. */
    const WEAK = 'weak';

    const RULES = [
        [/\b(confirm|repeat|retype|wiederhol|bestätig).*(pass|kennwort|passwort)/i, p => p.password],
        [/\b(pass(word)?|kennwort|passwort)\b/i, p => p.password],
        [/\b(first\s*-?name|firstname|given\s*-?name|vorname|fname)\b/i, p => p.firstName],
        [/\b(last\s*-?name|lastname|surname|family\s*-?name|nachname|lname)\b/i, p => p.lastName],
        [/\b(middle\s*-?(name|initial)|initials)\b/i, p => p.initials[0]],
        [/\b(full\s*-?name|your\s*name|name\s*\(|contact\s*(name|person)|kontaktperson|ansprechpartner)\b/i, p => p.fullName],
        [/\b(user\s*-?name|nickname|handle|login|benutzername)\b/i, p => p.username],
        [/\b(e-?mail|mail\s*address|emailaddress|e-?post)\b/i, p => p.email],
        // The country picker of an international phone input, before the phone rules claim it.
        [/countrylist|countrycode|phonecountry/i, p => [p.country, p.countryEn, ...(p.countryNames || []), p.countryCode]],
        [/\b(mobile|cell|handy)\b/i, p => p.phone],
        [/\b(phone|tel|telefon|telephone|fax)\b/i, p => p.phone],
        // A floor, not an answer: the model knows real makes, and the persona's company is the fallback.
        [/\b(manufacturer|hersteller|brand|marke|vendor|lieferant|supplier)\b/i, p => p.company, WEAK],
        [/\b(company|organisation|organization|employer|firma|unternehmen)\b/i, p => p.company],
        [/\b(job\s*-?title|position|role|berufsbezeichnung|funktion)\b/i, p => p.jobTitle],
        [/\b(department|abteilung|team)\b/i, p => p.department],
        [/\b(colour|color|farbe|lackierung)\b/i, p => p.color],
        /* German compounds glue the tail on: Gerätebezeichnung, Artikelname,
         * Produkttyp. "device" is only ever the compound: on its own it also
         * claims "Year in which the device was produced". */
        [/\b(device|ger(ä|ae)te?)\s*-?\s*(name|bezeichnung|model|modell|titel)\b|\bdevicename\b/i, p => p.productName, WEAK],
        [/\b(artikel|produkt|product|item|equipment|material)(n?(name|bezeichnung|typ))?\b/i, p => p.productName, WEAK],
        [/\b(address\s*-?(line\s*)?2|addr2|street2|adresszusatz|zusatz|apt|suite|unit)\b/i, p => p.street2 || 'Unit 4'],
        [/\b(zip|postal|postcode|plz|post\s*code)\b/i, p => p.postal],
        [/\b(city|town|ort|stadt|locality)\b/i, p => p.city],
        [/\b(state|province|region|county|bundesland|kanton)\b/i, p => p.region],
        [/\b(country|land|staat)\b/i, p => [p.country, p.countryEn, ...(p.countryNames || []), p.countryCode]],
        [/\b(street|address|addr|line1|anschrift|strasse|straße)\b/i, p => p.street],
        [/\b(salutation|anrede|gender|geschlecht|prefix)\b/i, p => ['Mr', 'Ms', 'Herr', 'Frau', 'Mx']],
        // Narrow on purpose: a bare /time/ would also claim "Minimum lead time", a number.
        [/\b(start|begin|beginn|von|opening|öffnung)\s*-?\s*(time|zeit)\b|\bstarttime\b/i, () => '09:00'],
        [/\b(end|finish|ende|bis|closing|schluss)\s*-?\s*(time|zeit)\b|\bendtime\b/i, () => '17:00'],
        [/\b(birth\w*|dob|geburt\w*|geboren)\b/i, p => p.birthDate],
        [/\b(iban|bank\s*account|kontonummer|bankverbindung)\b/i, p => p.iban],
        [/\b(vat|ust|tax\s*(id|number)|steuernummer|umsatzsteuer)\b/i, p => p.vatId],
        /* The browser's own autofill vocabulary — cc-type, cc-name, cc-exp-month —
         * is on these controls already, and `autocomplete` is matched alongside the
         * label. Every generated number is a 4111… test card, so the brand beside
         * it is a fact, not a guess, and the two halves of an expiry date come from
         * the one the MM/YY rule uses. */
        [/\b(card\s*type|cardtype|cc-?type|card\s*brand|kartentyp)\b/i, () => ['Visa', 'VISA']],
        [/\b(cc-?name|name\s*on\s*(the\s*)?card|cardholder|karteninhaber)\b/i, p => p.fullName],
        [/\bexp(iry|iration)?\s*(month|monat)\b|\bcc-?exp-?month\b/i, p => p.cardExpiry.slice(0, 2)],
        [/\bexp(iry|iration)?\s*(year|jahr)\b|\bcc-?exp-?year\b/i, p => [`20${p.cardExpiry.slice(-2)}`, p.cardExpiry.slice(-2)]],
        [/\b(card\s*number|cardnumber|pan|kreditkarte|ccnum)\b/i, p => p.cardNumber],
        [/\b(cvc|cvv|security\s*code|prüfziffer)\b/i, p => p.cardCvc],
        [/\b(expir|valid\s*(thru|until)|gültig|mm\s*\/\s*yy)\b/i, p => p.cardExpiry],
        [/\b(sub)?domain\b/i, p => p.companyDomain, WEAK],
        [/\b(website|url|homepage|webseite|link)\b/i, p => p.website],
        [/\b(amount|price|total|betrag|preis|summe|cost)\b/i, p => String(p.amount)],
        [/\b(quantity|qty|anzahl|menge|count)\b/i, p => String(p.quantity)],
        [/\b(comment|message|description|notes?|feedback|information(en)?|instructions?|bemerkung|nachricht|beschreibung|kommentar|hinweise?|anmerkung(en)?)\b/i, p => p.paragraph, WEAK],
        [/\b(subject|title|betreff|titel|headline)\b/i, () => 'Automated test entry — do not action', WEAK],
        [/\b(search|suche|query|q)\b/i, p => p.company.split(' ')[0], WEAK],
        [/\b(age|alter)\b/i, p => String(new Date().getFullYear() - Number(p.birthDate.slice(0, 4)))]
    ];

    function matchRuleDetail(text, persona) {
        if (!text) return null;
        for (const [re, fn, tag] of RULES) {
            if (!re.test(text)) continue;
            try {
                return {value: fn(persona), pattern: String(re), weak: tag === WEAK};
            } catch (_) {
                return null;
            }
        }
        return null;
    }

    function matchRule(text, persona) {
        const hit = matchRuleDetail(text, persona);
        return hit ? hit.value : null;
    }

    // ------------------------------------------------------------- shaping ----
    /* A number that reads sensibly for its label: "Minimum duration" and
     * "Maximum duration" both set to 3 is valid and useless. constrain() clamps
     * the result to the field's own min/max afterwards. */
    function numberFor(label, persona) {
        const r = persona._rng || Math.random;
        const between = (lo, hi) => String(lo + Math.floor(r() * (hi - lo + 1)));
        const t = String(label || '');
        if (/\b(max|maximum|maximal|höchst|upper)\b/i.test(t)) return between(14, 30);
        if (/\b(min|minimum|mindest|least|lower)\b/i.test(t)) return between(1, 3);
        if (/\b(lead\s*time|vorlauf|notice)\b/i.test(t)) return between(1, 5);
        if (/\b(block|sperr|buffer|cooldown)\b/i.test(t)) return between(0, 2);
        if (/\b(percent|prozent|rate|quote)\b/i.test(t)) return between(1, 99);
        if (/\b(year|jahr)\b/i.test(t)) return String(new Date().getFullYear());
        return String(persona.quantity);
    }

    /* A placeholder like "(99) 999 9999" is an input mask: it says how many
     * digits the field wants and where. Only digits are transplanted into it. */
    const MASK_CHARS = /[9#_0]/g;
    const DATE_MASK_LETTERS = /[TMJDYHMSd]/g;

    function looksLikeMask(text) {
        if (!text) return false;
        const slots = String(text).match(MASK_CHARS);
        if (!slots || slots.length < 4) return false;
        // Any other letter means prose ("Bitte 0000 eingeben"), not a template.
        return !/[A-Za-z]/.test(String(text).replace(DATE_MASK_LETTERS, ''));
    }

    function fitMask(value, mask, r) {
        if (!looksLikeMask(mask)) return value;
        const ds = String(value == null ? '' : value).replace(/\D/g, '');
        const rand = r || Math.random;
        let i = 0;
        return String(mask).replace(MASK_CHARS, () => i < ds.length ? ds[i++] : String(Math.floor(rand() * 10)));
    }

    /* Cut prose to a length without cutting a word in half. A phrase that ends
     * mid-word reads as a bug in the form; one that ends a word early reads as
     * test data. Only worth it when the whole last word is a small sacrifice. */
    function shortenTo(text, max) {
        if (text.length <= max) return text;
        const cut = text.slice(0, max);
        const whole = /\s/.test(text.charAt(max)) ? cut : cut.replace(/\s+\S*$/, '');
        return (whole.length >= max / 2 ? whole : cut).replace(/[\s,;:\-–]+$/, '').trim() || cut.trim();
    }

    /* Bring a value inside what the control says it accepts. A rejected value
     * reverts silently, which is indistinguishable from never having written. */
    function constrain(value, limits) {
        if (value == null || !limits) return value;
        if (Array.isArray(value)) return value.map(v => constrain(v, limits));

        const hasNum = limits.min != null || limits.max != null;
        if (hasNum && /^-?\d+(\.\d+)?$/.test(String(value).trim())) {
            let n = Number(value);
            if (limits.min != null && n < limits.min) n = limits.min;
            if (limits.max != null && n > limits.max) n = limits.max;
            if (limits.step && limits.min != null) {
                n = limits.min + Math.round((n - limits.min) / limits.step) * limits.step;
                if (limits.max != null && n > limits.max) n -= limits.step;
            }
            return String(n);
        }

        let out = String(value);
        if (limits.maxLength && out.length > limits.maxLength) out = shortenTo(out, limits.maxLength);
        if (limits.pattern) {
            let re = null;
            try {
                re = new RegExp('^(?:' + limits.pattern + ')$');
            } catch (_) {
                re = null;
            }
            if (re && !re.test(out)) {
                // Try the obvious narrowings before letting the value through as is.
                for (const alt of [out.replace(/\s+/g, ''), out.replace(/[^0-9]/g, ''), out.replace(/[^A-Za-z0-9]/g, '')]) {
                    if (alt && re.test(alt)) return alt;
                }
            }
        }
        return out;
    }

    // Fallback by input type when no rule matched.
    function byType(field, persona) {
        const r = persona._rng;
        switch (field.type) {
            case 'email':
                return persona.email;
            case 'tel':
                return persona.phone;
            case 'url':
                return persona.website;
            case 'password':
                return persona.password;
            case 'number':
            case 'range': {
                const min = field.min !== null && field.min !== '' ? Number(field.min) : 1;
                const max = field.max !== null && field.max !== '' ? Number(field.max) : min + 99;
                const step = field.step && Number(field.step) > 0 ? Number(field.step) : 1;
                const steps = Math.max(0, Math.floor((max - min) / step));
                return String(min + Math.floor(r() * (steps + 1)) * step);
            }
            case 'date':
                return persona.futureDate;
            case 'datetime-local':
                return persona.futureDate + 'T10:30';
            case 'month':
                return persona.futureDate.slice(0, 7);
            case 'week':
                return persona.futureDate.slice(0, 4) + '-W12';
            case 'time':
                return `${pad(9 + Math.floor(r() * 9))}:${pad(Math.floor(r() * 12) * 5)}`;
            case 'color':
                return '#' + Math.floor(r() * 0xffffff).toString(16).padStart(6, '0');
            case 'textarea':
                return persona.sentence;
            default:
                return null;
        }
    }

    /* The last resort, named after the field it lands in: "Prerequisite 43" in
     * a box labelled Prerequisite is obviously deliberate test data. */
    /* A value that reads as content. This used to be the field's own caption with a
     * number after it — "Alternative text 27" — which traces nicely and exercises
     * nothing: no word boundary, no accent, no length anything would validate, and
     * a screenshot of a filled form that looks like the filler gave up. The caption
     * decides nothing about the value now; the Debug tab is where a reader finds
     * out which field got what.
     *
     * Drawn from the product and colour lists, not the noun list: faker's German
     * nouns are grammar terms and worse, and none of that belongs in a colleague's
     * test form. The number keeps sibling rows apart — four "Alternative text"
     * inputs must not all read the same. */
    function fallbackText(field, persona) {
        const max = field.maxLength && field.maxLength > 0 ? field.maxLength : 60;
        const r = persona._rng || Math.random;
        const loc = persona.locale || 'en-US';
        const n = String(1 + Math.floor(r() * 99));
        const products = vocab(loc, 'product');
        const colour = pick(r, vocab(loc, 'color')) || '';
        // A narrow field gets the shortest word there is rather than a bare number.
        const drawn = pick(r, products) || '';
        const product = drawn.length + 2 <= max ? drawn
            : (products.filter(w => w.length + 2 <= max).sort((a, b) => a.length - b.length)[0] || '');
        const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
        // The longest phrase that fits, never a word cut in half.
        for (const parts of [[colour, product, n], [product, n], [product], [n]]) {
            const made = parts.filter(Boolean).join(' ').trim();
            if (made && made.length <= max) return cap(made);
        }
        return `${persona.company.split(' ')[0]} ${persona.seed}`.slice(0, max).trim();
    }

    globalThis.FormForgeGen = {
        LOCALES, buildPersona, matchRule, matchRuleDetail, byType, fallbackText, constrain, numberFor,
        fitMask, looksLikeMask, formatDate, shortenTo, newSeed, mulberry32, seedFromString
    };
})();
