/* Fillsmith — deterministic test-data generator.
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
     * come from the ranges reserved for fiction: in the US 555-0100 to 555-0199
     * in any area code; in Germany the Bundesnetzagentur's "Drama-Nummern", one
     * block of a thousand per city for five cities, plus two mobile blocks. A
     * city without a block gets a mobile number — a mobile is from nowhere in
     * particular, where a Leipzig code in front of Berlin's block was a number
     * somebody in Leipzig may well have. */
    const DRAMA_MOBILE = [{area: '171', block: '39200', tail: 2}, {area: '176', block: '040690', tail: 2}];

    const LOCALES = {
        'en-US': {
            label: 'EN',
            prose: 'en',
            // What the model is told to write in. The rules already answer in it.
            language: 'English',
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
            /* One number, four spellings: the same digits however a form wants
             * them written. `parts` is the local number as the country groups it. */
            telephone: (r, place) => ({area: place.area, parts: ['555', '01' + digits(r, 2)]}),
            phoneFormats: {
                pretty: (t) => `(${t.area}) ${t.parts.join('-')}`,
                national: (t) => `${t.area}${t.parts.join('')}`,
                digits: (t) => `1${t.area}${t.parts.join('')}`,
                e164: (t) => `+1${t.area}${t.parts.join('')}`
            },
            address: (r, place, street) => `${100 + Math.floor(r() * 8900)} ${street}`,
            dateFormat: 'MM/DD/YYYY'
        },

        'de-DE': {
            label: 'DE',
            prose: 'de',
            language: 'German',
            first: ['Lukas', 'Jonas', 'Leon', 'Felix', 'Maximilian', 'Paul', 'Thomas', 'Stefan', 'Andreas', 'Michael',
                'Anna', 'Lena', 'Sophie', 'Marie', 'Emma', 'Laura', 'Katharina', 'Julia', 'Claudia', 'Petra'],
            last: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann',
                'Koch', 'Richter', 'Klein', 'Wolf', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Krüger', 'Hofmann'],
            streets: ['Hauptstraße', 'Bahnhofstraße', 'Lindenweg', 'Gartenstraße', 'Schillerstraße', 'Goethestraße',
                'Ringstraße', 'Amselweg', 'Mozartstraße', 'Kirchgasse'],
            // `drama` is the city's reserved block: 030 23125 000 to 999, and so on.
            places: [
                {city: 'Berlin', region: 'Berlin', postal: '10115', area: '30', drama: '23125'},
                {city: 'Hamburg', region: 'Hamburg', postal: '20095', area: '40', drama: '66969'},
                {city: 'München', region: 'Bayern', postal: '80331', area: '89', drama: '99998'},
                {city: 'Köln', region: 'Nordrhein-Westfalen', postal: '50667', area: '221', drama: '4710'},
                {city: 'Frankfurt am Main', region: 'Hessen', postal: '60311', area: '69', drama: '90009'},
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
            telephone: (r, place) => {
                if (place.drama) return {area: place.area, parts: [place.drama, digits(r, 3)]};
                // A mobile is written as one run of digits after the prefix: 0171 3920050.
                const m = pick(r, DRAMA_MOBILE);
                return {area: m.area, parts: [m.block + digits(r, m.tail)]};
            },
            phoneFormats: {
                pretty: (t) => `+49 ${t.area} ${t.parts.join(' ')}`,
                national: (t) => `0${t.area} ${t.parts.join(' ')}`,
                // Country code, no plus, no spaces: the shape strict phone validators accept.
                digits: (t) => `49${t.area}${t.parts.join('')}`,
                e164: (t) => `+49${t.area}${t.parts.join('')}`
            },
            address: (r, place, street) => `${street} ${1 + Math.floor(r() * 180)}`,
            dateFormat: 'DD.MM.YYYY'
        }
    };

    /* The generated vocabulary (src/vocab.js) is folded into the curated lists,
     * not swapped in for them: the hand-written names are the common ones, and a
     * missing vocab file must mean shorter lists rather than an exception. */
    const V = globalThis.FillsmithVocab || {};
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
    const escapeHtml = (t) => String(t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    /* Four shapes, not one. A form with five editors on it filled all five with
     * the same bold "Note:" over the same bullet list, which reads as a filler
     * that has one trick — and exercises one path through the editor five times
     * instead of four paths once each. Between them these cover bold, italic,
     * a bullet list and a numbered list. */
    const RICH_WORDS = {
        en: {lead: ['Note', 'Summary', 'Background', 'Checklist'], review: 'Please review before release.'},
        de: {lead: ['Hinweis', 'Zusammenfassung', 'Hintergrund', 'Checkliste'], review: 'Bitte vor Freigabe prüfen.'}
    };

    function richHtml(r, langKey, sentences) {
        const s = (sentences || someSentences(r, langKey, 4)).map(escapeHtml);
        const w = RICH_WORDS[langKey] || RICH_WORDS.en;
        const shape = Math.floor(r() * 4);
        const lead = w.lead[shape];
        if (shape === 1) {
            return `<p>${s[0]}</p><ol><li>${s[1]}</li><li>${s[2]}</li><li>${s[3] || s[1]}</li></ol>`;
        }
        if (shape === 2) {
            return `<p>${s[0]} <strong>${s[1]}</strong></p><p><em>${s[2]}</em></p>`;
        }
        if (shape === 3) {
            return `<p><strong>${lead}</strong></p><ul><li>${s[0]}</li><li>${s[1]}</li><li>${s[2]}</li></ul>`
                + `<p><em>${w.review}</em></p>`;
        }
        return `<p><strong>${lead}:</strong> ${s[0]}</p><p>${s[1]} <em>${w.review}</em></p>`
            + `<ul><li>${s[2]}</li><li>${s[3] || s[0]}</li></ul>`;
    }

    /* The model's words in the shape the control is worth testing with. It answers
     * a rich-text field in prose, and prose exercises nothing the editor does —
     * the bold, the italic and the list are the point of it. Asking for markup in
     * the prompt was a line paid for on every batch that the on-device model
     * ignored anyway, so the layout is built here instead. Short answers are made
     * up from the same pool the rules draw on, so the page reads of a piece. */
    function richLayout(text, persona, salt) {
        const langKey = persona.prose || 'en';
        /* Its own stream, seeded from the persona and the answer. The persona's
         * RNG is a sequence, and model answers arrive in whatever order the
         * batches finish: drawing from it here would make the rest of the fill
         * depend on that order, and the seed would stop reproducing the page. */
        const r = mulberry32(seedFromString(`${persona.seed}|rich|${salt || ''}|${text}`));
        const given = String(text || '').replace(/\s+/g, ' ').trim()
            .split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
        for (let guard = 0; given.length < 4 && guard < 4; guard++) {
            const more = someSentences(r, langKey, 4 - given.length);
            if (!more.length) break;
            given.push(...more);
        }
        while (given.length < 4) given.push(given[given.length - 1] || '');
        return richHtml(r, langKey, given.slice(0, 4));
    }

    // ------------------------------------------------------------ checksums ----
    function digits(r, n) {
        let s = '';
        for (let i = 0; i < n; i++) s += Math.floor(r() * 10);
        return s;
    }

    // A German IBAN: an eight-digit bank code and a ten-digit account, both random.
    const IBAN_SPECS = {
        DE: {body: (r) => digits(r, 8) + digits(r, 10)}
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

    // A US Employer Identification Number: two digits, a dash, seven digits.
    function makeEin(r) {
        return `${digits(r, 2)}-${digits(r, 7)}`;
    }

    /* The domain a tester typed, or example.com. "@acme.test", "acme.test/" and
     * "acme" all reached the address unchanged and made it invalid. */
    function cleanDomain(domain) {
        const s = String(domain == null ? '' : domain).trim().toLowerCase()
            .replace(/^https?:\/\//, '').replace(/^@+/, '').replace(/\/.*$/, '');
        return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(s) ? s : 'example.com';
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

        const domain = cleanDomain(opts.emailDomain);
        const tag = String(seed).toLowerCase().slice(0, 6);
        const emailLocal = `${slugify(first)}.${slugify(last)}`;
        const email = opts.plusTag === false ? `${emailLocal}@${domain}` : `${emailLocal}+${tag}@${domain}`;

        const tel = L.telephone(r, place);

        const birthYear = 1965 + Math.floor(r() * 38);
        const birthMonth = 1 + Math.floor(r() * 12);
        const birthDay = 1 + Math.floor(r() * 28);

        const now = new Date();
        const future = new Date(now.getTime() + (7 + Math.floor(r() * 90)) * 864e5);
        const past = new Date(now.getTime() - (7 + Math.floor(r() * 400)) * 864e5);
        const futureLate = new Date(future.getTime() + (7 + Math.floor(r() * 21)) * 864e5);

        const persona = {
            seed: String(seed),
            locale: localeKey,
            localeLabel: L.label,
            language: L.language,
            dateFormat: L.dateFormat,
            firstName: first,
            lastName: last,
            fullName: `${first} ${last}`,
            initials: first[0] + last[0],
            username: `${slugify(first)}${slugify(last).slice(0, 4)}${Math.floor(r() * 90) + 10}`,
            email,
            emailAlt: `${slugify(first)[0]}${slugify(last)}@${companySlug}.example`,
            password: `Tst-${tag.toUpperCase()}-${Math.floor(r() * 9000) + 1000}!aZ`,
            phone: L.phoneFormats.pretty(tel),
            phoneNational: L.phoneFormats.national(tel),
            phoneDigits: L.phoneFormats.digits(tel),
            phoneE164: L.phoneFormats.e164(tel),
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
            countryEn: {US: 'United States', DE: 'Germany'}[L.countryCode],
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
            /* A VAT number and a tax number are different things with different
             * shapes, and a validator for one rejects the other: Germany has the
             * USt-IdNr and the Steuernummer, the US one EIN that serves for both. */
            vatId: L.countryCode === 'DE' ? makeUstId(r) : makeEin(r),
            taxNumber: L.countryCode === 'DE' ? `${digits(r, 2)}/${digits(r, 3)}/${digits(r, 5)}` : makeEin(r),
            cardNumber: makeTestCard(r),
            cardCvc: digits(r, 3),
            /* 987-65-4320 to 987-65-4329 is the block the SSA reserves for
             * advertising, the same reasoning as the 555-01xx phone range: a
             * number that cannot belong to anybody. Germany's analogue is a
             * different thing with a different shape, so a DE fill has none and
             * the field falls through. */
            ssn: L.countryCode === 'US' ? `987-65-432${Math.floor(r() * 10)}` : '',
            driverLicence: `${L.countryCode === 'US' ? place.region : 'B'}${digits(r, 7)}`,
            income: String((30 + Math.floor(r() * 90)) * 1000),
            altText: L.prose === 'de'
                ? `${pick(r, vocab(localeKey, 'product') || ['Notebook'])} auf einem Schreibtisch`
                : `${pick(r, vocab(localeKey, 'product') || ['Notebook'])} on a desk`,
            cardExpiry: `${pad(1 + Math.floor(r() * 12))}/${String(now.getFullYear() + 2 + Math.floor(r() * 3)).slice(2)}`,
            website: `https://www.${companySlug}.example`,
            amount: (Math.floor(r() * 90000) + 1000) / 100,
            quantity: 1 + Math.floor(r() * 20),
            sentence: someSentences(r, L.prose, 1)[0],
            paragraph: someSentences(r, L.prose, 2 + Math.floor(r() * 2)).join(' '),
            richText: richHtml(r, L.prose),
            prose: L.prose,
            _rng: r
        };
        return persona;
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

    /** A pattern, what it answers with, and whether it is a floor or an answer.
     * @typedef {[RegExp, (persona: any) => (string|string[]), ('weak'|undefined)?]} Rule */
    /** @type {Rule[]} */
    const RULES = [
        [/\b(confirm|repeat|retype|wiederhol|bestätig).*(pass|kennwort|passwort)/i, p => p.password],
        // "Pass" on its own is a boarding pass or a season pass; a password field says so, or its type does.
        [/\b(password|passwd|pwd|kennwort|passwort)\b/i, p => p.password],
        [/\b(first\s*-?name|firstname|given\s*-?name|vorname|fname)\b/i, p => p.firstName],
        [/\b(last\s*-?name|lastname|surname|family\s*-?name|nachname|lname)\b/i, p => p.lastName],
        [/\b(middle\s*-?(name|initials?|i)|initials)\b/i, p => p.initials[0]],
        [/\b(full\s*-?name|your\s*name|name\s*\(|contact\s*(name|person)|kontaktperson|ansprechpartner)\b/i, p => p.fullName],
        [/\b(user\s*-?(name|id)|nickname|handle|login|benutzername)\b/i, p => p.username],
        [/\b(e-?mail|mail\s*address|emailaddress|e-?post)\b/i, p => p.email],
        // The country picker of an international phone input, before the phone rules claim it.
        [/countrylist|countrycode|phonecountry/i, p => [p.country, p.countryEn, ...(p.countryNames || []), p.countryCode]],
        // "Mobile app version" is a version; "Mobile" alone, or beside "number", is the phone.
        [/\b(mobile|cell|handy)\b(?!\s*-?\s*(app|application|version|device|os|platform|banking))/i, p => p.phone],
        [/\b(phone|tel|telefon(nummer)?|rufnummer|telephone|fax)\b/i, p => p.phone],
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
        /* "Apt", "Suite" and "Unit" are the second address line only in an address:
         * on their own they are a unit price, a business unit, a test suite. The
         * second alternative wants an address word somewhere in the same label. */
        [/\b(address\s*-?(line\s*)?2|addr2|street2|adresszusatz)\b|^(?=.*\b(address|addr|adresse|anschrift|street|stra(ss|ß)e)\b).*\b(apt|apartment|suite|unit|zusatz)\b/i, p => p.street2 || 'Unit 4'],
        [/\b(zip|postal|postcode|plz|post\s*code)\b/i, p => p.postal],
        [/\b(city|town|ort|stadt|locality)\b/i, p => p.city],
        [/\b(state|province|region|county|bundesland|kanton)\b/i, p => p.region],
        // "Land" is a country in German and a plot in English; the plot's labels say what kind.
        [/\b(country|staat)\b|\bland\b(?!\s*-?\s*(area|size|use|parcel|plot|register|registry|owner|lord))/i, p => [p.country, p.countryEn, ...(p.countryNames || []), p.countryCode]],
        [/\b(street|address|addr|line1|anschrift|strasse|straße)\b/i, p => p.street],
        [/\b(salutation|anrede|gender|geschlecht|sex|prefix)\b/i, p => ['Mr', 'Ms', 'Herr', 'Frau', 'Mx']],
        // Narrow on purpose: a bare /time/ would also claim "Minimum lead time", a number.
        [/\b(start|begin|beginn|von|opening|öffnung)\s*-?\s*(time|zeit)\b|\bstarttime\b/i, () => '09:00'],
        [/\b(end|finish|ende|bis|closing|schluss)\s*-?\s*(time|zeit)\b|\bendtime\b/i, () => '17:00'],
        [/\bbirth\s*-?(place|pl|city|town|ort)\b|\bgeburtsort\b|\bpob\b/i, p => p.city],
        [/\b(birth\w*|dob|geburt\w*|geboren)\b/i, p => p.birthDate],
        [/\b(iban|bank\s*account|kontonummer|bankverbindung)\b/i, p => p.iban],
        // Two shapes: a VAT id (DE123456789) and a tax number (12/345/67890 or 12-3456789) fail each other's validators.
        [/\b(vat|ust|ust-?id(nr)?|umsatzsteuer|mwst|tax\s*id)\b/i, p => p.vatId],
        [/\b(steuernummer|steuer-?nr|tax\s*(number|no|reference)|taxpayer\s*(id|number)|employer\s*id(entification)?)\b/i, p => p.taxNumber],
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
        [/\b(alt(ernative)?\s*-?te?xt|alt-?tag|bildbeschreibung|image\s*description)\b/i, p => altTextFor(p)],
        [/\b(web\s*-?site|url|home\s*-?page|webseite|link)\b/i, p => p.website],
        // A source is usually where a picture came from; the model may know better.
        [/\b(source|quelle|herkunft|origin)\b/i, p => sourceFor(p), WEAK],
        // A cost centre is a code, not a sum.
        [/\b(amount|price|total|betrag|preis|summe|kosten)\b|\bcosts?\b(?!\s*-?\s*(cent(er|re)|code|type|unit|stelle|category))/i, p => String(p.amount)],
        [/\b(income|salary|gehalt|einkommen|jahresgehalt)\b/i, p => p.income],
        [/\b(quantity|qty|anzahl|menge|count)\b/i, p => String(p.quantity)],
        [/\b(comment|commnt|kommentar|message|description|notes?|feedback|information(en)?|instructions?|bemerkung|nachricht|beschreibung|kommentar|hinweise?|anmerkung(en)?)\b/i, p => p.paragraph, WEAK],
        [/\b(subject|title|betreff|titel|headline)\b/i, () => 'Automated test entry — do not action', WEAK],
        [/\b(search|suche|query|q)\b/i, p => p.company.split(' ')[0], WEAK],
        [/\b(age|alter)\b/i, p => String(new Date().getFullYear() - Number(p.birthDate.slice(0, 4)))]
    ];

    /* Field names on real forms carry their numbering and lose their vowels:
     * "02frstname", "10address1", "43cvc". Prising the digits off a word, and
     * a camelCase hump apart, puts a word boundary where the rules expect one. */
    const loosen = (text) => String(text)
        .replace(/([0-9])([A-Za-z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])/g, '$1 $2')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ');

    /* What is left after that: a token buried inside a word, with no boundary to
     * find it by. Only tokens that mean one thing on a form are here, and only
     * where our own answer is the better one — a phone number from a range
     * reserved for fiction, a card that passes Luhn, an address that agrees with
     * the rest of the persona. A model asked the same box invented 555-123-4567,
     * which is a number somebody may well have. */
    /* What to call a field when the model has to read it. The rules above cope
     * with "46cccstsvc" by pattern; a model cannot, and what came back for that
     * box was "XYZ-789" — alphabet soup, which is what a model writes when the
     * label tells it nothing. Expanded to "credit card customer service" it
     * writes a phone number. Only names no rule claimed ever get here, so a
     * wrong expansion costs a guess that was already wrong. */
    /** @type {[RegExp, string][]} */
    const EXPANSIONS = [
        [/cccstsvc/g, 'credit card customer service'],
        [/ccissuer/g, 'credit card issuer'],
        [/ccnum(ber)?/g, 'credit card number'],
        [/ccexp\s*(mm|month)/g, 'card expiry month'],
        [/ccexp\s*(yy|year)/g, 'card expiry year'],
        [/cc\s*uname/g, 'name on card'],
        [/cc\s*type/g, 'card type'],
        [/emailadr|mailadr/g, 'email address'],
        [/frstname|fstname/g, 'first name'],
        [/lstname|lastnm/g, 'last name'],
        [/adrstate|addrstate/g, 'state'],
        [/adrzip|addrzip/g, 'postcode'],
        [/adr\s*city|addr\s*city/g, 'city'],
        [/driv\s*lic\w*/g, 'driving licence number'],
        [/\bcommnt\b/g, 'comment'],
        [/\buname\b/g, 'username'],
        [/\bssn\b/g, 'social security number'],
        [/\bpers\b/g, 'personal'],
        [/\badr\b|\baddr\b/g, 'address'],
        [/phon\b/g, 'phone'],
        [/\bsvc\b/g, 'service'],
        [/\bnum\b|\bnbr\b/g, 'number']
    ];

    /* A leading number is the form's own ordering, not part of the name. */
    function readable(name) {
        const plain = loosen(name).replace(/^\s*\d+\s*/, '').replace(/\s+/g, ' ').trim();
        let out = plain.toLowerCase();
        for (const [re, word] of EXPANSIONS) out = out.replace(re, word);
        out = out.replace(/\s+/g, ' ').trim();
        // A name that needed nothing keeps its own capitals: most labels are already words.
        if (out === plain.toLowerCase()) return plain || String(name);
        return out;
    }

    /** @type {Rule[]} */
    const ABBREVIATED = [
        [/ccnum|cardnum|cc-?no\b/i, p => p.cardNumber],
        [/emailad|mailadr|emailaddr/i, p => p.email],
        [/phon|fax/i, p => p.phone],
        [/frstname|fstname/i, p => p.firstName],
        [/lstname|lastnm/i, p => p.lastName],
        [/adrstate|addrstate|statecode/i, p => p.region],
        [/adrzip|addrzip|zipcode/i, p => p.postal],
        [/adrcity|addrcity/i, p => p.city],
        [/\buname\b|usrname/i, p => p.username],
        [/\bssn\b|socialsec/i, p => p.ssn],
        [/driv\s*-?lic|driver\s*-?lic|licen[cs]e\s*-?(no|num)/i, p => p.driverLicence]
    ];

    function matchRuleDetail(text, persona) {
        if (!text) return null;
        const loose = loosen(text);
        for (const [re, fn, tag] of RULES) {
            if (!re.test(text) && !re.test(loose)) continue;
            try {
                return {value: fn(persona), pattern: String(re), weak: tag === WEAK};
            } catch (_) {
                return null;
            }
        }
        for (const [re, fn] of ABBREVIATED) {
            if (!re.test(text) && !re.test(loose)) continue;
            try {
                const value = fn(persona);
                if (value) return {value, pattern: String(re), weak: false};
            } catch (_) { /* the next one, or the model */
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

        const hasNum = limits.min != null || limits.max != null || limits.step != null;
        if (hasNum && /^-?\d+(\.\d+)?$/.test(String(value).trim())) {
            let n = Number(value);
            if (limits.min != null && n < limits.min) n = limits.min;
            if (limits.max != null && n > limits.max) n = limits.max;
            // The step counts from min, or from zero when there is none, as the browser does.
            if (limits.step) {
                const base = limits.min != null ? limits.min : 0;
                n = base + Math.round((n - base) / limits.step) * limits.step;
                if (limits.max != null && n > limits.max) n -= limits.step;
                if (limits.min != null && n < limits.min) n += limits.step;
                n = Number(n.toFixed(6));
            }
            return String(n);
        }

        let out = String(value);
        if (limits.maxLength && out.length > limits.maxLength) out = shortenTo(out, limits.maxLength);
        if (limits.pattern) {
            /* HTML patterns are compiled with the `v` flag, so \p{L} and set
             * operations are legal in them; without the flag they fail to compile
             * here and the value went through unchecked. */
            let re = null;
            for (const flags of ['v', 'u', '']) {
                try {
                    re = new RegExp('^(?:' + limits.pattern + ')$', flags);
                    break;
                } catch (_) {
                    re = null;
                }
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
    /* A picture's caption and where it came from, drawn per call rather than held
     * on the persona. A form of four upload rows gave all four the same caption
     * and the same source, which is one value tested four times — and a page
     * where every alt text is identical is a page no screen-reader check would
     * catch anything on. Drawn from the persona's own stream, like the fallback:
     * the order of the calls is DOM order, so the seed still reproduces it. */
    function altTextFor(persona) {
        const r = persona._rng || Math.random;
        const loc = persona.locale || 'en-US';
        const colour = pick(r, vocab(loc, 'color')) || '';
        const product = pick(r, vocab(loc, 'product')) || persona.productName;
        return persona.prose === 'de'
            ? `${product} in ${colour}, auf einem Schreibtisch`
            : `${colour.charAt(0).toUpperCase()}${colour.slice(1)} ${product.toLowerCase()} on a desk`;
    }

    function sourceFor(persona) {
        const r = persona._rng || Math.random;
        const product = pick(r, vocab(persona.locale || 'en-US', 'product')) || persona.productName;
        return `${persona.website}/media/${slugify(product)}-${100 + Math.floor(r() * 900)}.jpg`;
    }

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

    globalThis.FillsmithGen = {
        LOCALES, buildPersona, matchRule, matchRuleDetail, byType, fallbackText, constrain, numberFor,
        fitMask, looksLikeMask, formatDate, shortenTo, cleanDomain, newSeed, mulberry32, seedFromString,
        richLayout, readable
    };
})();
