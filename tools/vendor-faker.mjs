/* Generate src/vocab.js from @faker-js/faker.
 *
 *   npm run vocab
 *
 * faker is a *build-time* source of words here, not a runtime dependency. The
 * extension keeps zero dependencies and no bundler: what ships is a plain
 * script assigning one object to globalThis, exactly like every other file in
 * src/. That was the whole reason for this route — the library is ESM-only,
 * ~500KB for de+en, and injecting it into every page to read forty labels is a
 * poor trade for words that never change.
 *
 * What is taken and what is not is decided per locale, because faker's `de` is
 * only partly German. Checked by reading the output, not by assuming:
 *
 *   firstName, lastName   German        ✓ taken
 *   color.human           German        ✓ taken   (Blutrot, Nachtblau)
 *   location.state        German        ✓ taken   (real Bundesländer)
 *   word.noun             German        ✓ taken
 *   person.jobTitle       English       ✗ "Regional Security Executive"
 *   commerce.department   English       ✗ Sports, Toys, Clothing
 *   commerce.productName  English       ✗ "Luxurious Metal Keyboard"
 *   vehicle.vehicle       English, and nonsense: "Ford Golf", "Mercedes-Benz
 *                         Superb" — the make and the model do not go together
 *
 * Where faker has no German, a hand-written list stands in rather than English
 * words wearing a German locale label. Those are marked below.
 *
 * Deliberately NOT taken, in any locale:
 *   location.city / zipCode   faker's German cities are invented from name
 *                             fragments ("Süd Henrystadt", "Kedzierskidorf")
 *                             and the zip, city and state do not agree —
 *                             75605 is Alpirsbach, not Berlin. This project's
 *                             invariant is that the postcode follows the city,
 *                             and twelve real pairs beat three thousand wrong
 *                             ones on any form that checks them.
 *   phone.number              (0208) 972581023 — not a length German numbers
 *                             come in.
 *   lorem.*                   Latin in every locale, including de.
 */
import {fakerDE, fakerEN} from '@faker-js/faker';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Drawn until the pool stops yielding new values, so the count is what faker
 * can actually produce rather than a number picked in advance. */
function draw(fn, want) {
    const seen = new Set();
    for (let i = 0; seen.size < want && i < want * 60; i++) {
        try {
            seen.add(String(fn()).trim());
        } catch (_) {
            break;
        }
    }
    return [...seen].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/* Hand-written, because faker has no German for these and English words under
 * a German locale label are worse than a short list of real ones. Chosen for
 * the kind of application this gets pointed at — rental, logistics, admin. */
const GERMAN = {
    jobTitle: ['Softwareentwickler', 'Softwareentwicklerin', 'Projektmanager', 'Projektmanagerin',
        'Vertriebsleiter', 'Vertriebsleiterin', 'Sachbearbeiter', 'Sachbearbeiterin',
        'Personalreferent', 'Personalreferentin', 'Buchhalter', 'Buchhalterin',
        'Produktmanager', 'Produktmanagerin', 'Qualitätsmanager', 'Qualitätsmanagerin',
        'Disponent', 'Disponentin', 'Fuhrparkleiter', 'Fuhrparkleiterin',
        'Lagerleiter', 'Lagerleiterin', 'Kundenberater', 'Kundenberaterin',
        'Systemadministrator', 'Systemadministratorin', 'Techniker', 'Technikerin',
        'Controller', 'Controllerin', 'Einkäufer', 'Einkäuferin',
        'Werkstattleiter', 'Werkstattleiterin', 'Teamleiter', 'Teamleiterin',
        'Abteilungsleiter', 'Abteilungsleiterin', 'Geschäftsführer', 'Geschäftsführerin',
        'Auszubildender', 'Auszubildende', 'Praktikant', 'Praktikantin',
        'Servicetechniker', 'Servicetechnikerin', 'Ausbilder', 'Ausbilderin',
        'Verwaltungsangestellter', 'Verwaltungsangestellte'],
    department: ['Einkauf', 'Vertrieb', 'Buchhaltung', 'Personalwesen', 'Logistik', 'IT',
        'Marketing', 'Qualitätssicherung', 'Fuhrpark', 'Lager', 'Kundendienst', 'Technik',
        'Recht', 'Controlling', 'Produktion', 'Entwicklung', 'Verwaltung', 'Ausbildung',
        'Instandhaltung', 'Disposition', 'Empfang', 'Datenschutz'],
    product: ['Notebook', 'Beamer', 'Tablet', 'Dokumentenkamera', 'Kopfhörer', 'Mikrofon',
        'Ladestation', 'Whiteboard', 'Drucker', 'Scanner', 'Router', 'Messgerät',
        'Werkzeugkoffer', 'Transportwagen', 'Leiter', 'Lastenrad', 'Anhänger',
        'Bohrmaschine', 'Kamera', 'Stativ', 'Funkgerät', 'Erste-Hilfe-Koffer',
        'Schutzhelm', 'Warnweste', 'Verlängerungskabel', 'Akkuschrauber']
};

const PLAN = {
    de: {
        faker: fakerDE,
        take: {
            first: [f => f.person.firstName(), 400],
            last: [f => f.person.lastName(), 400],
            color: [f => f.color.human(), 30],
            state: [f => f.location.state(), 20],
            noun: [f => f.word.noun(), 200]
        },
        hand: GERMAN
    },
    en: {
        faker: fakerEN,
        take: {
            first: [f => f.person.firstName(), 400],
            last: [f => f.person.lastName(), 400],
            color: [f => f.color.human(), 30],
            state: [f => f.location.state(), 60],
            noun: [f => f.word.noun(), 200],
            jobTitle: [f => f.person.jobTitle(), 300],
            department: [f => f.commerce.department(), 30],
            product: [f => f.commerce.product(), 60]
        },
        hand: {}
    }
};

/* A committed generated file that changes on every regeneration produces a
 * five-hundred-line diff that says nothing. Seeded, `npm run vocab` is a
 * no-op until the plan or the faker version actually changes — which is the
 * only time anyone wants to read that diff. */
const SEED = 20260101;

const out = {};
for (const [loc, spec] of Object.entries(PLAN)) {
    out[loc] = {};
    for (const [key, [fn, want]] of Object.entries(spec.take)) {
        spec.faker.seed(SEED);
        out[loc][key] = draw(() => fn(spec.faker), want);
    }
    for (const [key, list] of Object.entries(spec.hand)) {
        out[loc][key] = [...list].sort((a, b) => a.localeCompare(b, loc));
    }
}

const counts = Object.entries(out)
    .map(([l, v]) => `${l}: ` + Object.entries(v).map(([k, a]) => `${k} ${a.length}`).join(', '))
    .join('\n *   ');

const body = Object.entries(out).map(([loc, groups]) =>
        `        ${loc}: {\n` + Object.entries(groups).map(([k, list]) => {
            // Wrapped by hand rather than by JSON.stringify, which puts it all on one
            // line and makes the diff of a regeneration unreadable.
            const lines = [];
            let line = '';
            for (const v of list) {
                const item = JSON.stringify(v) + ', ';
                if (line.length + item.length > 92) {
                    lines.push(line.trimEnd());
                    line = '';
                }
                line += item;
            }
            if (line.trim()) lines.push(line.trimEnd().replace(/,$/, ''));
            return `            ${k}: [\n                ${lines.join('\n                ')}\n            ]`;
        }).join(',\n') + '\n        }'
).join(',\n');

const file = `/* Fillsmith — vocabulary. GENERATED FILE, do not edit by hand.
 *
 *   npm run vocab      # regenerates this from @faker-js/faker
 *
 * faker is a build-time source of words, not a runtime dependency: the
 * extension still ships with none and still has no build step. See
 * tools/vendor-faker.mjs for what is taken from which locale and, more to the
 * point, what is deliberately left out — faker's German cities are invented
 * and its postcodes do not match them, its phone numbers are the wrong length,
 * and its lorem is Latin whatever locale you ask for. Those stay ours.
 *
 * ${counts}
 */
(function () {
    'use strict';
    globalThis.FillsmithVocab = {
${body}
    };
})();
`;

writeFileSync(join(root, 'src/vocab.js'), file);
console.log(counts.replace(/ \* {3}/g, ''));
console.log(`\nsrc/vocab.js — ${Math.round(file.length / 1024)}KB`);
