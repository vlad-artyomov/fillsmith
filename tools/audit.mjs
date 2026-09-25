/* Fillsmith — self-audit.
 *
 * Loads the real unpacked extension into Chromium, fills a page through the
 * same path the shortcuts use, and judges the result the way a person would:
 * what the page holds, what is still on screen, what the console said, where
 * the time went, and — sampled every 50ms while it runs — what the indicator
 * did. A still screenshot cannot tell a working progress bar from a frozen one.
 *
 *   npm run audit                          # the PrimeVue fixture, headless
 *   npm run audit -- --head                # watch it happen
 *   npm run audit -- --url https://…       # any page
 *   npm run audit -- --profile .ff-profile # keep a browser profile (log in once)
 *   npm run audit -- --slow-model 1500     # stand in a model that answers slowly
 *   npm run audit -- --no-model
 *   npm run audit -- --locale en-US --seed ABC123
 *
 * Exit code is the number of findings, so it can gate anything.
 */
import {chromium} from 'playwright';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d = null) => {
    const i = args.indexOf('--' + n);
    return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};
const OUT = join(root, '.ff-out', 'audit');
mkdirSync(OUT, {recursive: true});

const findings = [];
const note = (severity, what, detail) => {
    findings.push({severity, what, detail});
    console.log(`${severity === 'bug' ? 'BUG ' : 'WARN'}  ${what}${detail ? '  — ' + detail : ''}`);
};
const ok = (what, detail) => console.log(`ok    ${what}${detail ? '  — ' + detail : ''}`);

// The injected file list comes from background.js, like everywhere else.
const INJECTED = [...(readFileSync(resolve(root, 'src/background.js'), 'utf8')
    .match(/const FILLER_FILES = \[([\s\S]*?)\]/) || [, ''])[1]
    .matchAll(/['"]([^'"]+\.js)['"]/g)].map(m => m[1]);

// ---------------------------------------------------------------- serving --
let server = null, target = flag('url');
if (!target) {
    const body = readFileSync(join(root, 'test/primevue-form.html'));
    server = createServer((q, r) => {
        r.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
        r.end(body);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    target = `http://127.0.0.1:${server.address().port}/form.html`;
}

/* A named profile persists logins between runs; the default is a throwaway.
 * Chromium serves an unpacked extension's worker from the profile's script
 * cache, so a reused profile would audit the build it saw last time. */
const profile = flag('profile') ? resolve(root, String(flag('profile'))) : mkdtempSync(join(tmpdir(), 'ff-audit-'));
if (flag('profile')) {
    try {
        rmSync(join(profile, 'Default', 'Service Worker'), {recursive: true, force: true});
    } catch (err) {
        // A browser still holding the profile; worth saying, not worth stopping for.
        console.log(`WARN  could not clear the profile's worker cache (${err.code}); it may audit a stale build`);
    }
}
const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !flag('head'),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`,
        '--no-sandbox', '--no-first-run', '--no-default-browser-check']
});

/* A saved profile may carry other extensions, so the worker is found by its
 * script URL rather than by being the first one Chromium happens to report. */
const ours = (w) => w.url().endsWith('/src/background.js');
let worker = ctx.serviceWorkers().find(ours);
for (let i = 0; !worker && i < 4; i++) {
    const next = await ctx.waitForEvent('serviceworker', {timeout: 8000}).catch(() => null);
    if (!next) break;
    if (ours(next)) worker = next;
}
if (!worker) {
    console.log('BUG   the service worker never registered');
    process.exit(1);
}

// A model that answers correctly but slowly is where the interesting failures live.
const slow = Number(flag('slow-model', 0));
if (slow) {
    await worker.evaluate(async (perCall) => {
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                prompt: async (p) => {
                    await new Promise(r => setTimeout(r, perCall));
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                    return JSON.stringify({values: ids.map(id => ({id, value: 'Modellwert ' + id}))});
                },
                destroy() {
                }
            })
        };
        nanoSession = null;
    }, slow);
    console.log(`(standing in a model that takes ${slow}ms per call)`);
}

const swErrors = [];
worker.on('console', m => {
    if (m.type() === 'error') swErrors.push(m.text());
});

/* An application's own console noise is not a finding about Fillsmith. Errors
 * are collected with where they came from, and only the ones raised by our own
 * code count against us; the rest are reported so they are not mistaken for it. */
const page = await ctx.newPage();
const pageErrors = [];
const theirErrors = [];
const fileOf = (m) => (m.location && m.location().url) || '';
const fromUs = (text, where) => /fillsmith/i.test(where) || /fillsmith/i.test(text);
page.on('pageerror', e => (fromUs(String(e.stack || e.message), String(e.stack || ''))
    ? pageErrors : theirErrors).push(String(e.message)));
page.on('console', m => {
    if (m.type() !== 'error') return;
    (fromUs(m.text(), fileOf(m)) ? pageErrors : theirErrors).push(m.text());
});
await page.goto(target, {waitUntil: 'domcontentloaded'});
/* An application renders its form after the bundle and the first queries land.
 * Wait for controls to exist rather than for a clock to run out. */
await page.waitForFunction(
    () => document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="combobox"]').length > 1,
    null, {timeout: 20000}).catch(() => console.log('WARN  no form controls appeared within 20s'));
await page.waitForTimeout(400);

console.log(`\nFillsmith audit — ${target}\n`);

// ------------------------------------------------ what the indicator does --
// Sampled while the fill runs: everything worth knowing about the indicator is only true in motion.
await page.evaluate(() => {
    // Panels the page already had up (an inline calendar) are not ours to blame.
    const vis0 = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    window.__ffPanelsBefore = [...document.querySelectorAll(
        '.p-select-overlay,.p-multiselect-overlay,.p-autocomplete-overlay,.p-datepicker-panel,'
        + '.ant-select-dropdown,.MuiAutocomplete-popper,[data-pc-section="overlay"]')].filter(vis0);
    window.__ffWatch = {widths: [], stages: [], animations: new Set(), boxes: 0};
    const tick = () => {
        const box = document.getElementById('fillsmith-hud');
        if (!box) return;
        window.__ffWatch.boxes = Math.max(window.__ffWatch.boxes,
            document.querySelectorAll('#fillsmith-hud').length);
        const bar = box.querySelector('.ff-bar'), fill = bar && bar.querySelector('i');
        if (fill) window.__ffWatch.widths.push(
            +(fill.getBoundingClientRect().width / bar.getBoundingClientRect().width).toFixed(3));
        const title = box.querySelector('.ff-title');
        const t = title && title.textContent.trim();
        const s = window.__ffWatch.stages;
        if (t && s[s.length - 1] !== t) s.push(t);
        for (const a of document.getAnimations()) {
            if (a.animationName) window.__ffWatch.animations.add(a.animationName);
        }
    };
    window.__ffWatchTimer = setInterval(tick, 50);
});

const tFill = Date.now();
const result = await worker.evaluate(async ({files, at, url}) => {
    /* The page this audit opened, by address. "Whatever is active" was right
     * until the extension started opening its own tab on a fresh install —
     * and a fresh install is what every audit run is. */
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url === url) || tabs.find(t => t.url && t.url.startsWith(url.split('#')[0]))
        || (await chrome.tabs.query({active: true, currentWindow: true}))[0];
    await showBooting(tab.id);
    const seen = await new Promise(r => setTimeout(async () => r(
        (await chrome.scripting.executeScript({
            target: {tabId: tab.id}, func: () =>
                !!document.querySelector('[data-fillsmith-boot]')
        }))[0].result), 120));
    await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
    const t0 = Date.now();
    const res = await chrome.tabs.sendMessage(tab.id, {
        kind: 'fill', settings: {
            locale: at.locale, seed: at.seed || undefined,
            useAI: at.useAI, overwrite: true, emailDomain: 'example.com'
        }
    });
    return {bootSeen: seen, ms: Date.now() - t0, res};
}, {
    files: INJECTED,
    url: target,
    at: {
        useAI: !flag('no-model'),
        locale: String(flag('locale', 'de-DE')),
        seed: flag('seed') === true ? '' : flag('seed')
    }
});
const wall = Date.now() - tFill;

// The bar's width is transitioned and still travelling when the fill returns.
await page.waitForTimeout(400);
const watch = await page.evaluate(() => {
    clearInterval(window.__ffWatchTimer);
    const w = window.__ffWatch;
    return {widths: w.widths, stages: w.stages, animations: [...w.animations], boxes: w.boxes};
});

const r = result.res || {};

// ------------------------------------------------------------- the checks --
if (!result.bootSeen) note('bug', 'nothing appears before the filler is injected');
else ok('an indicator is up before the filler loads');

if (watch.boxes > 1) note('bug', 'more than one indicator on the page', `${watch.boxes}`);

const w = watch.widths;
const back = w.map((v, i) => i && v < w[i - 1] - 0.01 ? `${w[i - 1]}→${v}` : null).filter(Boolean);
if (back.length) note('bug', 'the progress bar goes backwards', `${back.length}×: ${back.slice(0, 3).join(', ')}`);
else if (w.length > 5) ok('the progress bar only moves forward', `${w.length} samples`);
if (w.length && w[w.length - 1] < 0.98) note('warn', 'the progress bar never reaches the end', String(w[w.length - 1]));

for (const a of ['fillsmith-spin', 'fillsmith-breathe', 'fillsmith-shimmer']) {
    if (!watch.animations.includes(a)) note('warn', `the indicator never ran ${a}`);
}
if (watch.animations.length >= 3) ok('the indicator animated while it worked', watch.animations.join(', '));
ok('stages', watch.stages.join(' → '));

/* The rule that matters: judge a fill by the page, not by our own report. */
const page_ = await page.evaluate(() => {
    const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const inputs = [...document.querySelectorAll('input, textarea, select')].filter(vis);
    const emptyRequired = inputs.filter(i =>
        (i.required || i.getAttribute('aria-required') === 'true')
        && !['checkbox', 'radio', 'hidden', 'submit', 'button'].includes((i.type || '').toLowerCase())
        && !String(i.value || '').trim())
        .map(i => i.name || i.id || i.getAttribute('aria-label') || '(unnamed)');
    const errors = [...document.querySelectorAll('*')].filter(el =>
        el.children.length === 0 && vis(el)
        && /is required|required field|ungültig|pflichtfeld|muss ausgefüllt/i.test(el.textContent || ''))
        .map(el => el.textContent.trim().slice(0, 60));
    // Only overlay containers, and only ones not mid-leave.
    const leaving = (el) => !!el.closest('[data-leaving], [class*="-leave-"], [aria-hidden="true"]');
    const panels = [...document.querySelectorAll(
        '.p-select-overlay,.p-multiselect-overlay,.p-autocomplete-overlay,.p-datepicker-panel,'
        + '.ant-select-dropdown,.MuiAutocomplete-popper,[data-pc-section="overlay"]')]
        .filter(el => vis(el) && !leaving(el) && !el.closest('#fillsmith-hud')
            && !(window.__ffPanelsBefore || []).includes(el))
        .map(el => `${el.className} [${el.querySelectorAll('[role="option"]').length} options]`);
    return {emptyRequired, errors: [...new Set(errors)], panels};
});

if (page_.panels.length) note('bug', 'an overlay was left open on the page', page_.panels.join(', '));
else ok('no overlay left open');
if (page_.emptyRequired.length) note('bug', 'required fields are still empty', page_.emptyRequired.join(', '));
else ok('no required field left empty');
if (page_.errors.length) note('bug', 'the page is showing validation errors', page_.errors.join(' | '));
else ok('no validation error on the page');

const skipped = r.skipped || [];
if (skipped.length) note('warn', 'planned but wrote nothing', skipped.map(s => s.label).join(', '));
else ok('everything planned was written', `${r.count} fields`);

const unnamed = (r.filled || []).filter(f => (String(f.label).match(/\p{L}/gu) || []).length < 2);
if (unnamed.length) note('warn', 'fields reported without a readable name', unnamed.map(f => f.label).join(', '));

if (pageErrors.length) note('bug', 'Fillsmith logged errors on the page', pageErrors.slice(0, 3).join(' | '));
else ok('nothing from Fillsmith in the page console');
if (swErrors.length) note('bug', 'the service worker logged errors', swErrors.slice(0, 3).join(' | '));
if (theirErrors.length) {
    console.log(`note  the page logged ${theirErrors.length} error(s) of its own  — ` +
        theirErrors.slice(0, 2).map(t => t.split('\n')[0].slice(0, 90)).join(' | '));
}

// ------------------------------------------------------ the toolbar icon --
const icon = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url === url) || (await chrome.tabs.query({active: true, currentWindow: true}))[0];
    // setIcon has no getter; the question is whether restoring it is rejected.
    startSpin(tab.id);
    await new Promise(r => setTimeout(r, 200));
    const spun = spinFrame > 1;
    const err = await new Promise(r => {
        stopSpin(tab.id);
        setTimeout(() => r(null), 100);
    });
    return {spun, stopped: !spinTimer, err, frames: spinnerFrames().length};
}, target);
if (!icon.spun) note('warn', 'the toolbar icon did not animate');
if (!icon.stopped) note('bug', 'the toolbar icon animation was left running');
if (icon.spun && icon.stopped) ok('the toolbar icon animates and is restored', `${icon.frames} frames`);

// --------------------------------------------------------------- timings --
const ph = r.phase || {};
console.log('\nwhere the time went');
for (const [k, v] of Object.entries(ph)) console.log(`  ${k.padEnd(12)} ${v}ms`);
console.log(`  ${'wall'.padEnd(12)} ${wall}ms`);
// Time spent waiting on the page's own loading indicators is the page's, not ours.
const pageWait = (r.choiceTimings || []).reduce((n, c) => n + (c.load || 0), 0);
if (pageWait) console.log(`  ${'page load'.padEnd(12)} ${pageWait}ms  (waiting on the page's loaders, inside the above)`);
console.log('\nslowest fields');
for (const s of (r.slowest || []).slice(0, 6)) {
    console.log(`  ${String(s.ms).padStart(6)}ms  ${String(s.type).padEnd(14)} ${s.label}`);
}
if (ph.total - pageWait > 6000) note('warn', 'the fill took over six seconds of its own time', `${ph.total - pageWait}ms`);

await page.screenshot({path: join(OUT, 'page.png'), fullPage: false});
writeFileSync(join(OUT, 'fill.json'), JSON.stringify(r, null, 2));
writeFileSync(join(OUT, 'audit.json'), JSON.stringify({findings, watch, phase: ph, wall}, null, 2));

await ctx.close();
if (server) server.close();

console.log(`\n${findings.length ? findings.length + ' finding(s)' : 'nothing to report'} · ${OUT}`);
process.exit(Math.min(findings.length, 120));
