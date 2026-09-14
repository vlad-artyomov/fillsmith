/* FormForge — one fill, on a clean page, and nothing left empty.
 *
 * The other suites ask whether each part behaves; this one asks the only
 * question a tester has: press Fill once on a page nobody has touched, and is
 * the form finished? It is the criterion the project kept failing while every
 * unit check was green — a form that needed two or three fills because the
 * first left a required picker empty and the control that picker unlocks never
 * became fillable.
 *
 * Judged by the page, never by our own report: a required field is empty if
 * its input has no value, or if the component is still showing its placeholder.
 * `run()` believing it wrote something is exactly what was wrong.
 *
 * Run with a seed count: `node test/complete.mjs 25`.
 */
import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const FILLER = [...(readFileSync(resolve(root, 'src/background.js'), 'utf8')
    .match(/const FILLER_FILES = \[([\s\S]*?)\]/) || [, ''])[1]
    .matchAll(/['"]([^'"]+\.js)['"]/g)].map(m => m[1].replace(/^src\//, ''));
const SRC = FILLER.map(f => readFileSync(resolve(root, 'src', f), 'utf8'));

const rounds = Number(process.argv[2]) || 12;
const browser = await chromium.launch();
const page = await browser.newPage();
const crashes = [];
page.on('pageerror', e => crashes.push(String(e.message)));

/* What the page says about itself. A select that still renders its prompt is
 * empty however confidently anything else reports otherwise, and that is the
 * failure this file exists for. */
const verdict = () => page.evaluate(() => {
    const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const empty = [];
    const nameOf = (el) => {
        const lb = el.getAttribute('aria-labelledby');
        const byId = lb && document.getElementById(lb.split(/\s+/)[0]);
        return (byId && byId.textContent.trim())
            || (el.labels && el.labels[0] && el.labels[0].textContent.trim())
            || el.id || el.name || el.className;
    };
    for (const el of document.querySelectorAll('[required], [aria-required="true"]')) {
        if (!vis(el)) continue;
        /* A required control that is still disabled at the end counts as unfinished
         * too. That is the whole shape of the failure this file was written for:
         * the role template on the account form is disabled until an organization
         * is chosen, so a fill that misses the organization leaves it locked and
         * empty — and skipping it here would have called that form complete. */
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            if (el.type === 'checkbox' || el.type === 'radio') {
                const group = el.name ? document.getElementsByName(el.name) : [el];
                if (![...group].some(x => x.checked)) empty.push(nameOf(el));
                continue;
            }
            if (el.type === 'file') {
                if (!(el.files && el.files.length)) empty.push(nameOf(el));
                continue;
            }
            if (!String(el.value || '').trim()) empty.push(nameOf(el));
            continue;
        }
        // A widget root. The component says whether it is showing a prompt.
        const label = el.querySelector('[class*="placeholder"], [class*="-empty"]');
        const inner = el.querySelector('input:not([type="hidden"]), textarea');
        const text = (el.innerText || '').replace(/[▾▼]/g, '').trim();
        if (label || (!text && !(inner && inner.value))) empty.push(nameOf(el));
    }
    return empty;
});

let bad = 0;
for (let i = 0; i < rounds; i++) {
    const seed = 'RUN' + String(i).padStart(3, '0');
    await page.goto('file://' + resolve(root, 'test/primevue-form.html'));
    for (const code of SRC) await page.addScriptTag({content: code});
    const t0 = Date.now();
    /* Both settings, alternating. Overwrite is on by default, and off is the
     * harder case: a control the fill failed to commit still shows its prompt,
     * and anything that reads that prompt as a value skips the field for good. */
    const overwrite = i % 2 === 0;
    const res = await page.evaluate(async ({seed, overwrite}) => {
        const r = await window.__formforge.run({
            seed, locale: 'de-DE', useAI: false, overwrite, emailDomain: 'example.com'
        });
        return {count: r.count, skipped: (r.skipped || []).length, notes: r.notes || []};
    }, {seed, overwrite});
    const left = await verdict();
    const ms = Date.now() - t0;
    if (left.length) {
        bad++;
        console.log(`FAIL  ${seed}${overwrite ? '' : ' (no overwrite)'}  ${left.length} required field(s) still empty after one fill  — ${left.join(', ')}`);
        if (res.notes.length) console.log(`      notes: ${res.notes.slice(0, 4).join(' | ')}`);
    } else {
        console.log(`PASS  ${seed}${overwrite ? '' : ' (no overwrite)'}  form complete in one fill  — ${res.count} fields, ${(ms / 1000).toFixed(1)}s`);
    }
}
await browser.close();

if (crashes.length) {
    console.log(`\npage errors: ${crashes.slice(0, 3).join(' | ')}`);
    bad++;
}
console.log(bad ? `\n${bad} of ${rounds} fills left the form unfinished.`
    : `\nAll ${rounds} fills finished the form on the first press.`);
process.exit(bad ? 1 : 0);
