/* Loads the real unpacked extension in Chromium and checks that the manifest
 * is accepted, the service worker registers, and the content script fills a
 * page end-to-end through chrome.tabs messaging. */
import {chromium} from 'playwright';
import {existsSync, mkdtempSync, readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (n, c, x = '') => {
    console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
    if (!c) failures++;
};
const step = (s) => console.log(`....  ${s}`);
// Nothing in this suite should take more than a few seconds.
const withTimeout = (p, ms, label) => Promise.race([
    Promise.resolve(p),
    new Promise(r => setTimeout(() => r({__timeout: label}), ms))
]);
/* A wall against a hang, not a runtime budget. Set just above the local time it
 * caught the suite at 173 of 179 checks on a CI runner, which is a red build
 * that says nothing about the code. Every individual step has its own timeout;
 * this one only has to be longer than all of them together. */
const WATCHDOG_MS = 300000;
const watchdog = setTimeout(() => {
    console.log(`\nWATCHDOG: suite exceeded ${WATCHDOG_MS / 1000}s, aborting`);
    process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

// --- static manifest validation -------------------------------------------
const mf = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
check('manifest is valid JSON and MV3', mf.manifest_version === 3);
/* The filler is injected on demand, not declared as a content script: it used
 * to run in every frame of every page whether or not anyone wanted it, which
 * is a cost paid on all browsing for a tool used a few times a day. Both entry
 * points (the popup and the keyboard commands) inject and retry, so the files
 * are listed in those two places rather than in the manifest. */
/* The background is the one place that names these. Read them from it rather
 * than restating them here, so a file added to the filler cannot pass the
 * suite while being missing from the thing that injects it. */
/* The menu's own registration, read from the worker rather than restated here
 * — the same discipline as the injected file list below. */
const MENU_CONTEXTS = [...readFileSync(join(root, 'src/background.js'), 'utf8')
    .matchAll(/id: '(ff-[a-z-]+)',\s*title: '[^']*',\s*contexts: \[([^\]]*)\]/g)]
    .map(m => [m[1], m[2].replace(/['\s]/g, '')]);

const INJECTED = [...(readFileSync(resolve(root, 'src/background.js'), 'utf8')
    .match(/const FILLER_FILES = \[([\s\S]*?)\]/) || [, ''])[1]
    /* The quoted names, not everything between the commas: the list has a
     * comment in it, and splitting on `,` swallowed half of one as a path. */
    .matchAll(/['"]([^'"]+\.js)['"]/g)].map(m => m[1]);
const referenced = [
    mf.background.service_worker,
    mf.action.default_popup,
    ...INJECTED,
    ...Object.values(mf.icons),
    // Opened by the worker and the popup rather than named in the manifest.
    'src/welcome.html', 'src/welcome.js', 'src/report.html', 'src/report.js', 'src/report.css', 'src/report-text.js'
];
check('filler is injected on demand, not declared', !mf.content_scripts);
check('the injected file list is non-empty and ordered', INJECTED.length >= 4
    && INJECTED[0].endsWith('dom.js') && INJECTED[INJECTED.length - 1].endsWith('content.js'),
    INJECTED.join(' '));
/* Exactly one copy of the list: everything else asks the background for it. */
const popupSrc = readFileSync(join(root, 'src/popup.js'), 'utf8');
check('the popup keeps no second copy of the file list',
    !/src\/(generator|content|fillers|adapters|overlays|dom)\.js/.test(popupSrc));
// Alt+Shift+R rolls a seed for one fill; storing it would pin it for every keyboard fill after.
const bgSrc = readFileSync(join(root, 'src/background.js'), 'utf8');
check('the refill shortcut does not write its seed to storage', !/storage\.local\.set\(\{\s*seed/.test(bgSrc));
/* The model comes up when somebody is about to fill, never because Chrome
 * started: a multi-gigabyte model loading at every launch slowed the browser
 * for people who were not going to see a form that day. */
check('nothing warms the model on install or browser start',
    !/on(Installed|Startup)\.addListener\(\s*warm/.test(bgSrc) && !/function warmOnStart/.test(bgSrc));
check('the setup check covers both halves of the configured backend',
    /kind === 'setup-check'/.test(bgSrc) && /checkSetup/.test(popupSrc));
check('the popup never hands the API key to the page', /apiKey, \.\.\.forPage/.test(popupSrc));
// The report is a page with a plain download link; nothing needs the downloads permission any more.
check('no permission is asked for that the report page made unnecessary', !(mf.permissions || []).includes('downloads'));
check('the manifest names a homepage', /^https:\/\/github\.com\//.test(mf.homepage_url || ''));
check('the focused-field shortcut is declared and handled',
    !!(mf.commands['fill-field'] && mf.commands['fill-field'].suggested_key) && /command === 'fill-field'/.test(bgSrc)
    && mf.version === JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    `manifest ${mf.version}`);
for (const f of referenced) check(`referenced file exists: ${f}`, existsSync(join(root, f)));

// --- live load -------------------------------------------------------------
const userDataDir = mkdtempSync(join(tmpdir(), 'ff-'));
let ctx;
try {
    // Extension service workers only register under the new headless mode.
    ctx = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: true,
        args: [
            `--disable-extensions-except=${root}`,
            `--load-extension=${root}`,
            '--no-sandbox',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-component-update'
        ]
    });
} catch (err) {
    console.log('SKIP  could not launch Chromium with the extension:', err.message);
    process.exit(failures === 0 ? 0 : 1);
}

let worker = ctx.serviceWorkers()[0];
if (!worker) worker = await ctx.waitForEvent('serviceworker', {timeout: 15000}).catch(() => null);
check('service worker registered (manifest accepted by Chrome)', !!worker,
    worker ? worker.url().split('/').slice(-1)[0] : 'none');

if (worker) {
    const id = worker.url().split('/')[2];
    check('extension id resolved', /^[a-p]{32}$/.test(id), id);

    const swErrors = [];
    worker.on('console', m => {
        if (m.type() === 'error') swErrors.push(m.text());
    });

    step('querying on-device model availability');
    const status = await withTimeout(worker.evaluate(async () => {
        const LM = (typeof LanguageModel !== 'undefined' && LanguageModel) || (self.ai && self.ai.languageModel);
        if (!LM) return 'unsupported';
        try {
            return await LM.availability();
        } catch (e) {
            return 'error: ' + e.message;
        }
    }), 10000, 'availability');
    console.log(`INFO  on-device model in this Chromium build: ${JSON.stringify(status)}`);

    /* Two fixtures on one server: the native form for the end-to-end path, and
     * the PrimeVue one for the model checks, because only that one has a field
     * that appears part-way through a fill. */
    const pages = {
        '/form.html': readFileSync(join(root, 'test/form.html')),
        '/primevue-form.html': readFileSync(join(root, 'test/primevue-form.html')),
        '/limit-form.html': readFileSync(join(root, 'test/limit-form.html'))
    };
    /* A form under a policy that forbids everything the indicator needs — a
     * stylesheet, an animation, a script. Applications behind a login are
     * exactly where such a header is set. Its own markup carries nothing inline,
     * so any violation reported on this page is one FormForge caused. */
    const STRICT_CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'";
    pages['/csp.html'] = Buffer.from(
        '<!doctype html><meta charset="utf-8"><title>Strict policy</title><form>' +
        '<label for="n">Full name</label><input id="n" name="fullName" required>' +
        '<label for="e">Email</label><input id="e" name="email" type="email" required>' +
        '<label for="c">Company</label><input id="c" name="company" required></form>');
    // A page with nothing to fill: the fill still has to end, and say so.
    pages['/empty.html'] = Buffer.from(
        '<!doctype html><meta charset="utf-8"><title>Nothing to fill</title><p>No form on this page.</p>');
    /* Closed lists the page spells out in full, beside a text field no rule
     * answers: the credit-card shape, where four of six fields were going to the
     * model to be told what the markup already said. The autocomplete tokens are
     * the ones a real payment form carries. */
    const opts = (list) => list.map(o => `<option>${o}</option>`).join('');
    pages['/cardform.html'] = Buffer.from(
        '<!doctype html><meta charset="utf-8"><title>Card</title><form>' +
        '<label for="cn">Card number</label><input id="cn" name="cc-number" autocomplete="cc-number" required>' +
        '<label for="cv">CVV</label><input id="cv" name="cc-csc" autocomplete="cc-csc" required>' +
        '<label for="ch">Name on card</label><input id="ch" name="cc-name" autocomplete="cc-name" required>' +
        '<label for="ct">Type</label><select id="ct" name="cc-type" autocomplete="cc-type" required>' +
        '<option value=""></option>' + opts(['Visa', 'Master Card', 'American Express', 'Discover']) + '</select>' +
        '<label for="cm">Expiry month</label><select id="cm" name="cc-exp-month" autocomplete="cc-exp-month" required>' +
        '<option value=""></option>' + opts(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) + '</select>' +
        '<label for="cy">Expiry year</label><select id="cy" name="cc-exp-year" autocomplete="cc-exp-year" required>' +
        '<option value=""></option>' + opts(['2026', '2027', '2028', '2029', '2030', '2031', '2032', '2033', '2034']) + '</select>' +
        '<label for="nk">Billing reference</label><input id="nk" name="billingRef" required></form>');
    /* Thirty fields no rule answers: three batches of the model, which one
     * on-device session generates one after another. The work is the point — a
     * ceiling below it cuts the last batch off on every fill, for ever. */
    pages['/manyfields.html'] = Buffer.from(
        '<!doctype html><meta charset="utf-8"><title>Thirty attributes</title><form>' +
        Array.from({length: 30}, (_, i) =>
            `<label for="a${i}">Attribute ${i + 1}</label><input id="a${i}" name="attr${i}" required>`).join('') +
        '</form>');
    /* A form beside the hidden 0x0 frame every tag manager drops on a page. The
     * filler runs in both; only one of them has anything to say. */
    pages['/framed.html'] = Buffer.from(
        '<!doctype html><meta charset="utf-8"><title>Form with a tag-manager frame</title><form>' +
        '<label for="fn">Full name</label><input id="fn" name="fullName" required>' +
        '<label for="fe">Email</label><input id="fe" name="email" type="email" required>' +
        '<label for="fc">Company</label><input id="fc" name="company" required>' +
        '<label for="fp">Phone</label><input id="fp" name="phone" required></form>' +
        '<script>const f=document.createElement("iframe");' +
        'f.width=0;f.height=0;f.style.display="none";document.body.appendChild(f);<\/script>');
    /* Two forms on one page, one of them in a frame, both with fields only the
     * model can answer. The filler runs in each frame and numbers its own fields
     * from zero, so the model's answers have to come back to the frame that
     * asked — a batch sent to the tab lands in both. */
    const codes = (names) => names.map((n, i) =>
        `<label for="c${i}">${n} code</label><input id="c${i}" name="${n.toLowerCase()}Code" required>`).join('');
    pages['/twoforms.html'] = Buffer.from(
        '<!doctype html><meta charset="utf-8"><title>Two forms</title><form>' + codes(['Alpha', 'Beta', 'Gamma']) +
        '</form><iframe src="/innerform.html" width="400" height="200"></iframe>');
    pages['/innerform.html'] = Buffer.from(
        '<!doctype html><meta charset="utf-8"><title>Inner form</title><form>' + codes(['Delta', 'Epsilon', 'Zeta']) + '</form>');
    const server = createServer((req, res) => {
        const path = (req.url || '').split('?')[0];
        const body = pages[path] || pages['/form.html'];
        res.writeHead(200, Object.assign({'content-type': 'text/html; charset=utf-8'},
            path === '/csp.html' ? {'content-security-policy': STRICT_CSP} : {}));
        res.end(body);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = `${origin}/form.html`;
    const fixtureUrl = `${origin}/primevue-form.html`;
    const emptyUrl = `${origin}/empty.html`;

    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForTimeout(300);

    // Drive it exactly the way the popup does: try, inject on failure, retry.
    /* A fresh install opens one page that says what the button does. This
     * profile was created for this run, so the install just happened; an
     * update must not do it, which the worker decides by the reason it is given. */
    const welcome = ctx.pages().filter(p => /\/src\/welcome\.html$/.test(p.url()));
    check('a fresh install opens the welcome page, once', welcome.length === 1, `${welcome.length} welcome tab(s)`);
    if (welcome.length) {
        const keys = await welcome[0].evaluate(() => [...document.querySelectorAll('kbd')].map(k => k.textContent));
        check('and it shows the shortcuts as Chrome bound them',
            keys.length === 4 && keys.every(k => /Shift|not set|⇧/.test(k)), keys.join(' · '));
        for (const w of welcome) await w.close();
    }

    step('injecting on demand');
    const injected = await withTimeout(worker.evaluate(async ({files, match}) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.includes(match));
        if (!tab) return 'no tab matching ' + match;
        try {
            await chrome.tabs.sendMessage(tab.id, {kind: 'scan'});
            return 'already there';
        } catch (_) {
            await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
            const r = await chrome.tabs.sendMessage(tab.id, {kind: 'scan'});
            return r && r.ok ? 'injected' : 'injected but silent';
        }
    }, {files: INJECTED, match: 'form.html'})
        .catch(e => 'failed: ' + e.message), 20000, 'inject');
    check('on-demand injection reaches the page', /injected|already/.test(String(injected)), String(injected));

    /* Drive it the way the popup and the shortcuts do: through askPage, which
     * asks every frame, adds the answers up and records the fill. A message
     * straight at the tab skips all three. */
    step('sending fill message');
    const res = await withTimeout(worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.includes('form.html'));
        return await self.askPage(tab.id, {
            kind: 'fill',
            settings: {seed: 'EXT001', locale: 'de-DE', useAI: true, overwrite: true, emailDomain: 'example.com'}
        });
    }).catch(e => ({ok: false, error: e.message})), 30000, 'fill');

    check('content script answered the fill message', res && res.ok === true, JSON.stringify(res?.error || ''));
    check('fields were filled through the extension path', (res?.count || 0) >= 15, `count=${res?.count}`);

    const email = await page.inputValue('#em');
    const phone = await page.inputValue('#ph');
    check('email filled via extension', /@example\.com$/.test(email), email);
    // The locales the generator ships, offered in the order it lists them.
    // Country code and a full drama number: 12 digits for a city block, 13 for a mobile one.
    check('German locale applied end-to-end', /^49\d{10,11}$/.test(phone), phone);

    /* The toast is a confirmation, not a panel to dismiss: it appears, and then
     * it goes away on its own. Both halves matter — the old one sat over the
     * form for nine seconds, which is what made it annoying. */
    const toast = await page.locator('#formforge-hud').count();
    check('on-page toast rendered', toast === 1);
    const toastText = toast ? await page.locator('#formforge-hud').innerText() : '';
    check('toast says what happened', /\d+\s+fields?/i.test(toastText), toastText.split('\n')[0] || '');
    await page.waitForTimeout(4200);
    check('toast leaves by itself', (await page.locator('#formforge-hud').count()) === 0);

    /* The model is an enhancement, never a dependency. Creating an on-device
     * session takes seconds the first time even when the model is downloaded, and
     * an unbounded await on it made the first fill appear to hang before anything
     * moved. A model that never answers at all must cost a bounded pause and
     * nothing else. */
    step('filling with a model that never answers');
    await worker.evaluate(() => {
        chrome.runtime.onMessage.addListener((msg, sender, respond) => {
            if (msg.kind === 'generate') return true;   // keeps the channel open, never replies
        });
    });
    const wedged = await withTimeout(worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.includes('form.html'));
        const t0 = performance.now();
        const res = await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill',
            settings: {seed: 'WEDGE1', locale: 'de-DE', useAI: true, overwrite: true, emailDomain: 'example.com'}
        });
        return {ms: Math.round(performance.now() - t0), count: res && res.count};
    }).catch(e => ({error: e.message})), 20000, 'wedged');
    check('a model that never answers does not hang the fill',
        wedged && !wedged.error && wedged.ms < 6000, `${wedged && wedged.ms}ms`);
    check('and the form is filled anyway, from the rules',
        (wedged && wedged.count || 0) >= 15, `count=${wedged && wedged.count}`);

    step('sending clear message');
    const cleared = await withTimeout(worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.includes('form.html'));
        return await chrome.tabs.sendMessage(tab.id, {kind: 'clear'});
    }), 15000, 'clear');
    check('clear works through the extension path', cleared?.ok === true && (await page.inputValue('#em')) === '');

    /* The popup is no longer static markup: it previews the persona with the
     * same generator the content script fills from, so a broken load or a
     * renamed export would silently leave the card empty. */
    step('opening the popup');
    const pop = await ctx.newPage();
    const popErrors = [];
    pop.on('pageerror', e => popErrors.push(e.message));
    pop.on('console', m => {
        if (m.type() === 'error') popErrors.push(m.text());
    });
    await pop.goto(`chrome-extension://${id}/src/popup.html`);
    await pop.waitForTimeout(700);

    /* The popup is one button plus settings. The coherent-data machinery behind
     * it is deliberately invisible: a tester should not have to think about a
     * persona or a seed to fill a form. */
    const surface = await pop.evaluate(() => ({
        hasFill: !!document.getElementById('fill'),
        hasScan: !!document.getElementById('scan'),
        hasClear: !!document.getElementById('clear'),
        locales: [...document.querySelectorAll('#locale option')].map(o => o.textContent),
        showsAPersona: !!document.getElementById('pName') || !!document.getElementById('persona'),
        showsASeedOnTheFillPane: !!document.getElementById('seedShown'),
        pinnedByDefault: (document.getElementById('seed') || {}).value || ''
    }));
    check('popup loads without errors', popErrors.length === 0, popErrors.join(' | '));
    check('the fill pane is just the actions',
        surface.hasFill && surface.hasScan && surface.hasClear
        && !surface.showsAPersona && !surface.showsASeedOnTheFillPane);
    /* What a screen reader and a keyboard get: a language on the document, a
     * title, one tab stop for the tablist with the arrows moving inside it, and
     * option labels short enough to fit a 360px select — "Automatic — patient
     * once, brisk a" was what the default used to read. */
    const access = await pop.evaluate(async () => {
        const settings = document.getElementById('tabSettings');
        document.getElementById('tabFill').focus();
        settings.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
        await new Promise(r => setTimeout(r, 50));
        const afterArrow = document.activeElement.id;
        const selectedPane = document.getElementById('paneSettings').hidden === false;
        return {
            lang: document.documentElement.lang, title: document.title,
            live: document.getElementById('result').getAttribute('aria-live'),
            stops: [...document.querySelectorAll('.tab')].map(t => t.tabIndex),
            afterArrow, selectedPane,
            longest: Math.max(...[...document.querySelectorAll('#modelTimeout option, #backend option')].map(o => o.textContent.trim().length))
        };
    });
    check('the popup has a language, a title and a live region for the result',
        access.lang === 'en' && access.title === 'FormForge' && access.live === 'polite',
        JSON.stringify({lang: access.lang, title: access.title, live: access.live}));
    check('the tablist is one tab stop and the arrow keys move within it',
        access.stops.filter(t => t === 0).length === 1 && access.afterArrow === 'tabSettings' && access.selectedPane,
        `stops=${access.stops.join(',')} after ArrowRight: ${access.afterArrow}`);
    check('every option label fits the select it is in', access.longest <= 24, `${access.longest} characters at most`);
    await pop.evaluate(() => document.getElementById('tabFill').click());
    /* Every locale the generator has, and nothing the popup invented: a second
     * copy of this list is how the popup went on offering a locale the generator
     * had dropped. Two, named as languages — which English it is was a
     * distinction nobody filling these forms wanted to make. */
    check('the popup offers exactly the locales the generator ships',
        surface.locales.join('/') === 'EN/DE', surface.locales.join('/'));
    check('nothing is pinned by default, so each fill is fresh data',
        surface.pinnedByDefault === '', surface.pinnedByDefault);

    /* Pinning repeats a fill exactly — the reproduce-a-bug case. */
    const pinned = await pop.evaluate(async () => {
        const seed = document.getElementById('seed');
        /* Typing is saved a moment after the last keystroke, not on each one:
         * thirteen settings written per character is fifty writes for a key. So
         * wait for the value rather than for a clock. */
        const set = async (v) => {
            seed.value = v;
            seed.dispatchEvent(new Event('input', {bubbles: true}));
            for (let i = 0; i < 20; i++) {
                const got = await chrome.storage.local.get(['seed']);
                if (got.seed === v) return;
                await new Promise(r => setTimeout(r, 50));
            }
        };
        await set('PIN123');
        const stored = await chrome.storage.local.get(['seed', 'seedPinned']);
        document.getElementById('reseed').click();
        await new Promise(r => setTimeout(r, 100));
        return {stored, afterReseed: seed.value};
    });
    check('a pinned value is stored as pinned',
        pinned.stored.seed === 'PIN123' && pinned.stored.seedPinned === true,
        JSON.stringify(pinned.stored));
    check('the reseed control offers a different value to pin',
        pinned.afterReseed !== 'PIN123' && pinned.afterReseed.length >= 4, pinned.afterReseed);

    /* A popup is a fresh page each time it opens, so a result rendered into it is
     * gone the moment it closes — and "what did it put where, and why" is the
     * question asked afterwards, not during. The last fill is persisted by the
     * content script, so a fill started by the keyboard is recorded too. */
    const restored = await pop.evaluate(() => {
        const box = document.getElementById('result');
        return {
            shown: !!box && !box.hidden,
            title: box && box.querySelector('.result-title') ? box.querySelector('.result-title').textContent : ''
        };
    });
    check('the last fill is still there after the popup is reopened',
        restored.shown && /\d+ field/.test(restored.title), restored.title || '(nothing)');

    /* The decision trail: what the model was asked, what it said, where the time
     * went, and why each field got what it got. */
    const dbg = await pop.evaluate(async () => {
        document.getElementById('tabDebug').click();
        await new Promise(r => setTimeout(r, 400));
        // A long form folds the rows a rule answered away; the trail is all of it.
        const more = document.querySelector('#debugBody .dbg-more');
        if (more) more.click();
        return document.getElementById('debugBody').innerText;
    });
    /* To scale, and in words. A list of raw counts under the variable names they
     * are stored as made a nine-millisecond contribution and a nine-second one
     * look alike — which is how the model came to be blamed for a sixteen-second
     * fill it had no part in. */
    check('debug shows where the time went, phase by phase',
        /WHERE THE TIME WENT/i.test(dbg) && /\bFilling\b/.test(dbg) && /\d+\s*m?s/.test(dbg),
        (dbg.match(/WHERE THE TIME WENT[\s\S]{0,80}/i) || ['(no timing section)'])[0].replace(/\s+/g, ' '));
    check('debug explains the model', /MODEL[\s\S]*(answered|asked|Not consulted)/.test(dbg));
    // A word a tester can read; the regex behind it is a tooltip, checked below.
    check('debug names the rule behind a value', /matched the [a-z-]+ rule/.test(dbg));
    check('debug says why a fallback was used', /no rule matched/.test(dbg));
    const ruleTip = await pop.evaluate(() => {
        const w = [...document.querySelectorAll('#debugBody .why[title]')];
        return w.length ? w[0].getAttribute('title') : '';
    });
    check('and keeps the regex behind a rule in the tooltip', /^\/.+\/[a-z]*$/.test(ruleTip), ruleTip.slice(0, 60));

    /* Switched off is not the same answer as "the rules covered everything", and
     * the difference is the whole of what to do next: a fill full of filler
     * values used to be reported as one the rules had answered completely. */
    const offTrail = await withTimeout((async () => {
        await worker.evaluate(async () => {
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find(t => t.url && t.url.includes('form.html'));
            await self.askPage(tab.id, {
                kind: 'fill',
                settings: {seed: 'NOAI01', locale: 'de-DE', useAI: false, overwrite: true, emailDomain: 'example.com'}
            });
        });
        return await pop.evaluate(async () => {
            document.getElementById('tabFill').click();
            document.getElementById('tabDebug').click();
            await new Promise(r => setTimeout(r, 400));
            return document.getElementById('debugBody').innerText;
        });
    })().catch(e => String(e.message)), 30000, 'model off');
    check('debug says the model was switched off, not that it was not needed',
        /Switched off in the settings/.test(offTrail) && !/rules answered every field/.test(offTrail),
        (String(offTrail).match(/MODEL\s+([^\n]+)/) || ['', '(no model line)'])[1]);

    /* A profile from an older build is brought forward once, by the worker. The
     * only migration there has ever been lived inline in the popup, so a user
     * who fills from the keyboard never got it — and an upgraded profile kept a
     * pinned seed nobody had pinned, quietly making every fill the same person. */
    const migrated = await withTimeout(worker.evaluate(async () => {
        const saved = await chrome.storage.local.get(['seed', 'seedPinned', 'settingsVersion']);
        await chrome.storage.local.remove(['settingsVersion', 'seedPinned']);
        await chrome.storage.local.set({seed: 'STALE1'});
        await migrateSettings();
        const after = await chrome.storage.local.get(['seed', 'settingsVersion']);
        // And again: a migration that has run is not run twice.
        await chrome.storage.local.set({seed: 'PINNED2', seedPinned: true});
        await migrateSettings();
        const twice = await chrome.storage.local.get(['seed', 'settingsVersion']);
        await chrome.storage.local.set(saved);
        return {after, twice};
    }).catch(e => ({error: e.message})), 10000, 'migrate');
    check('an older profile\'s accidental seed is cleared once, by the worker',
        migrated.after && migrated.after.seed === '' && migrated.after.settingsVersion === 2,
        migrated.error || JSON.stringify(migrated.after));
    check('and a profile already brought forward is left alone',
        migrated.twice && migrated.twice.seed === 'PINNED2', JSON.stringify(migrated.twice));

    /* A fill that gave up waiting recorded only that it gave up — but the worker
     * keeps generating, so what the model was about to say usually exists by the
     * time anybody opens this tab. That collection went through the worker in an
     * envelope and the popup read the envelope as if it were the exchange, so it
     * silently never fired: the tab showed "ran out of time" and nothing else,
     * for exactly the run a tester most wants explained. */
    await worker.evaluate(() => generate({
        persona: {fullName: 'Late Answer'}, pageTitle: 'late',
        context: {heading: 'Late'}, examples: [],
        fields: [{id: 0, label: 'Prüffeld', type: 'text'}]
    }));
    const lateDbg = await pop.evaluate(async () => {
        const kept = await new Promise(r => chrome.storage.local.get({fillHistory: []}, v => r(v.fillHistory)));
        const fill = kept[kept.length - 1];
        fill.modelTimedOut = true;
        fill.modelAsked = true;
        fill.modelDebug = {
            at: Date.now() - 60000, asked: 1, waitedMs: 1500,
            note: 'gave up after 1500ms of a 1500ms budget', batches: [], pending: true
        };
        await new Promise(r => chrome.storage.local.set({fillHistory: kept}, r));
        document.getElementById('tabFill').click();
        document.getElementById('tabDebug').click();
        await new Promise(r => setTimeout(r, 500));
        return document.getElementById('debugBody').innerText;
    });
    check('debug collects an answer that arrived after the fill gave up',
        /finished afterwards/.test(lateDbg),
        (lateDbg.match(/gave up[^\n]*/) || ['(no note)'])[0]);

    /* The setup check, pressed in the real popup: the worker must answer through
     * the message port, and the Settings button must follow what is configured. */
    const setup = await pop.evaluate(async () => {
        const $ = (id) => document.getElementById(id);
        $('tabDebug').click();
        $('checkModel').click();
        const t0 = Date.now();
        while (!/Backend:|Could not/.test($('modelCheck').textContent) && Date.now() - t0 < 30000) {
            await new Promise(r => setTimeout(r, 100));
        }
        const debugText = $('modelCheck').textContent.replace(/\s+/g, ' ').trim();
        $('tabSettings').click();
        const hiddenWhenOnDevice = (() => {
            $('backend').value = 'ondevice-only';
            $('backend').dispatchEvent(new Event('change', {bubbles: true}));
            return $('remoteFields').hidden;
        })();
        $('backend').value = 'ondevice-first';
        $('backend').dispatchEvent(new Event('change', {bubbles: true}));
        const disabledWithoutKey = $('checkSetup').disabled && !$('remoteFields').hidden;
        $('provider').value = 'anthropic';
        $('provider').dispatchEvent(new Event('change', {bubbles: true}));
        $('apiKey').value = 'sk-not-a-real-key';
        $('apiKey').dispatchEvent(new Event('input', {bubbles: true}));
        const enabledWithKey = !$('checkSetup').disabled;
        const modelHint = $('model').placeholder;
        $('apiKey').value = '';
        $('apiKey').dispatchEvent(new Event('input', {bubbles: true}));
        $('provider').value = '';
        $('provider').dispatchEvent(new Event('change', {bubbles: true}));
        return {debugText, hiddenWhenOnDevice, disabledWithoutKey, enabledWithKey, modelHint};
    });
    check('the Debug tab\'s setup check gets an answer through the message port',
        /Backend: on-device model first/.test(setup.debugText) && !/Could not run/.test(setup.debugText),
        setup.debugText.slice(0, 120));
    const anthropicDefault = await worker.evaluate(() => PROVIDERS.anthropic.model);
    check('an empty model field shows which model the provider falls back to',
        setup.modelHint === `${anthropicDefault} (default)`, setup.modelHint);
    check('provider fields hide for an on-device-only backend and the check waits for a key',
        setup.hiddenWhenOnDevice && setup.disabledWithoutKey && setup.enabledWithKey, JSON.stringify(setup));

    /* The Debug tab is opt-in, and "why?" under a result is its door: it used to
     * appear only on a result restored from storage, never on a fresh fill. */
    const dbgTab = await pop.evaluate(() => {
        const $ = (id) => document.getElementById(id);
        const fresh = {ok: true, count: 1, persona: {fullName: 'Probe Person', seed: 'PROBE1'}, filled: [], widgets: 0};
        const before = {tabHidden: $('tabDebug').hidden};
        report(fresh);
        before.why = /why\?/.test($('result').textContent);
        $('debugTab').checked = true;
        $('debugTab').dispatchEvent(new Event('change', {bubbles: true}));
        report(fresh);
        const after = {tabHidden: $('tabDebug').hidden, why: /why\?/.test($('result').textContent)};
        $('result').querySelector('.toDebug').click();
        after.opened = !$('paneDebug').hidden;
        $('debugTab').checked = false;
        $('debugTab').dispatchEvent(new Event('change', {bubbles: true}));
        after.closedAgain = $('paneDebug').hidden && $('tabDebug').hidden;
        return {before, after};
    });
    check('the Debug tab and the "why?" link are off until the setting turns them on',
        dbgTab.before.tabHidden && !dbgTab.before.why && !dbgTab.after.tabHidden && dbgTab.after.why, JSON.stringify(dbgTab));
    check('"why?" on a fresh result opens Debug, and turning the setting off leaves it',
        dbgTab.after.opened && dbgTab.after.closedAgain, JSON.stringify(dbgTab.after));

    /* A check whose port closes must still explain itself: the worker leaves
     * its result and last stage in session storage, and answers who it is. */
    const closed = await pop.evaluate(async () => {
        const $ = (id) => document.getElementById(id);
        const store = chrome.storage.session || chrome.storage.local;
        const kept = await store.get(['checkResult', 'checkStage', 'workerStartedAt']);
        const info = await new Promise(r => chrome.runtime.sendMessage({kind: 'worker-info'}, r));
        const sent = Date.now();
        await store.set({checkStage: {stage: 'waiting for the on-device reply', at: sent + 1}});
        $('tabDebug').click();
        await explainClosedPort($('modelCheck'), sent, 1);
        return {
            result: kept.checkResult && kept.checkResult.backend, stage: kept.checkStage && kept.checkStage.stage,
            startedAt: kept.workerStartedAt, info, text: $('modelCheck').textContent.replace(/\s+/g, ' ').trim()
        };
    });
    check('a finished check is kept in session storage with its last stage',
        closed.result === 'ondevice-first' && closed.stage === 'done' && typeof closed.startedAt === 'number',
        JSON.stringify({result: closed.result, stage: closed.stage}));
    check('the worker reports when it started and what it tripped over',
        closed.info && typeof closed.info.startedAt === 'number' && Array.isArray(closed.info.errors),
        JSON.stringify(closed.info));
    // A provider that accepts the connection and never answers must not hold the check or a fill open.
    const hung = await withTimeout(worker.evaluate(async () => {
        const realFetch = self.fetch, realCap = REMOTE_CAP_MS;
        self.fetch = (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason)));
        REMOTE_CAP_MS = 300;
        try {
            return await remoteCall({provider: 'anthropic', apiKey: 'k'}, [{id: 0, type: 'text', label: 'City'}], 'p');
        } finally {
            self.fetch = realFetch;
            REMOTE_CAP_MS = realCap;
        }
    }), 5000, 'hung provider');
    check('a hosted call that never answers ends with a verdict', hung && /no answer from anthropic within/.test(hung.error || '') && hung.ms < 2000,
        JSON.stringify({error: hung && hung.error, ms: hung && hung.ms}));

    /* The bug this guards: every Anthropic request asked for low effort, which
     * the current models take and Haiku 4.5 answers with "This model does not
     * support the effort parameter" — so a tester who typed a Haiku model got
     * HTTP 400 and no values at all, for an option that only buys a quicker
     * round trip. The model is typed by hand, so which ones accept what is the
     * API's to say: the refusal drops the option, and is remembered. */
    const effort = await withTimeout(worker.evaluate(async () => {
        const realFetch = self.fetch;
        const sent = [];
        self.fetch = async (url, o) => {
            const body = JSON.parse(o.body);
            sent.push(body);
            if (body.output_config) return new Response(JSON.stringify({
                type: 'error',
                error: {type: 'invalid_request_error', message: 'This model does not support the effort parameter.'}
            }), {status: 400});
            return new Response(JSON.stringify({
                content: [{type: 'text', text: '{"values":[{"id":0,"value":"Köln"}]}'}]
            }), {status: 200});
        };
        const cfg = {provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5-20251001'};
        const field = [{id: 0, type: 'text', label: 'City'}];
        try {
            optionsRefused.delete(cfg.model);
            const first = await remoteCall(cfg, field, 'p');
            const afterFirst = sent.length;
            const second = await remoteCall(cfg, field, 'p');
            return {
                first: {value: first.parsed['0'], error: first.error, status: first.status},
                second: {value: second.parsed['0'], error: second.error},
                triesFirst: afterFirst, triesSecond: sent.length - afterFirst,
                asked: sent.map(b => !!b.output_config)
            };
        } finally {
            self.fetch = realFetch;
            optionsRefused.delete(cfg.model);
        }
    }).catch(e => ({error: e.message})), 10000, 'effort');

    check('a model that refuses the effort option is asked again without it',
        effort.first && effort.first.value === 'Köln' && !effort.first.error && effort.triesFirst === 2,
        JSON.stringify(effort.first));
    check('and the refusal is remembered, so the next batch asks once',
        effort.triesSecond === 1 && effort.second && effort.second.value === 'Köln',
        JSON.stringify({tries: effort.triesSecond, asked: effort.asked}));
    check('a closed port is explained by the stage the worker reached',
        /stopped while waiting for the on-device reply/.test(closed.text) && /running since|restarted/.test(closed.text),
        closed.text.slice(0, 160));

    await pop.evaluate(() => document.getElementById('tabFill').click());

    const tabs = await pop.evaluate(() => {
        document.getElementById('tabSettings').click();
        const settingsShown = !document.getElementById('paneSettings').hidden && document.getElementById('paneFill').hidden;
        document.getElementById('tabFill').click();
        return {settingsShown, backToFill: !document.getElementById('paneFill').hidden};
    });
    check('popup tabs switch panes', tabs.settingsShown && tabs.backToFill);

    /* The footer reports the bindings Chrome actually has, which is the whole
     * point of it: how many of four suggested keys a fresh profile takes is the
     * platform's business, not ours. macOS binds all four; a Linux CI runner
     * binds two and leaves refill and clear unassigned. Pressing an unassigned
     * one types a character into the page, so what has to hold is that the
     * footer agrees with chrome.commands and offers a way to set the rest. */
    const keys = await pop.evaluate(() => new Promise(r => chrome.commands.getAll(cs => r({
        bound: cs.filter(c => c.name !== '_execute_action').map(c => ({name: c.name, shortcut: c.shortcut})),
        foot: (document.getElementById('shortcuts') || {}).textContent || '',
        link: !!document.getElementById('assignKeys')
    }))));
    const set = keys.bound.filter(c => c.shortcut);
    const unset = keys.bound.length - set.length;
    check('the popup footer reports every shortcut Chrome actually bound',
        keys.bound.length === 4 && set.every(c => keys.foot.includes(c.shortcut)),
        `${set.length}/${keys.bound.length} bound — ${keys.foot.replace(/\s+/g, ' ').trim()}`);
    check('and says how many are unassigned, with a way to set them',
        unset === 0 ? !/not set/.test(keys.foot)
            : new RegExp(`${unset} shortcuts? not set`).test(keys.foot) && keys.link,
        `${unset} unassigned`);

    /* A disabled button reading "Filling…" for three seconds says nothing about
     * whether anything is happening. The stages are already being computed, so
     * the popup shows them as they arrive — one row per stage, updated in place,
     * so a stage reported forty times with a moving count is a line that counts
     * up rather than forty lines of noise. Every row is something that actually
     * happened; there is no pool of plausible phrases to pad it with. */
    await worker.evaluate(async () => {
        const send = (step) => chrome.runtime.sendMessage({kind: 'fill-progress', step})
            .catch(() => {
            });
        await send({stage: 'read', text: 'Reading the form'});
        await send({stage: 'model', text: 'Asking the model about 6 fields'});
        await send({stage: 'model', text: 'Asking the model about 6 fields', detail: '4 answered'});
        await send({stage: 'fill', text: 'Filling the form', done: 1, total: 20, label: 'Land'});
        await send({stage: 'fill', text: 'Filling the form', done: 9, total: 20, label: 'Stadt'});
    });
    const live = await pop.evaluate(async () => {
        await new Promise(r => setTimeout(r, 250));
        const box = document.getElementById('result');
        return {
            hidden: box.hidden, rows: box.querySelectorAll('.act').length,
            now: box.querySelectorAll('.act.is-now').length,
            text: box.innerText.replace(/\s+/g, ' ').trim()
        };
    });
    check('the popup streams the stages of a fill as they happen',
        live.rows === 3 && live.now === 1 && /4 answered/.test(live.text) && /9\/20/.test(live.text),
        `${live.rows} rows: ${live.text}`);
    check('and the field it is on right now, under the row it belongs to',
        /Stadt/.test(live.text) && !/Land/.test(live.text), live.text);

    await pop.close();

    /* Injection happens on demand and can happen twice: the popup warms the page
     * when it opens, and dispatch injects again if its first message beats that.
     * Each injection re-runs content.js, and a second listener turns one Fill
     * into two concurrent runs — which race, and the loser's fallback lands on
     * top of the winner's model answer. */
    step('injecting twice, then filling once');
    const doubled = await withTimeout(worker.evaluate(async (files) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.includes('form.html'));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        // Zero it after injecting, so the count is this fill and nothing before it.
        await chrome.scripting.executeScript({
            target: {tabId: tab.id}, func: () => {
                globalThis.__formforgeRuns = 0;
            }
        });
        await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill',
            settings: {seed: 'DBL1', locale: 'de-DE', useAI: false, overwrite: true, emailDomain: 'example.com'}
        });
        // executeScript runs in the same isolated world the filler lives in.
        const [{result}] = await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: () => globalThis.__formforgeRuns || 0
        });
        return result;
    }, INJECTED).catch(e => ({error: e.message})), 25000, 'double');
    check('injecting twice does not fill twice', doubled === 1, `runs=${JSON.stringify(doubled)}`);

    /* Small models do not reliably echo identifiers. Asked about field 0, Nano
     * answered {"id":1,"value":"Training"} — a good value, thrown away because
     * the number did not match, so the fill reported "answered none" and fell
     * back. The reply arrives in the order the fields were asked; that is
     * enough. */
    /* "Is the model ready?" has to be judged on whether a usable value comes
     * back for the field asked about — parsed the way a fill parses it. An
     * earlier version asked the model to reply with the literal word "ok" and
     * called anything else a failure, which marked a model doing exactly the
     * right thing as broken: the session is briefed to invent realistic data and
     * never emit placeholder words, so it answered with a value instead. */
    step('judging whether the model is answering');
    const verdicts = await withTimeout(worker.evaluate(async () => {
        const run = async (reply, slow) => {
            const fake = () => ({
                inputUsage: 151, inputQuota: 9216,
                async prompt() {
                    await new Promise(r => setTimeout(r, slow ? 3200 : 60));
                    return reply;
                },
                async clone() {
                    return fake();
                },
                destroy() {
                }
            });
            const real = self.LanguageModel;
            self.LanguageModel = {
                async availability() {
                    return 'available';
                }, async create() {
                    return fake();
                }
            };
            nanoSession = null;
            const out = await nanoCheck();
            self.LanguageModel = real;
            nanoSession = null;
            return out;
        };
        // The whole-setup check, with nothing configured: it must say so in words, not fail.
        const bare = await setupCheck();
        return {
            bare: {backend: bare.backend, ondevice: !!bare.ondevice, remote: bare.remote && bare.remote.error},
            renumbered: await run('{"values":[{"id":1,"value":"1234567890"}]}', false),
            exact: await run('{"values":[{"id":0,"value":"Köln"}]}', false),
            slow: await run('{"values":[{"id":1,"value":"Hamburg"}]}', true),
            blank: await run('{"values":[{"id":1,"value":"   "}]}', false),
            junk: await run('{"values":[{"id":0,"value":"N/A"}]}', false),
            prose: await run('I am afraid I cannot help with that.', false)
        };
    }).catch(e => ({error: e.message})), 25000, 'verdicts');

    check('the setup check names what is missing instead of failing',
        verdicts.bare && verdicts.bare.backend === 'ondevice-first' && verdicts.bare.ondevice && /no provider chosen/.test(verdicts.bare.remote || ''),
        JSON.stringify(verdicts.bare));
    check('a well-formed answer counts, even with a renumbered id',
        verdicts.renumbered && verdicts.renumbered.ok && verdicts.renumbered.value === '1234567890',
        JSON.stringify(verdicts.renumbered && verdicts.renumbered.value));
    check('an answer with the expected id counts too',
        verdicts.exact && verdicts.exact.ok, JSON.stringify(verdicts.exact && verdicts.exact.value));
    check('a slow answer is still an answer, and says so',
        verdicts.slow && verdicts.slow.ok && /slow/i.test(verdicts.slow.note || ''),
        (verdicts.slow && verdicts.slow.note) || '');
    check('a blank value does not count as answering',
        verdicts.blank && verdicts.blank.ok === false, JSON.stringify(verdicts.blank && verdicts.blank.value));
    // "N/A" in a city box is a form that looks filled and validates nothing; the field falls to the rules instead.
    check('a value that says "no value" does not count as answering',
        verdicts.junk && verdicts.junk.ok === false, JSON.stringify(verdicts.junk && verdicts.junk.value));
    check('prose instead of JSON does not count as answering',
        verdicts.prose && verdicts.prose.ok === false, (verdicts.prose && verdicts.prose.note) || '');

    /* Three callers ask for a session within a few hundred milliseconds of each
     * other on every fill — the popup warms on open, run() warms before reading
     * the form, and the fill itself asks. Each must not start its own: several
     * models loading at once is slow enough to exhaust a thirty-second budget on
     * a machine that used to answer in two.
     *
     * And a session remembers every prompt it is given, so reusing one across
     * batches makes each call carry all the ones before it. Each batch gets a
     * clone, which starts from the system prompt and nothing else. */
    step('checking session building and reuse');
    const sessions = await withTimeout(worker.evaluate(async () => {
        let creates = 0, clones = 0;
        const fake = () => ({
            inputUsage: 10, inputQuota: 1024,
            async prompt() {
                return '{"values":[{"id":1,"value":"ok"}]}';
            },
            async clone() {
                clones++;
                return fake();
            },
            destroy() {
            }
        });
        const realLM = self.LanguageModel;
        self.LanguageModel = {
            async availability() {
                return 'available';
            },
            async create() {
                creates++;
                await new Promise(r => setTimeout(r, 300));
                return fake();
            }
        };
        nanoSession = null;
        await Promise.all([0, 1, 2].map(() => nanoSessionGet({allowDownload: false})));
        const s = await nanoSessionGet({});
        for (let i = 0; i < 3; i++) {
            const {s: turn, temporary} = await statelessSession(s);
            await turn.prompt('x');
            if (temporary) turn.destroy();
        }
        self.LanguageModel = realLM;
        nanoSession = null;
        return {creates, clones};
    }).catch(e => ({error: e.message})), 15000, 'sessions');

    check('simultaneous callers share one session build',
        sessions && sessions.creates === 1, `creates=${JSON.stringify(sessions)}`);
    check('each batch gets a fresh context rather than a growing one',
        sessions && sessions.clones === 3, `clones=${JSON.stringify(sessions)}`);

    /* The bug this guards: a cold create() takes about half a minute, the fill
     * waits three seconds for it, and Chrome stops a worker it has seen idle for
     * thirty — so the build the fill walked away from was killed before it
     * finished, and the next fill started another one from zero. The model
     * answered only when somebody clicked Fill four or five times in a row, fast
     * enough that the clicks themselves kept the worker awake. A build must
     * outlive the fill that gave up on it, and the session it produces must
     * still be there when the next fill asks. */
    step('letting a build the fill gave up on finish anyway');
    const survived = await withTimeout(worker.evaluate(async () => {
        const ask = (sessionWaitMs) => generate({
            persona: PROBE_PERSONA, pageTitle: 'FormForge self-check', fields: PROBE_FIELD,
            context: {}, examples: [], sessionWaitMs, budgetMs: 4000
        }, null);
        const real = self.LanguageModel;
        let creates = 0;
        self.LanguageModel = {
            async availability() {
                return 'available';
            },
            async create() {
                creates++;
                await new Promise(r => setTimeout(r, 2500));  // a cold build, in miniature
                const fake = {
                    inputUsage: 1, inputQuota: 99,
                    async prompt() {
                        return '{"values":[{"id":0,"value":"Köln"}]}';
                    },
                    async clone() {
                        return fake;
                    },
                    destroy() {
                    }
                };
                return fake;
            }
        };
        nanoSession = null;
        awakeJobs = 0;
        awakeUntil = 0;
        if (awakeTimer) clearInterval(awakeTimer);
        awakeTimer = null;

        const first = await ask(300);                        // gives up long before the build lands
        const heldWhileBuilding = !!awakeTimer && awakeJobs > 0;
        await new Promise(r => setTimeout(r, 2500));
        const built = !!nanoSession;
        const heldAfter = awakeUntil - Date.now();

        const second = await ask(0);                          // the next fill, on the session the first one paid for
        self.LanguageModel = real;
        nanoSession = null;
        const out = {
            creates, heldWhileBuilding, built, heldAfter,
            firstVia: first.via, firstWarming: !!first.warming, firstWarmingMs: first.warmingMs,
            secondVia: second.via, secondValue: second.values && second.values['0']
        };
        // The ticker must also stop: a hold that never expires is a worker that never sleeps.
        awakeJobs = 0;
        awakeUntil = 0;
        awakeTick();
        out.stops = awakeTimer === null;
        return out;
    }).catch(e => ({error: e.message})), 20000, 'survived');

    check('a fill that gives up on the model says so, and says for how long it has been loading',
        survived.firstVia === 'none' && survived.firstWarming === true && survived.firstWarmingMs >= 0,
        JSON.stringify(survived));
    check('the worker holds itself up while the session is being built',
        survived.heldWhileBuilding === true, JSON.stringify(survived.heldWhileBuilding));
    check('the build the fill walked away from finishes anyway',
        survived.built === true && survived.creates === 1, `built=${survived.built} creates=${survived.creates}`);
    check('the session it produced is held for the fill after it',
        survived.heldAfter > 60000 && survived.secondVia === 'on-device' && survived.secondValue === 'Köln',
        JSON.stringify({heldAfter: survived.heldAfter, via: survived.secondVia, value: survived.secondValue}));
    check('the hold expires rather than keeping the worker up for ever',
        survived.stops === true, JSON.stringify(survived.stops));

    /* The parser is the thing under test and it lives in the service worker, so
     * test it there — no page needed. */
    step('reconciling a reply whose ids do not match the request');
    const reconciled = await withTimeout(worker.evaluate(() => ({
        shifted: parseValues('{"values":[{"id":1,"value":"Training"}]}', [{id: 0}]),
        correct: parseValues('{"values":[{"id":0,"value":"Training"}]}', [{id: 0}]),
        allWrong: parseValues('{"values":[{"id":1,"value":"A"},{"id":2,"value":"B"}]}', [{id: 4}, {id: 7}]),
        noIds: parseValues('{"values":[{"value":"A"},{"value":"B"}]}', [{id: 4}, {id: 7}]),
        /* The shape that produced the bug: unlabelled entries that do not line up
         * with what was asked. Slid into the next free slot they put a state in
         * the phone box and an address line in the state — values that read as
         * data rather than as a miss, which is worse than an empty field. */
        tooMany: parseValues('{"values":[{"value":"A"},{"value":"X"},{"value":"B"}]}', [{id: 4}, {id: 7}]),
        tooFew: parseValues('{"values":[{"value":"A"}]}', [{id: 4}, {id: 7}]),
        mixed: parseValues('{"values":[{"id":4,"value":"A"},{"value":"X"}]}', [{id: 4}, {id: 7}]),
        /* The shape the prompt asks for and the grammar enforces. */
        map: parseValues('{"4":"A","7":"B"}', [{id: 4}, {id: 7}]),
        mapJunk: parseValues('{"4":"A","7":"N/A"}', [{id: 4}, {id: 7}]),
        mapStrange: parseValues('{"4":"A","99":"B"}', [{id: 4}, {id: 7}]),
        /* Asked about a label it cannot read, the model answers with the label.
         * Seen on roboform's test form: "46cccstsvc" for the field of that name,
         * "60pers Male" for "60pers sex", and a bare "68" for "68 income". */
        echoed: parseValues('{"4":"46cccstsvc","7":"60pers Male"}',
            [{id: 4, label: '46cccstsvc'}, {id: 7, label: '60pers sex'}]),
        headOnly: parseValues('{"4":"68","7":"Marketing"}',
            [{id: 4, label: '68 income'}, {id: 7, label: '72 commnt'}]),
        /* A word from its own label at the front of a real answer stays put, so
         * long as the label's first word is a word and not a number. */
        kept: parseValues('{"4":"Project Apollo"}', [{id: 4, label: 'Project name'}])
    })).catch(e => ({error: e.message})), 10000, 'reconcile');

    check('an answer with a shifted id is still used',
        reconciled && reconciled.shifted && reconciled.shifted['0'] === 'Training',
        JSON.stringify(reconciled && reconciled.shifted));
    check('an answer with the right id is unaffected',
        reconciled && reconciled.correct && reconciled.correct['0'] === 'Training',
        JSON.stringify(reconciled && reconciled.correct));
    check('answers with unrecognised ids fall back to order',
        reconciled && reconciled.allWrong && reconciled.allWrong['4'] === 'A' && reconciled.allWrong['7'] === 'B',
        JSON.stringify(reconciled && reconciled.allWrong));
    check('answers with no ids at all fall back to order',
        reconciled && reconciled.noIds && reconciled.noIds['4'] === 'A' && reconciled.noIds['7'] === 'B',
        JSON.stringify(reconciled && reconciled.noIds));
    check('but order is not used when the count does not match',
        reconciled && !Object.keys(reconciled.tooMany || {}).length && !Object.keys(reconciled.tooFew || {}).length,
        `${JSON.stringify(reconciled && reconciled.tooMany)} / ${JSON.stringify(reconciled && reconciled.tooFew)}`);
    check('and an odd entry among named ones is dropped, not slid into the next slot',
        reconciled && reconciled.mixed && reconciled.mixed['4'] === 'A' && reconciled.mixed['7'] === undefined,
        JSON.stringify(reconciled && reconciled.mixed));
    check('an answer that is only the label is not an answer',
        reconciled && reconciled.echoed && reconciled.echoed['4'] === undefined
        && reconciled.echoed['7'] === 'Male',
        JSON.stringify(reconciled && reconciled.echoed));
    check('and a numbered label at the front of one is taken off, not the answer',
        reconciled && reconciled.headOnly && reconciled.headOnly['4'] === undefined
        && reconciled.headOnly['7'] === 'Marketing'
        && reconciled.kept && reconciled.kept['4'] === 'Project Apollo',
        `${JSON.stringify(reconciled && reconciled.headOnly)} / ${JSON.stringify(reconciled && reconciled.kept)}`);
    check('a reply keyed by id is read straight off',
        reconciled && reconciled.map && reconciled.map['4'] === 'A' && reconciled.map['7'] === 'B',
        JSON.stringify(reconciled && reconciled.map));
    check('a keyed reply is held to the same rules as a listed one',
        reconciled && reconciled.mapJunk && reconciled.mapJunk['7'] === undefined
        && reconciled.mapStrange && reconciled.mapStrange['4'] === 'A' && reconciled.mapStrange['7'] === undefined,
        `${JSON.stringify(reconciled && reconciled.mapJunk)} / ${JSON.stringify(reconciled && reconciled.mapStrange)}`);

    /* A field with no rule should get a model answer, not a fallback — including
     * one that only appears part-way through the fill, which earlier went
     * straight to the fallback because the model is a batched round trip. One
     * batch per pass costs what the first one did. */
    step('filling with a model that answers');
    const answered = await withTimeout(worker.evaluate(async ({files, url}) => {
        const stub = (msg, sender, respond) => {
            if (msg.kind !== 'generate') return;
            const values = {};
            /* The editor gets what the on-device model really sent once: a whole
             * release note wrapped in <em>, with no block markup in it at all. */
            for (const f of msg.payload.fields) {
                values[f.id] = f.richText ? '<em>MODEL-' + f.id + ' wrapped in italics.</em>' : 'MODEL-' + f.id;
            }
            respond({ok: true, values, via: 'stub', debug: {batches: [], asked: msg.payload.fields.length}});
            return true;
        };
        chrome.runtime.onMessage.addListener(stub);
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 700));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const res = await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill',
            settings: {seed: 'AI1', locale: 'de-DE', useAI: true, overwrite: true, emailDomain: 'example.com'}
        });
        const editor = await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: () => {
                const el = document.querySelector('.ql-editor');
                return el ? el.innerHTML : '';
            }
        });
        await chrome.tabs.remove(tab.id);
        chrome.runtime.onMessage.removeListener(stub);
        const weak = (res.filled || []).find(f => /notiz|comment|description|information/i.test(f.label));
        return {
            aiUsed: res.aiUsed,
            editor: (editor[0] && editor[0].result) || '',
            weakOverridden: !!(weak && String(weak.source).startsWith('ai')),
            weakSample: weak ? `${weak.label}=${weak.value} [${weak.source}]` : '',
            fallbacks: (res.filled || []).filter(f => String(f.source).startsWith('fallback')).map(f => f.label),
            late: (res.filled || []).filter(f => /appeared mid-fill/.test(f.why || ''))
                .map(f => `${f.label}=${f.value}`)
        };
    }, {files: INJECTED, url: fixtureUrl}).catch(e => ({error: e.message})), 30000, 'ai-fill');

    check('a generic rule yields to the model',
        answered && !answered.error && answered.weakOverridden,
        (answered && answered.weakSample) || 'no weak-rule field found');
    check('with a model available, nothing falls back',
        answered && !answered.error && answered.fallbacks.length === 0,
        (answered && (answered.error || answered.fallbacks.join(', '))) || '');
    check('a field that appears mid-fill is answered by the model too',
        answered && answered.late.some(x => /MODEL-/.test(x)), (answered && answered.late.join(' ')) || 'none');
    /* The model answers a rich-text field in prose, and the editor is the one
     * control where prose is a worse answer than the markup it replaces: its
     * bold, its italic and its list are what a tester is there to exercise.
     * Dropped in as text it also took the formatting it landed on, and a whole
     * release note came out bold. */
    check('a model answer reaches the editor as markup, in the shape a rule would have built',
        answered && /MODEL-/.test(answered.editor || '')
        && /<p>/.test(answered.editor || '')
        && /<strong>|<em>|<li/.test(answered.editor || ''),
        (answered && (answered.editor || '').slice(0, 130)) || '');
    /* Inline tags around the whole answer are not a layout, and taken for one
     * they put the note in as a single italic run. Only block markup says the
     * model laid the answer out itself. */
    /* Laid out, not passed through: more than one block, whatever shape the
     * layout drew. Written as it arrived it would be a single italic run. */
    check('and an answer wrapped in inline tags is laid out, not written as one italic run',
        answered && ((answered.editor || '').match(/<p>|<li/g) || []).length >= 2
        && !/^\s*<em>/.test(answered.editor || ''),
        (answered && (answered.editor || '').slice(0, 130)) || '');

    /* Pressing the shortcut used to do nothing visible until six files had been
     * injected and the first field read — a second or more of a page that looks
     * untouched, with no popup open to say otherwise. One executeScript with a
     * function lands in milliseconds, and content.js then takes the same element
     * over rather than replacing it, so there is never a blink or a second box. */
    step('showing something before the filler is even injected');
    const booted = await withTimeout(worker.evaluate(async ({files, url}) => {
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 500));
        const t0 = Date.now();
        await showBooting(tab.id);
        const ms = Date.now() - t0;
        const read = async () => (await chrome.scripting.executeScript({
            target: {tabId: tab.id}, func: () => {
                const b = document.getElementById('formforge-hud');
                return {
                    boxes: document.querySelectorAll('#formforge-hud').length,
                    text: b ? b.innerText.replace(/\s+/g, ' ').trim() : null,
                    isStub: !!(b && b.hasAttribute('data-formforge-boot'))
                };
            }
        }))[0].result;
        const before = await read();
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill',
            settings: {seed: 'BOOT1', locale: 'de-DE', useAI: false, overwrite: true}
        });
        const after = await read();
        await chrome.tabs.remove(tab.id);
        return {ms, before, after};
    }, {files: INJECTED, url: fixtureUrl}).catch(e => ({error: e.message})), 30000, 'boot');

    check('something is on the page before the filler is',
        booted && !booted.error && booted.before.isStub && /Starting/.test(booted.before.text || ''),
        booted && booted.error ? booted.error : `${booted && booted.before.text} in ${booted && booted.ms}ms`);
    check('and the real indicator takes that same box over',
        booted && !booted.error && booted.after.boxes === 1 && !booted.after.isStub
        && /Filled \d+ field/.test(booted.after.text || ''),
        booted && !booted.error ? `${booted.after.boxes} box(es): ${booted.after.text}` : '');

    /* Right-click is where a tester already is when a field is giving them
     * trouble, and it is the only entry point that can mean *this* field. */
    step('registering the context menu');
    const menus = await withTimeout(worker.evaluate(async () => {
        installMenus();
        await new Promise(r => setTimeout(r, 300));
        // Creating an id that already exists is the only way to ask whether it does.
        const exists = (id) => new Promise(r => {
            try {
                chrome.contextMenus.create({id, title: 'probe', contexts: ['page']}, () => {
                    const taken = !!chrome.runtime.lastError;
                    if (!taken) chrome.contextMenus.remove(id, () => void chrome.runtime.lastError);
                    r(taken);
                });
            } catch (_) {
                r(false);
            }
        });
        return {
            page: await exists('ff-fill-page'),
            field: await exists('ff-fill-field'),
            clear: await exists('ff-clear-page')
        };
    }).catch(e => ({error: e.message})), 15000, 'menus');
    check('the context menu offers page, field and clear',
        menus && menus.page && menus.field && menus.clear, JSON.stringify(menus));
    /* And offers them where they mean something. "Fill just this field" on the
     * bare page background names a field that is not there; Chrome's editable
     * context is the exact test, and it covers the widgets that are built on a
     * real input — an autocomplete, a date picker, a rich-text editor. */
    const contexts = Object.fromEntries(MENU_CONTEXTS);
    check('and offers the per-field entry only where there is a field',
        contexts['ff-fill-field'] === 'editable'
        && contexts['ff-fill-page'].includes('page'),
        `field: [${contexts['ff-fill-field']}]`);

    /* Nano copies the shape of the example it is shown. The schema constrains the
     * decoder but is never spelled out (omitResponseConstraintInput), so the
     * skeleton on the last line of the prompt is the only shape the model sees —
     * and a skeleton holding one {"id":N} got one value back for a batch of
     * twelve, every time. Eleven fields then read "the model had no answer for
     * it" and went to the filler. This stub is deliberately as literal-minded as
     * the real thing: it answers exactly as many fields as the skeleton shows. */
    step('the prompt asks for one entry per field');
    const skeleton = await withTimeout(worker.evaluate(async () => {
        const realGlobal = self.LanguageModel, realSession = nanoSession;
        nanoSession = null;
        const seen = [];
        const constrained = [];
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                // As many answers as the example shows, in the order the fields were listed.
                prompt: async (p, opts) => {
                    seen.push(p);
                    constrained.push(opts && opts.responseConstraint);
                    const shown = (p.split('\n').pop().match(/":""/g) || []).length;
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                    const out = {};
                    for (const id of ids.slice(0, shown)) out[id] = 'Wert ' + id;
                    return JSON.stringify(out);
                },
                destroy() {
                }
            })
        };
        const fields = [];
        for (let i = 0; i < 12; i++) fields.push({id: i, label: `Feld ${i}`, type: 'text'});
        const res = await generate({persona: {fullName: 'W'}, pageTitle: 'w', context: {}, examples: [], fields});
        self.LanguageModel = realGlobal;
        nanoSession = realSession;
        return {
            answered: Object.keys(res.values || {}).length,
            tails: seen.map(p => p.split('\n').pop()),
            required: constrained.map(c => (c && c.required) || []),
            closed: constrained.every(c => c && c.additionalProperties === false)
        };
    }).catch(e => ({error: e.message})), 25000, 'skeleton');

    check('a batch of twelve comes back with twelve values',
        skeleton && !skeleton.error && skeleton.answered === 12,
        skeleton && skeleton.error ? skeleton.error : `${skeleton && skeleton.answered} answered`);
    check('and the example each batch is shown holds every id it asks about, not just one',
        skeleton && !skeleton.error && skeleton.tails.length === 2
        && (skeleton.tails[0].match(/":""/g) || []).length === 8
        && (skeleton.tails[1].match(/":""/g) || []).length === 4,
        skeleton && skeleton.tails ? skeleton.tails.join(' | ').slice(0, 140) : '');
    /* The example is what the model copies; the grammar is what stops it copying
     * only the first line of it. Both name all twelve or neither is worth having. */
    check('and the grammar requires every id of that batch and admits nothing else',
        skeleton && !skeleton.error && skeleton.closed === true
        && (skeleton.required || []).map(r => r.join(',')).join(' | ') === '0,1,2,3,4,5,6,7 | 8,9,10,11',
        skeleton ? `${(skeleton.required || []).map(r => r.length).join('+')} required, closed=${skeleton.closed}` : '');

    /* On a small on-device model the length of the request is most of the
     * latency, so the prompt has a budget and this is it. A full batch of twelve
     * fields, each with a label, a section and a limit, fits in 750 characters
     * — and a line added to every prompt has to earn its place against that.
     * The skeleton is a map keyed by id rather than a list of objects naming it,
     * which is where a third of the prompt went; "text" and "required" came off
     * the field lines because neither told the model anything. */
    const budget = await withTimeout(worker.evaluate(() => {
        const fields = Array.from({length: 12}, (_, i) => ({
            id: i, type: i % 4 ? 'text' : 'textarea', label: `Attribute ${i + 1}`,
            section: 'Registration', required: i % 3 === 0, maxLength: i % 2 ? 60 : null
        }));
        const persona = {
            fullName: 'Emma Schottmann', company: 'Silverpine Digital KG',
            city: 'Stuttgart', country: 'Deutschland', language: 'German'
        };
        return {
            prompt: buildUserPrompt(persona, 'New location', fields, {}, []).length,
            system: SYSTEM_PROMPT.length
        };
    }).catch(e => ({error: e.message})), 10000, 'prompt size');
    check('a batch of twelve stays inside its character budget',
        budget.prompt > 0 && budget.prompt <= 750 && budget.system <= 650,
        budget.error || `${budget.prompt} chars, on a system prompt of ${budget.system}`);

    /* The first create() after the extension loads is where the browser brings a
     * multi-gigabyte model into memory, and it routinely takes longer than any
     * budget a fill can reasonably wait — which is why the first fill after a
     * reload never got an answer and the second was instant. Waiting it out
     * produces a fill that is slow *and* modelless; the worst of both. Give up
     * quickly, say which of the two reasons it was, and let the load finish in
     * the background so the next fill has a session waiting. */
    step('a session that is still building');
    const warming = await withTimeout(worker.evaluate(async () => {
        const realGlobal = self.LanguageModel;
        const realSession = nanoSession;
        nanoSession = null;
        let released;
        const slow = new Promise(r => {
            released = r;
        });
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => {
                await slow;
                return {
                    prompt: async () => '{"values":[]}', destroy() {
                    }
                };
            }
        };
        const t0 = Date.now();
        const res = await generate({
            persona: {fullName: 'W'}, pageTitle: 'w',
            context: {}, examples: [], fields: [{id: 0, label: 'Feld', type: 'text'}]
        });
        const gaveUpAfter = Date.now() - t0;
        released({});
        await new Promise(r => setTimeout(r, 50));
        self.LanguageModel = realGlobal;
        nanoSession = realSession;
        return {gaveUpAfter, warming: res.warming, via: res.via, note: res.debug && res.debug.note};
    }).catch(e => ({error: e.message})), 25000, 'warming');

    check('a fill does not wait forever for a model that is still loading',
        warming && !warming.error && warming.gaveUpAfter < 8000,
        warming && warming.error ? warming.error : `gave up after ${warming && warming.gaveUpAfter}ms`);
    check('and says it was still loading, not that there is no model',
        warming && warming.warming === true && /still loading/.test(warming.note || ''),
        (warming && warming.note) || String(warming && warming.warming));

    /* Half a minute is what a cold `create()` costs, and a fill used to walk away
     * from it after three seconds — so the first fill after Chrome starts, on the
     * day somebody installs this for its AI, had no AI in it and said nothing
     * about why. The form is finished long before the window opens, so the wait
     * costs nothing but the card staying up. */
    step('a session that is still being built when the fill starts');
    const cold = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel, realSession = nanoSession;
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => {
                await new Promise(r => setTimeout(r, 5000));   // past the window a fill used to allow
                return {
                    clone: async function () {
                        return {...this};
                    },
                    prompt: async (p) => {
                        const ids = [...p.matchAll(/^(\d+) /gm)].map(m => m[1]);
                        return JSON.stringify(Object.fromEntries(ids.map(id => [id, 'COLD-' + id])));
                    },
                    destroy() {
                    }
                };
            }
        };
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 700));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const t0 = Date.now();
        const fill = chrome.tabs.sendMessage(tab.id, {
            kind: 'fill', settings: {seed: 'COLD1', locale: 'en-US', useAI: true, overwrite: true}
        });
        /* What the card says while the session is being built, read from the
         * page rather than inferred: "AI is still answering 0/10" over a model
         * that is only being loaded reads as a model thinking very hard. */
        const readCard = async () => (await chrome.scripting.executeScript({
            target: {tabId: tab.id}, func: () => {
                const hud = document.getElementById('formforge-hud');
                if (!hud) return {};
                return {
                    title: (hud.querySelector('.ff-title') || {}).textContent || '',
                    count: (hud.querySelector('.ff-count') || {}).textContent || '',
                    now: (hud.querySelector('.ff-now') || {}).textContent || ''
                };
            }
        }))[0].result;
        // The form is written first and takes seconds of its own; read once it is past that.
        let card = {};
        for (let i = 0; i < 30; i++) {
            const c = await readCard();
            if (/Starting the AI/i.test(c.title || '')) card = c;
            await new Promise(r => setTimeout(r, 150));
        }
        const res = await fill;
        const ms = Date.now() - t0;
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        return {ms, card, aiUsed: res.aiUsed, via: res.modelVia, firstPass: res.phase && res.phase.firstPass};
        // A page written in milliseconds, so the wait on the card is the model's own.
    }, {files: INJECTED, url: `${origin}/form.html`}).catch(e => ({error: e.message})), 60000, 'cold');

    check('a session five seconds in the building is still used by the fill that started it',
        cold && !cold.error && cold.aiUsed > 0 && cold.via === 'on-device',
        cold && cold.error ? cold.error : `${cold.aiUsed} answered via ${cold.via} in ${cold.ms}ms`);
    check('the card says the model is starting, with the clock the popup shows',
        cold && !cold.error && /Starting the AI/.test((cold.card || {}).title || '')
        && /^\d+s$/.test((cold.card || {}).count || '')
        && /the form is filled/.test((cold.card || {}).now || ''),
        cold && cold.card ? `"${cold.card.title}" ${cold.card.count} — ${cold.card.now}` : '');
    check('and the form itself was finished before the model was even up',
        cold && !cold.error && cold.ms > 4000 && cold.firstPass < cold.ms - 1000,
        cold && !cold.error ? `form in ${cold.firstPass}ms, fill returned at ${cold.ms}ms` : '');

    /* A session dies with the worker, and the worker stops half a minute after
     * the fill that woke it. The page that got one answer went on believing
     * there was a model for the rest of its life: the fill after the worker had
     * gone added no allowance for the session being built in its place, so the
     * card said the AI was starting and the fill ended without it anyway. */
    step('a second fill after the session it used has gone');
    const again2 = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel, realSession = nanoSession;
        let slow = false;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => {
                if (slow) await new Promise(r => setTimeout(r, 4000));
                return {
                    clone: async function () {
                        return {...this};
                    },
                    prompt: async (p) => {
                        const ids = [...p.matchAll(/^(\d+) /gm)].map(m => m[1]);
                        return JSON.stringify(Object.fromEntries(ids.map(id => [id, 'AGAIN-' + id])));
                    },
                    destroy() {
                    }
                };
            }
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 600));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const settings = {seed: 'AGAIN1', locale: 'en-US', useAI: true, overwrite: true};
        const first = await chrome.tabs.sendMessage(tab.id, {kind: 'fill', settings});
        // The worker stops; the session goes with it, and building another is slow.
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        slow = true;
        const second = await chrome.tabs.sendMessage(tab.id,
            {kind: 'fill', settings: {...settings, seed: 'AGAIN2'}});
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        return {firstUsed: first.aiUsed, secondUsed: second.aiUsed, secondVia: second.modelVia};
    }, {files: INJECTED, url: `${origin}/form.html`}).catch(e => ({error: e.message})), 60000, 'again');

    check('the fill that found a session uses it',
        again2 && !again2.error && again2.firstUsed > 0,
        again2 && again2.error ? again2.error : `${again2.firstUsed} answered`);
    check('and the one after it waits for the session built in its place',
        again2 && !again2.error && again2.secondUsed > 0 && again2.secondVia === 'on-device',
        again2 && !again2.error ? `${again2.secondUsed} answered via ${again2.secondVia}` : '');

    /* A window that long must not make the page unusable. A fill waiting on the
     * model has finished writing; the next press should start, not be told the
     * page is busy for half a minute. */
    step('pressing Fill again while the model is still coming up');
    const cutShort = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel, realSession = nanoSession;
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        self.LanguageModel = {
            availability: async () => 'available',
            create: () => new Promise(() => {           // never comes up
            })
        };
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 700));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const settings = {seed: 'CUT1', locale: 'en-US', useAI: true, overwrite: true};
        const tFirst = Date.now();
        let firstMs = 0;
        const first = chrome.tabs.sendMessage(tab.id, {kind: 'fill', settings})
            .then(r => {
                firstMs = Date.now() - tFirst;
                return r;
            });
        await new Promise(r => setTimeout(r, 1500));
        const t0 = Date.now();
        /* The press is what is under test, not what it does with the model: left
         * asking, it would sit out the same twenty-five seconds and put half a
         * minute on this suite. */
        const second = await chrome.tabs.sendMessage(tab.id,
            {kind: 'fill', settings: {...settings, seed: 'CUT2', useAI: false}});
        const ms = Date.now() - t0;
        const firstRes = await first;
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        return {
            ms,
            firstMs,
            secondOk: !!(second && second.ok),
            secondCount: second && second.count,
            firstOk: !!(firstRes && firstRes.ok)
        };
    }, {files: INJECTED, url: `${origin}/form.html`}).catch(e => ({error: e.message})), 60000, 'cut short');

    check('the second press fills the form instead of being told the page is busy',
        cutShort && !cutShort.error && cutShort.secondOk && cutShort.secondCount > 0,
        cutShort && cutShort.error ? cutShort.error : `ok=${cutShort && cutShort.secondOk}, ${cutShort && cutShort.secondCount} field(s)`);
    /* The one that was waiting lets go at once rather than sitting out the rest
     * of its window, and still answers with the form it had already written. */
    check('and the fill it interrupted lets go at once, with the form it had written',
        cutShort && !cutShort.error && cutShort.firstOk && cutShort.firstMs < 4000,
        cutShort && !cutShort.error
            ? `the first fill returned after ${cutShort.firstMs}ms of a 45s window`
            : '');

    /* The same field, whichever way it is filled. A whole-form fill asks the
     * model about a box whose rule is a weak one — a description, a comment —
     * and takes the better answer. The shortcut asked only when no rule matched
     * at all, so the same box came out of the model on one path and out of the
     * rules on the other, which is a difference nobody could have predicted
     * from the outside. */
    step('one field on its own, and the same field with its form');
    const oneVsAll = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel, realSession = nanoSession;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                prompt: async (p) => {
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => m[1]);
                    return JSON.stringify(Object.fromEntries(ids.map(id => [id, 'From the model'])));
                },
                destroy() {
                }
            })
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 600));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const settings = {seed: 'ONEALL', locale: 'en-US', useAI: true, overwrite: true};

        const whole = await chrome.tabs.sendMessage(tab.id, {kind: 'fill', settings});
        await chrome.scripting.executeScript({
            target: {tabId: tab.id}, func: () => {
                const el = document.getElementById('prereq');
                el.value = '';
                el.focus();
            }
        });
        const one = await chrome.tabs.sendMessage(tab.id,
            {kind: 'fill-one', settings: {...settings, seed: 'ONEALL2'}, focusFirst: true});
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        return {
            wholeSource: ((whole.filled || [])[0] || {}).source,
            oneSource: ((one.filled || [])[0] || {}).source,
            oneValue: ((one.filled || [])[0] || {}).value
        };
    }, {files: INJECTED, url: `${origin}/limit-form.html`}).catch(e => ({error: e.message})), 60000, 'one vs all');

    check('a whole-form fill lets the model better a weak rule',
        oneVsAll && !oneVsAll.error && oneVsAll.wholeSource === 'ai',
        oneVsAll && oneVsAll.error ? oneVsAll.error : `source ${oneVsAll.wholeSource}`);
    check('and the shortcut for one field asks the same question of it',
        oneVsAll && !oneVsAll.error && oneVsAll.oneSource === 'ai' && /From the model/.test(oneVsAll.oneValue || ''),
        oneVsAll && !oneVsAll.error ? `source ${oneVsAll.oneSource}, "${oneVsAll.oneValue}"` : '');

    /* Downloaded is not running, and the pill said "model ready" over a session
     * that did not exist yet. */
    step('what the popup says about the model');
    const pill = await (async () => {
        const read = async () => {
            const page = await ctx.newPage();
            await page.goto(`chrome-extension://${id}/src/popup.html`);
            await page.waitForTimeout(900);
            const text = await page.evaluate(() => (document.getElementById('statusText') || {}).textContent || '');
            await page.close();
            return text.trim();
        };
        await worker.evaluate(() => {
            self.LanguageModel = {
                availability: async () => 'available', create: () => new Promise(() => {
                })
            };
            nanoSession = null;
            nanoPending = null;
            nanoBuilding = false;
        });
        const cold = await read();
        await worker.evaluate(() => {
            nanoSession = {
                prompt: async () => '{}', destroy() {
                }
            };
        });
        const warm = await read();
        return {cold, warm};
    })().catch(e => ({error: e.message}));

    check('the pill says the model is starting rather than ready while it is still coming up',
        pill && !pill.error && /starting/i.test(pill.cold) && /ready/i.test(pill.warm),
        pill && pill.error ? pill.error : `cold "${pill.cold}", warm "${pill.warm}"`);

    /* The first `create()` after a reload is where the browser brings a
     * multi-gigabyte model into memory — twenty-eight seconds, measured on a cold
     * one. The fill used to wait out most of that so its first run could have
     * model values, which is the wrong way round: somebody who has just installed
     * this presses Fill once, and a form that sits there for twenty seconds is an
     * uninstall, not a better postcode. So the first fill is fast and comes from
     * the rules, the session finishes coming up in the background, and the fill
     * after it — seconds later — has the model. */
    step('a cold model does not hold up the first fill');
    const firstFill = await withTimeout(worker.evaluate(async ({files, url, cold}) => {
        const real = self.LanguageModel, realSession = nanoSession;
        let built = false;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => {
                if (!built) {
                    await new Promise(r => setTimeout(r, cold));
                    built = true;
                }
                return {
                    clone: async function () {
                        return {...this};
                    },
                    prompt: async (p) => {
                        await new Promise(r => setTimeout(r, 200));
                        const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                        return JSON.stringify({values: ids.map(id => ({id, value: 'Modellwert ' + id}))});
                    },
                    destroy() {
                    }
                };
            }
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 600));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const t0 = Date.now();
        const res = await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill',
            settings: {locale: 'de-DE', useAI: true, overwrite: true}
        });
        await chrome.tabs.remove(tab.id);
        const first = {
            ms: Date.now() - t0, blocked: (res.phase || {}).model, count: res.count, aiUsed: res.aiUsed,
            empty: (res.filled || []).filter(f => !String(f.value || '').length).length
        };
        // The session finishes coming up while nobody waits; the next fill has it.
        await new Promise(r => setTimeout(r, cold));
        const tab2 = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 600));
        await chrome.scripting.executeScript({target: {tabId: tab2.id, allFrames: true}, files});
        const res2 = await chrome.tabs.sendMessage(tab2.id, {
            kind: 'fill', settings: {locale: 'de-DE', useAI: true, overwrite: true}
        });
        await chrome.tabs.remove(tab2.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        return {first, second: {aiUsed: res2.aiUsed, via: res2.modelVia}};
    }, {files: INJECTED, url: fixtureUrl, cold: 6000}).catch(e => ({error: e.message})), 90000, 'first-fill');

    /* The reported case, to the millisecond: "Model patience: 15 seconds", a
     * model that comes up and then takes eleven seconds to answer, then 1.7s for
     * the revealed field — the reported pair was 5.4 and 9.6, which summed to
     * fifteen exactly and so lost the race by a millisecond. It answered — 8 of 8,
     * on the record in the Debug tab — and every field still got a fallback,
     * because one deadline covered both bringing the model up and getting an
     * answer out of it. The patience is the answer's; what the session costs is
     * its own small grace, and a session slower than that grace is the case
     * above, where nobody waits for it at all. */
    step('patience is for an answer, not for loading the model');
    const patience = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel, realSession = nanoSession;
        let built = false, asked = false;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => {
                if (!built) {
                    await new Promise(r => setTimeout(r, 2000));      // up inside the session's grace
                    built = true;
                }
                return {
                    clone: async function () {
                        return {...this};
                    },
                    prompt: async (p) => {
                        const first = !asked;
                        asked = true;
                        await new Promise(r => setTimeout(r, first ? 11000 : 1668));
                        const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                        return JSON.stringify({values: ids.map(id => ({id, value: 'Modellwert ' + id}))});
                    },
                    destroy() {
                    }
                };
            }
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 600));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const res = await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill', settings: {
                locale: 'de-DE', useAI: true, overwrite: true, modelTimeout: 15
            }
        });
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        return {
            aiUsed: res.aiUsed, asked: res.unresolvedCount, timedOut: !!res.modelTimedOut, phase: res.phase,
            fallbacks: (res.filled || []).filter(f => String(f.source).startsWith('fallback')).length
        };
    }, {files: INJECTED, url: fixtureUrl}).catch(e => ({error: e.message})), 60000, 'patience');

    check('a model that loads slowly and then answers is not called too slow',
        patience && !patience.error && patience.timedOut === false
        && patience.aiUsed > 0 && patience.aiUsed === patience.asked,
        patience && patience.error ? patience.error
            : `${patience.aiUsed} of ${patience.asked} asked, timedOut=${patience.timedOut}`);
    check('and none of its fields end up on a fallback',
        patience && !patience.error && patience.fallbacks === 0,
        patience && !patience.error ? `${patience.fallbacks} fallback(s)` : '');
    /* Patience is for the fill, not for each request inside it. Giving every
     * call the full budget turned a model answering in nine seconds into a
     * twenty-eight second fill — twice the number the setting says — for the
     * sake of two fields that appeared part-way through. And the later call must
     * not be *started* when there is no time to finish it: five seconds were
     * burned on a request needing nine, which bought nothing at all. */
    step('patience is for the fill, not for each request in it');
    const uniformly = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel, realSession = nanoSession;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                prompt: async (p) => {
                    await new Promise(r => setTimeout(r, 9600));       // slow every time
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                    return JSON.stringify({values: ids.map(id => ({id, value: 'Modellwert ' + id}))});
                },
                destroy() {
                }
            })
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 600));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const res = await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill', settings: {
                locale: 'de-DE', useAI: true, overwrite: true, modelTimeout: 15
            }
        });
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        return {phase: res.phase, aiUsed: res.aiUsed, notes: res.notes || []};
    }, {files: INJECTED, url: fixtureUrl}).catch(e => ({error: e.message})), 60000, 'uniformly');

    check('a later pass does not get a second full budget',
        uniformly && !uniformly.error
        && (uniformly.phase.modelLate || 0) < 15000 * 0.6,
        uniformly && uniformly.error ? uniformly.error
            : `late pass had ${uniformly.phase.modelLate || 0}ms of a 15s setting`);
    /* Twice the patience in the worst case, and only when a field appears
     * part-way through a fill on a model that is slow every time. */
    check('so the worst case is bounded at twice the patience',
        uniformly && !uniformly.error && uniformly.phase.total < 15000 * 2 + 8000,
        uniformly && !uniformly.error
            ? `${uniformly.phase.total}ms (model ${uniformly.phase.model}ms, late ${uniformly.phase.modelLate || 0}ms)` : '');

    /* The model is asked and not waited for. A fill that stops dead until the
     * answer arrives costs the answer's latency on top of its own; one that
     * writes what the rules already know while the request is in flight pays
     * only for whatever the model still owes when the form runs out of fields.
     * The stand-in here takes two and a half seconds — longer than a warm Nano,
     * shorter than this fixture takes to fill — so a fill that blocks shows up
     * as time in the phase it blocked in. */
    step('the form fills while the model is still thinking');
    const overlapped = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel, realSession = nanoSession;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                prompt: async (p) => {
                    await new Promise(r => setTimeout(r, 2500));
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                    return JSON.stringify({values: ids.map(id => ({id, value: 'Modellwert ' + id}))});
                },
                destroy() {
                }
            })
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 600));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const res = await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill', settings: {locale: 'de-DE', useAI: true, overwrite: true}
        });
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        return {
            phase: res.phase, aiUsed: res.aiUsed, count: res.count, asked: res.unresolvedCount,
            // The fields of the first request; a field revealed later is a separate question.
            fallbacks: (res.filled || []).filter(f => String(f.source).startsWith('fallback')
                && !/appeared mid-fill/.test(f.why || '')).map(f => `${f.label}: ${f.why}`)
        };
    }, {files: INJECTED, url: fixtureUrl}).catch(e => ({error: e.message})), 60000, 'overlap');

    check('the fill starts writing before the model answers',
        overlapped && !overlapped.error && overlapped.phase.model < 1200,
        overlapped && overlapped.error ? overlapped.error
            : `blocked ${overlapped.phase.model}ms of a 2500ms answer`);
    /* Every answer, not a number of them: this stub answers everything it is
       asked, so any shortfall is one the fill dropped on the floor. A count was
       the assertion once, and it only measured how many fields were being asked
       about — which went down, rightly, when bools and blind lists stopped
       being asked at all. */
    /* Not a count. A fill asks more than once — the form, then whatever an upload
       or a switch revealed — so "every answer" stopped meaning "every field
       asked" the moment the denominator started counting both. What this one is
       about is the overlap: an answer to the first request must not be dropped
       just because the fill got on with the form while waiting for it, and that
       is visible on the field itself. */
    check('and no field of the first request ends up on a filler value',
        overlapped && !overlapped.error && overlapped.aiUsed > 0 && overlapped.fallbacks.length === 0,
        overlapped && !overlapped.error
            ? `${overlapped.aiUsed} from the model, ${overlapped.fallbacks.length} fallback(s): ${overlapped.fallbacks.join(' | ')}`
            : '');

    check('a model still coming up does not hold the first fill open',
        firstFill && !firstFill.error && firstFill.first.blocked < 3600,
        firstFill && firstFill.error ? firstFill.error
            : `blocked ${firstFill.first.blocked}ms of a 6s cold start, ${firstFill.first.ms}ms in all`);
    check('and that fill still leaves nothing empty',
        firstFill && !firstFill.error && firstFill.first.count > 20 && firstFill.first.empty === 0,
        firstFill && !firstFill.error
            ? `${firstFill.first.count} filled, ${firstFill.first.empty} empty, ${firstFill.first.aiUsed} from the model` : '');
    check('and the fill after it has the model, without anyone having waited',
        firstFill && !firstFill.error && firstFill.second.aiUsed > 3 && firstFill.second.via === 'on-device',
        firstFill && !firstFill.error
            ? `${firstFill.second.aiUsed} from the model via ${firstFill.second.via}` : '');

    /* The toolbar icon is the one thing on screen whichever tab is in front and
     * whether or not the popup is open, so a fill started with the keyboard and
     * then left alone has this and nothing else. The frames are drawn in the
     * worker; the failure mode worth catching is that they are all identical,
     * which looks exactly like a still icon. */
    step('the toolbar icon while a fill runs');
    const spin = await withTimeout(worker.evaluate(async () => {
        const frames = spinnerFrames();
        const digest = (f) => Array.from(f.data.filter((_, i) => i % 97 === 0)).join(',');
        const distinct = new Set(frames.map(digest)).size;
        /* The light moving across the mark. Measured as how bright the brightest
         * part of each frame's left half is, which tracks the band as it enters
         * and leaves — counting lit pixels would not, because the mark itself is
         * opaque in every frame and swamps it. */
        const ink = frames.map(f => {
            /* The left margin of the mark: inside the rounded square but clear of
             * the white bars, which start about a fifth of the way in and are 255 in
             * every frame — sampling across them measured nothing at all. */
            let sum = 0, n = 0;
            for (let y = 6; y < 26; y++) {
                for (let x = 2; x < 6; x++) {
                    const i = (y * f.width + x) * 4;
                    if (f.data[i + 3] > 200) {
                        sum += f.data[i + 1];
                        n++;
                    }
                }
            }
            return n ? Math.round(sum / n) : 0;
        });
        const tab = (await chrome.tabs.query({}))[0];
        startSpin(tab.id);
        const ran = !!spinTimer;
        await new Promise(r => setTimeout(r, 250));
        const moved = spinFrame > 1;
        stopSpin(tab.id);
        /* Every frame must fill the same area: an icon whose outline changes reads
         * as a different icon each time rather than as one icon working. */
        const area = frames.map(f => {
            let n = 0;
            for (let i = 3; i < f.data.length; i += 4) if (f.data[i] > 200) n++;
            return n;
        });
        const opaque = area.filter(a => Math.abs(a - area[0]) < area[0] * 0.02).length;
        return {
            frames: frames.length, distinct, ran, moved, stopped: !spinTimer, opaque,
            minInk: Math.min(...ink), maxInk: Math.max(...ink)
        };
    }).catch(e => ({error: e.message})), 15000, 'spin');

    check('the toolbar icon has frames that differ',
        spin && !spin.error && spin.frames >= 8 && spin.distinct === spin.frames,
        spin && spin.error ? spin.error : `${spin.distinct} distinct of ${spin.frames}`);
    /* The motion has to survive being sixteen pixels wide. A spinner replacing
     * the icon was tried first: the arc was invisible for most of its cycle, so
     * the icon appeared to blink out, and nothing on the toolbar said FormForge
     * while it ran. The silhouette stays; the light moves. */
    check('and light that visibly crosses the mark',
        spin && !spin.error && spin.maxInk - spin.minInk > 40,
        spin && !spin.error ? `brightness ${spin.minInk}–${spin.maxInk}` : '');
    check('and the mark keeps its shape in every frame',
        spin && !spin.error && spin.opaque === spin.frames,
        spin && !spin.error ? `${spin.opaque} of ${spin.frames} frames keep the silhouette` : '');
    check('it runs while the fill does, and stops after',
        spin && spin.ran && spin.moved && spin.stopped,
        spin ? `ran=${spin.ran} moved=${spin.moved} stopped=${spin.stopped}` : '');

    /* Batches share nothing — each runs on its own clone — so waiting for one
     * before starting the next simply multiplied the wait. A form with
     * thirty-six unresolved fields is three batches, and three times a
     * multi-second round trip was most of a thirteen-second fill. */
    step('asking about more fields than fit in one batch');
    const batched = await withTimeout(worker.evaluate(async () => {
        const real = self.LanguageModel, realSession = nanoSession;
        const PER_CALL = 600;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                prompt: async (p) => {
                    await new Promise(r => setTimeout(r, PER_CALL));
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                    return JSON.stringify({values: ids.map(id => ({id, value: 'V' + id}))});
                },
                destroy() {
                }
            })
        };
        nanoSession = null;
        const fields = Array.from({length: 36}, (_, i) => ({id: i, label: 'Feld ' + i, type: 'text'}));
        const t0 = Date.now();
        const r = await generate({persona: {fullName: 'X'}, pageTitle: 'p', context: {}, examples: [], fields});
        const ms = Date.now() - t0;
        self.LanguageModel = real;
        nanoSession = realSession;
        return {
            ms, perCall: PER_CALL, batches: r.debug.batches.length,
            answered: Object.keys(r.values).length
        };
    }).catch(e => ({error: e.message})), 30000, 'batched');

    check('every field is answered however many batches it takes',
        batched && !batched.error && batched.batches >= 3 && batched.answered === 36,
        batched && batched.error ? batched.error : `${batched.answered} of 36 in ${batched.batches} batches`);
    check('and the batches run together, not one after another',
        batched && !batched.error && batched.ms < batched.perCall * 2,
        batched && !batched.error
            ? `${batched.ms}ms for ${batched.batches} × ${batched.perCall}ms` : '');

    /* The toolbar has to come back. `setIcon({ tabId })` throws — it does not
     * fall back to the manifest icon — and a relative `path` cannot be fetched
     * from a worker, which has no document to resolve it against. Either one on
     * its own left the toolbar stuck on an animation frame for the rest of the
     * session, and neither could be seen: setIcon has no getter, so the only
     * way to ask is to look at chrome.runtime.lastError. */
    step('putting the toolbar icon back');
    const restore = await withTimeout(worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({});
        const tell = (details) => new Promise(r => {
            try {
                chrome.action.setIcon(details, () => r(chrome.runtime.lastError
                    ? 'error: ' + chrome.runtime.lastError.message : 'ok'));
            } catch (e) {
                r('threw: ' + e.message);
            }
        });
        startSpin(tab.id);
        await new Promise(r => setTimeout(r, 150));
        stopSpin(tab.id);
        return {
            real: await tell({
                tabId: tab.id, path: {
                    16: '/icons/icon16.png',
                    48: '/icons/icon48.png', 128: '/icons/icon128.png'
                }
            }),
            relative: await tell({tabId: tab.id, path: {16: 'icons/icon16.png'}}),
            bare: await tell({tabId: tab.id})
        };
    }).catch(e => ({error: e.message})), 15000, 'restore');

    check('the icon FormForge restores to is one Chrome accepts',
        restore && restore.real === 'ok', (restore && (restore.real || restore.error)) || '');
    /* Kept as checks rather than comments: if a future Chrome starts accepting
     * either of these, the workaround above can go — and this will say so. */
    check('a relative icon path still cannot be fetched from a worker',
        restore && /error|threw/.test(restore.relative), restore && restore.relative);
    check('and setIcon with no icon at all still refuses',
        restore && /error|threw/.test(restore.bare), restore && restore.bare);

    /* The fill reports its own progress, and that is the only signal every entry
     * point shares. Hanging the animation off `send()` meant it ran for the
     * shortcut and the context menu but not for the popup's own Fill button,
     * which goes straight to the tab. */
    step('the toolbar icon from any entry point');
    const anyEntry = await withTimeout(worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({});
        stopSpin(tab.id);
        const before = !!spinTimer;
        await chrome.runtime.sendMessage({kind: 'fill-progress', step: {stage: 'fill', text: 'Filling the form'}})
            .catch(() => {
            });
        await new Promise(r => setTimeout(r, 150));
        return {before, spinning: !!spinTimer};
    }).catch(e => ({error: e.message})), 15000, 'entry');
    /* Sent from the worker there is no sender.tab, so this only proves the
     * handler exists and is harmless; the tab-sent case is covered by the
     * fill above, which left the icon restored. */
    check('progress from a page is what drives the toolbar, not one entry point',
        anyEntry && !anyEntry.error && anyEntry.before === false,
        (anyEntry && anyEntry.error) || 'listener present');

    /* Nothing FormForge writes should land in Chrome's own error list for the
     * extension. A `console.warn` from a content script puts a red Errors button
     * on the card in chrome://extensions, where a tester finds it and reasonably
     * concludes the extension is broken — and most of what was written there was
     * not a fault in FormForge at all: a panel an application will not close, a
     * model this machine does not have. Those are notes about the page and they
     * go in the Debug tab. */
    step('keeping the extension\'s own error list clean');
    const quiet = await withTimeout((async () => {
        const noisy = [];
        const watch = (m) => {
            if (m.type() === 'warning' || m.type() === 'error') noisy.push(m.type() + ': ' + m.text());
        };
        const tab = await ctx.newPage();
        tab.on('console', watch);
        tab.on('pageerror', e => noisy.push('pageerror: ' + e.message));
        await tab.goto(fixtureUrl);
        await tab.waitForTimeout(400);
        const res = await worker.evaluate(async ({files, url}) => {
            const [t] = (await chrome.tabs.query({})).filter(x => x.url === url);
            await chrome.scripting.executeScript({target: {tabId: t.id, allFrames: true}, files});
            return await chrome.tabs.sendMessage(t.id, {
                kind: 'fill', settings: {
                    locale: 'de-DE', useAI: false, overwrite: true
                }
            });
        }, {files: INJECTED, url: fixtureUrl});
        await tab.waitForTimeout(300);
        await tab.close();
        return {noisy, notes: res.notes || [], leftOpen: res.leftOpen || []};
    })().catch(e => ({error: e.message})), 40000, 'quiet');

    check('a fill writes nothing to the console',
        quiet && !quiet.error && quiet.noisy.length === 0,
        (quiet && quiet.error) || (quiet && quiet.noisy.slice(0, 2).join(' | ')) || 'silent');
    check('and the extension itself has recorded nothing',
        swErrors.length === 0, swErrors.join(' | '));

    /* A page may forbid inline styles and scripts outright. Chrome exempts what a
     * content script injects from the page's policy, and the indicator depends on
     * that: unstyled, it is an unreadable block of text over the form. */
    step('filling a page with a strict Content-Security-Policy');
    const strict = await withTimeout((async () => {
        const tab = await ctx.newPage();
        const blocked = [];
        tab.on('console', m => {
            if (/Content Security Policy/i.test(m.text())) blocked.push(m.text().slice(0, 120));
        });
        const cspUrl = `${origin}/csp.html`;
        await tab.goto(cspUrl, {waitUntil: 'domcontentloaded'});
        const res = await worker.evaluate(async ({files, url}) => {
            const [t] = (await chrome.tabs.query({})).filter(x => x.url === url);
            await chrome.scripting.executeScript({target: {tabId: t.id}, files});
            return await chrome.tabs.sendMessage(t.id, {
                kind: 'fill', settings: {locale: 'en-US', useAI: false, overwrite: true}
            });
        }, {files: INJECTED, url: cspUrl});
        const hud = await tab.evaluate(() => {
            const el = document.getElementById('formforge-hud');
            const cs = el && getComputedStyle(el);
            return {up: !!el, position: cs && cs.position, z: cs && cs.zIndex};
        });
        await tab.close();
        return {count: res.count, blocked, hud};
    })().catch(e => ({error: e.message})), 40000, 'csp');

    check('a strict policy does not stop the fill',
        strict && !strict.error && strict.count > 0 && strict.blocked.length === 0,
        (strict && strict.error) || (strict && `${strict.count} fields, ${strict.blocked.length} blocked`));
    check('and the indicator is still styled there',
        strict && !strict.error && strict.hud.up && strict.hud.position === 'fixed',
        strict && !strict.error ? JSON.stringify(strict.hud) : '');

    /* A prompt nobody is waiting for any more must stop. The fill gives up on its
     * own budget, but the request kept generating in the worker, and the one
     * on-device session stayed busy for as long as it did — so the next fill
     * queued behind an answer already thrown away. That is what "it hangs" was.
     * https://developer.chrome.com/docs/ai/prompt-api — prompt() takes a signal. */
    const aborted = await withTimeout(worker.evaluate(async () => {
        const real = self.LanguageModel, realSession = nanoSession;
        let sawSignal = false;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                // Never answers on its own; only the caller's signal can end it.
                prompt: (p, opts) => new Promise((resolve, reject) => {
                    sawSignal = !!(opts && opts.signal);
                    if (!opts || !opts.signal) return;
                    opts.signal.addEventListener('abort',
                        () => reject(new DOMException('aborted', 'AbortError')));
                }),
                destroy() {
                }
            })
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const t0 = Date.now();
        const res = await generate({
            persona: {fullName: 'W', company: 'C'}, pageTitle: 'w', context: {}, examples: [],
            budgetMs: 600, fields: [{id: 0, label: 'Notes', type: 'text'}]
        });
        const ms = Date.now() - t0;
        self.LanguageModel = real;
        nanoSession = realSession;
        return {ms, sawSignal, batch: ((res.debug || {}).batches || [])[0] || null};
    }).catch(e => ({error: e.message})), 20000, 'abort');

    check('a prompt past its deadline is aborted, not left running',
        aborted && !aborted.error && aborted.sawSignal && aborted.ms < 3000,
        aborted && aborted.error ? aborted.error : `signal passed: ${aborted && aborted.sawSignal}, ended after ${aborted && aborted.ms}ms`);
    check('and the Debug tab says the request was cut short',
        aborted && !aborted.error && /abort/i.test((aborted.batch || {}).error || ''),
        JSON.stringify((aborted && aborted.batch) || null).slice(0, 120));

    /* Not checked here, and deliberately so. The batches of one request answer one
     * after another — measured on a real form, three finished at 6.6s, 11.9s and
     * 17.6s — so each is sent to the tab as it lands and the fill writes it then,
     * rather than every field waiting for the last batch. Four attempts at a
     * regression check for it were all vacuous: holding a batch open long enough
     * to observe the difference pushes the request past its own budget, and a
     * request that timed out leaves nothing to wait for in either shape, so both
     * write their first outstanding field immediately. A check that cannot fail is
     * worse than none; `phase.firstLate` in the saved report is where this is
     * visible on a real fill. */

    /* A fill can ask more than once: the form's own fields, then whatever an
     * upload or a switch revealed. Each request comes back with its own record,
     * and keeping only the last one left the Debug tab showing the second prompt
     * with no trace of the first. The counts went the other way — aiUsed added
     * up the answers from every request while the denominator stayed at the
     * first one's, so a real fill read "Answered 14 of 10 field(s)". */
    const twice = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel, realSession = nanoSession;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                prompt: async (p) => {
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                    return JSON.stringify({values: ids.map(id => ({id, value: 'Wert ' + id}))});
                },
                destroy() {
                }
            })
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 600));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const res = await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill', settings: {locale: 'de-DE', useAI: true, overwrite: true}
        });
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        const batches = ((res.modelDebug || {}).batches) || [];
        return {
            asked: res.unresolvedCount, aiUsed: res.aiUsed,
            inPrompts: batches.reduce((n, b) => n + (b.asked || 0), 0),
            batches: batches.length,
            late: (res.filled || []).filter(f => /appeared mid-fill/.test(f.why || '')).length
        };
    }, {files: INJECTED, url: fixtureUrl}).catch(e => ({error: e.message})), 60000, 'twice');

    check('the Debug tab keeps a prompt for every field the model was asked about',
        twice && !twice.error && twice.late > 0 && twice.inPrompts === twice.asked,
        twice && twice.error ? twice.error
            : `${twice.inPrompts} field(s) across ${twice.batches} prompt(s), ${twice.asked} asked`);
    check('and the answers are counted against everything that was asked',
        twice && !twice.error && twice.aiUsed <= twice.asked,
        twice && !twice.error ? `answered ${twice.aiUsed} of ${twice.asked}` : '');

    /* What the model is worth asking about. Every bool and every component-library
     * list used to go into the batch, and the answers were thrown away at the
     * other end: a bool has two values and the seed picks one, and a list asked
     * without its options can only be invented — "Standard" came back for a
     * Yes/No radio group, "Office" for a list holding "Branch", and the filler
     * discarded both and picked a valid option itself. Seven bools and two blind
     * lists filled a batch of twelve on one real form. */
    const asked = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel, realSession = nanoSession;
        const prompts = [];
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                prompt: async (p) => {
                    prompts.push(p);
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                    return JSON.stringify({values: ids.map(id => ({id, value: 'Wert ' + id}))});
                },
                destroy() {
                }
            })
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 600));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill', settings: {locale: 'de-DE', useAI: true, overwrite: true}
        });
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        // Only the field lines: "<id> <type> \"<label>\" ..."
        const lines = prompts.join('\n').split('\n').filter(l => /^\d+ \S/.test(l));
        return {
            lines,
            bools: lines.filter(l => /^\d+ (bool|checkbox)\b/.test(l)),
            listsWithout: lines.filter(l => /^\d+ (inline-choice|radio-group)\b/.test(l) && !/one of:/.test(l)),
            listsWith: lines.filter(l => /^\d+ (inline-choice|radio-group)\b/.test(l) && /one of:/.test(l))
        };
    }, {files: INJECTED, url: fixtureUrl}).catch(e => ({error: e.message})), 60000, 'asked');

    check('the model is not asked to choose between true and false',
        asked && !asked.error && asked.bools.length === 0,
        asked && asked.error ? asked.error : asked.bools.join(' | ') || 'none asked');
    check('and a list it is asked about comes with its options',
        asked && !asked.error && asked.listsWithout.length === 0 && asked.lines.length > 0,
        asked && asked.error ? asked.error
            : `${asked.listsWith.length} with options, ${asked.listsWithout.length} blind`);

    /* "No fillable fields found on this page" is an ending, and every ending has
     * to stop the toolbar icon. Only the "filled N fields" path was saying so,
     * so a fill from the popup that found nothing left the icon animating for
     * its whole 90-second watchdog — which is exactly what a fill still running
     * looks like. The shortcut path hid it: send() turns the icon off in a
     * finally, and the popup does not go through send(). */
    const nothing = await withTimeout((async () => {
        const tab = await ctx.newPage();
        await tab.goto(emptyUrl);
        const res = await worker.evaluate(async ({files, title}) => {
            const [t] = await chrome.tabs.query({title});
            working(t.id, true);                       // as any fill leaves it while it runs
            await chrome.scripting.executeScript({target: {tabId: t.id, allFrames: true}, files});
            const r = await chrome.tabs.sendMessage(t.id, {
                kind: 'fill', settings: {locale: 'en-US', useAI: false, overwrite: true}
            });
            // The done signal reaches the worker as a message; give it a moment to land.
            for (let i = 0; i < 40 && spinTimer; i++) await new Promise(x => setTimeout(x, 50));
            return {count: r.count, spinning: !!spinTimer, tab: spinTab};
        }, {files: INJECTED, title: 'Nothing to fill'});
        await tab.close();
        return res;
    })().catch(e => ({error: e.message})), 30000, 'nothing-to-fill');


    check('a page with nothing to fill still reports a finished fill',
        nothing && !nothing.error && nothing.count === 0,
        nothing && nothing.error ? nothing.error : `count=${nothing && nothing.count}`);
    check('and the toolbar icon stops animating',
        nothing && !nothing.error && nothing.spinning === false && nothing.tab == null,
        nothing && !nothing.error ? `spinning=${nothing.spinning}, tab=${nothing.tab}` : '');

    /* The model is told which language to answer in, and told it outright. It
     * used to be left to infer one from the labels, which is the wrong thing to
     * read it off: a German application is very often labelled in English, so a
     * tester who picked DE got German from every rule — the city, the prose, the
     * postcode — and English sentences from the model in the same form. */
    step('the language is stated, not inferred');
    const languages = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel;
        const realSession = nanoSession;
        const seen = [];
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                prompt: async (p) => {
                    seen.push(p);
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                    return JSON.stringify({values: ids.map(id => ({id, value: 'Wert ' + id}))});
                },
                destroy() {
                }
            })
        };
        const asked = {};
        for (const locale of ['de-DE', 'en-US']) {
            nanoSession = null;
            nanoPending = null;
            nanoBuilding = false;
            seen.length = 0;
            const tab = await chrome.tabs.create({url, active: false});
            await new Promise(r => setTimeout(r, 500));
            await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
            await chrome.tabs.sendMessage(tab.id, {
                kind: 'fill', settings: {seed: 'LANG1', locale, useAI: true, overwrite: true}
            });
            await chrome.tabs.remove(tab.id);
            asked[locale] = seen.slice();
        }
        self.LanguageModel = real;
        nanoSession = realSession;
        return asked;
    }, {files: INJECTED, url: `${origin}/manyfields.html`}).catch(e => ({error: e.message})), 60000, 'languages');
    /* Once per batch, and once only: the instruction is worth its characters,
     * a second copy of it is not. */
    const namesIt = (prompts, language) => (prompts || []).length > 0 && prompts.every(p =>
        new RegExp(`Answer all \\d+ fields? in ${language}, one each:`).test(p)
        && (p.match(new RegExp(`\\b${language}\\b`, 'g')) || []).length === 1);
    check('a German fill asks the model for German, on a page labelled in English',
        namesIt(languages['de-DE'], 'German'),
        languages.error || ((languages['de-DE'] || [''])[0].match(/Answer all[^\n]*/) || ['(never said)'])[0]);
    check('and an English one asks for English, and never for German',
        namesIt(languages['en-US'], 'English') && !(languages['en-US'] || []).some(p => /German/.test(p)),
        ((languages['en-US'] || [''])[0].match(/Answer all[^\n]*/) || ['(never said)'])[0]);

    /* One page is several frames, and the filler runs in all of them. A broadcast
     * to the tab brings back whichever frame answered first, so the hidden 0x0
     * frame a tag manager drops on a page can answer "cleared 0 fields" over a
     * form that just lost four values. Every frame is asked by id now, and the
     * frames with work are the ones that answer. */
    step('a hidden frame does not answer for the page');
    const framed = await ctx.newPage();
    await framed.goto(`${origin}/framed.html`);
    await framed.waitForTimeout(400);
    const twoFrames = await withTimeout(worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.includes('framed.html'));
        const seen = await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, func: () => 1});
        const filled = await self.askPage(tab.id, {
            kind: 'fill',
            settings: {seed: 'FRAME1', locale: 'en-US', useAI: false, overwrite: true, emailDomain: 'example.com'}
        });
        // What a broadcast would have been choosing between.
        const each = await Promise.all(seen.map(f => chrome.tabs.sendMessage(tab.id, {kind: 'scan'}, {frameId: f.frameId})
            .then(r => (r && r.count) || 0).catch(() => -1)));
        const cleared = await self.askPage(tab.id, {kind: 'clear'});
        return {frames: seen.length, each, filled: filled && filled.count, cleared: cleared && cleared.count};
    }).catch(e => ({error: e.message})), 40000, 'framed');

    check('the fixture really has a second frame', (twoFrames.frames || 0) >= 2,
        twoFrames.error || `frames=${twoFrames.frames}`);
    check('and the empty one answers too, so a broadcast has a rival',
        (twoFrames.each || []).includes(0) && (twoFrames.each || []).some(n => n > 0),
        `per frame: ${(twoFrames.each || []).join(', ')}`);
    check('the form beside a hidden frame is filled', (twoFrames.filled || 0) >= 3, `filled=${twoFrames.filled}`);
    check('and clearing it reports the form, not the empty frame',
        twoFrames.cleared > 0 && twoFrames.cleared === twoFrames.filled,
        `cleared=${twoFrames.cleared} filled=${twoFrames.filled}`);
    check('the form really is empty again', (await framed.inputValue('#fe')) === '');

    /* Each frame gets its own answers. The stub answers the top form quickly and
     * the framed one slowly, which is the order that showed the bug: the frame's
     * fill was woken by the top form's batch, wrote those values into its own
     * fields under the same numbers, and ignored its own batch as already done. */
    step('two frames asking the model at once');
    const twoForms = await ctx.newPage();
    await twoForms.goto(`${origin}/twoforms.html`);
    await twoForms.waitForTimeout(400);
    const crossed = await withTimeout(worker.evaluate(async () => {
        const real = self.LanguageModel;
        const realSession = nanoSession;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                prompt: async (p) => {
                    await new Promise(r => setTimeout(r, /Delta/.test(p) ? 1500 : 300));
                    // The type is on the line only when it is not "text".
                    const rows = [...p.matchAll(/^(\d+) (?:\S+ )?"([^"]+)"/gm)];
                    return JSON.stringify(Object.fromEntries(rows.map(m => [m[1], 'Model:' + m[2]])));
                },
                destroy() {
                }
            })
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.includes('twoforms.html'));
        const res = await self.askPage(tab.id, {
            kind: 'fill', settings: {seed: 'FRAMES2', locale: 'en-US', useAI: true, overwrite: true}
        });
        const held = await chrome.scripting.executeScript({
            target: {tabId: tab.id, allFrames: true},
            func: () => [...document.querySelectorAll('input')].map(i => `${i.labels[0].textContent}=${i.value}`)
        });
        self.LanguageModel = real;
        nanoSession = realSession;
        const kept = await chrome.storage.local.get({fillHistory: [], fillLog: []});
        return {
            count: res && res.count, aiUsed: res && res.aiUsed, frames: held.map(f => f.result),
            batches: res && res.modelDebug && res.modelDebug.batches ? res.modelDebug.batches.length : null,
            records: kept.fillHistory.filter(h => /twoforms/.test(h.url || '')).length,
            logged: kept.fillLog.filter(s => /twoforms/.test(s.url || '')).length,
            recordCount: (kept.fillHistory.filter(h => /twoforms/.test(h.url || '')).pop() || {}).count
        };
    }).catch(e => ({error: e.message})), 40000, 'twoforms');
    const own = (rows) => (rows || []).every(r => {
        const [label, value] = r.split('=');
        return value === 'Model:' + label;
    });
    check('both frames are filled from the model', crossed.count === 6 && crossed.aiUsed === 6,
        crossed.error || `count=${crossed.count} aiUsed=${crossed.aiUsed}`);
    check('and each frame holds its own answers, not the other frame\'s',
        (crossed.frames || []).length === 2 && crossed.frames.every(own),
        (crossed.frames || []).map(f => f.join(', ')).join(' | '));
    /* One record per request. The worker kept a single "last exchange" and both
     * requests pushed their batches into whichever was created last, so each
     * frame's Debug tab showed two prompts for its three fields. */
    check('and each frame\'s debug record holds only its own request',
        crossed.batches === 1, `batches=${crossed.batches}`);
    /* One record per fill, for the tab. Each frame used to write its own with a
     * read-modify-write, so two frames finishing together lost one — and what
     * survived described one of the forms on the page rather than the page. */
    check('a fill across two frames is remembered once, for the whole page',
        crossed.records === 1 && crossed.logged === 1 && crossed.recordCount === 6,
        `${crossed.records} record(s), ${crossed.logged} logged, ${crossed.recordCount} fields in it`);
    await twoForms.close();
    await framed.close();

    /* A list the page spells out in full is a list we can choose from. Asking the
     * model which of "01…12" to use is asking it to read the markup back to us,
     * and it costs a slot in a batch and a share of the deadline: on a six-field
     * credit-card form, four went to the model for answers the page already had.
     * Only a choice the persona settles — a country, a salutation — is worth a
     * question. */
    step('closed lists are chosen from, not asked about');
    const card = await withTimeout(worker.evaluate(async ({files, url}) => {
        const prompts = [];
        const real = self.LanguageModel;
        const realSession = nanoSession;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                prompt: async (p) => {
                    prompts.push(p);
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                    return JSON.stringify({values: ids.map(id => ({id, value: 'Asked ' + id}))});
                },
                destroy() {
                }
            })
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 600));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const res = await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill', settings: {seed: 'CARD01', locale: 'en-US', useAI: true, overwrite: true}
        });
        const held = await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: () => ['ct', 'cm', 'cy', 'ch', 'cn'].map(k => document.getElementById(k).value)
        });
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        const lines = prompts.join('\n').split('\n').filter(l => /^\d+ \S/.test(l));
        return {lines, asked: res && res.aiUsed, held: held[0].result};
    }, {files: INJECTED, url: `${origin}/cardform.html`}).catch(e => ({error: e.message})), 40000, 'card');

    const [type, month, year, holder, number] = card.held || [];
    check('no closed list reaches the model', card.lines && !card.lines.some(l => /one of:/.test(l)),
        card.error || (card.lines || []).filter(l => /one of:/.test(l)).join(' | ') || `${(card.lines || []).length} field(s) asked`);
    check('but the field no rule answers still does', (card.lines || []).some(l => /Billing reference/i.test(l)),
        (card.lines || []).join(' | ').slice(0, 120));
    check('the lists are filled all the same', !!type && !!month && !!year,
        `type=${type} month=${month} year=${year}`);
    check('and the brand matches the card number the rules generated',
        type === 'Visa' && /^4111/.test(number || ''), `${type} for ${String(number).slice(0, 6)}…`);
    check('the name on the card is the persona, not a model answer',
        !!holder && !/^Asked /.test(holder), holder);

    /* The fill does not wait for the model, and the model is not cut off before it
     * has finished. Both halves are measured here on one form of thirty fields:
     * three batches that one session answers one after another, sixteen and a
     * half seconds of work in all.
     *
     * The form has to be complete long before any of that — every field carries a
     * rule's answer or the filler's from the first pass — and every one of the
     * thirty has to end up with the model's answer, because each batch replaces
     * what it finds when it lands. The old ceiling was twelve seconds whatever the
     * form, so the third batch was aborted on every fill and its ten fields kept
     * their filler values: twenty of thirty, for ever, with no way to tell from
     * the outside that anything had been thrown away. */
    step('a model slower than the form does not cost the form anything');
    const slow = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel;
        const realSession = nanoSession;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                prompt: async (p) => {
                    await new Promise(r => setTimeout(r, 5500));      // three of these is 16.5s
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                    return JSON.stringify({values: ids.map(id => ({id, value: 'Vom Modell ' + id}))});
                },
                destroy() {
                }
            })
        };
        nanoSession = null;
        nanoPending = null;
        nanoBuilding = false;
        const tab = await chrome.tabs.create({url, active: false});
        await new Promise(r => setTimeout(r, 600));
        await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
        const fill = chrome.tabs.sendMessage(tab.id, {
            kind: 'fill', settings: {seed: 'SLOW01', locale: 'en-US', useAI: true, overwrite: true}
        });
        // One second in: the model cannot have answered yet, and the form must already be done.
        await new Promise(r => setTimeout(r, 1000));
        const early = await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: () => {
                const all = [...document.querySelectorAll('input')];
                const hud = document.getElementById('formforge-hud');
                return {
                    empty: all.filter(i => !i.value).length, total: all.length,
                    fromModel: all.filter(i => /^Vom Modell/.test(i.value)).length,
                    hud: hud ? hud.innerText.replace(/\s+/g, ' ').trim() : ''
                };
            }
        });
        const res = await fill;
        const held = await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: () => [...document.querySelectorAll('input')].filter(i => /^Vom Modell/.test(i.value)).length
        });
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        return {
            early: early[0].result, endedWithModel: held[0].result,
            aiUsed: res.aiUsed, upgraded: res.upgraded, asked: res.unresolvedCount,
            timedOut: !!res.modelTimedOut, via: res.modelVia, phase: res.phase
        };
    }, {files: INJECTED, url: `${origin}/manyfields.html`}).catch(e => ({error: e.message})), 90000, 'slow');

    check('the form is complete a second in, with nothing from the model yet',
        slow.early && slow.early.empty === 0 && slow.early.fromModel === 0,
        slow.error || `${slow.early && slow.early.empty} empty of ${slow.early && slow.early.total}, ` +
        `${slow.early && slow.early.fromModel} from the model`);
    check('and the first pass is measured in milliseconds, not seconds',
        slow.phase && slow.phase.firstPass < 2000, `firstPass=${slow.phase && slow.phase.firstPass}ms`);
    /* Sixteen seconds of a card reading "Improving the form — 12/40" is a fill
     * that looks stuck at twelve of forty. It says who is working, and counts
     * what that work produces: answers received, out of answers owed. */
    check('and the card says the AI is working and the form is not what is waiting',
        /\bAI\b/.test(slow.early.hud) && /form is filled/.test(slow.early.hud) && /\b\d+\/30\b/.test(slow.early.hud),
        slow.early.hud || '(no card)');
    check('every batch lands, however long the model takes',
        slow.endedWithModel === 30 && slow.aiUsed === 30 && !slow.timedOut,
        `${slow.endedWithModel}/30 on the page, aiUsed=${slow.aiUsed}, timedOut=${slow.timedOut}`);
    check('and each one is reported as an upgrade over what was already written',
        slow.upgraded === 30, `upgraded=${slow.upgraded}`);
    check('a streamed batch says which backend answered it', slow.via === 'on-device', `via=${slow.via}`);

    /* A hosted provider is asked the way the on-device model is: the batches go
     * out together and each one is written the moment it lands. They used to run
     * one after another and reach the fill only when the last had answered — so
     * with a key configured, a form of thirty fields sat on filler values for
     * the sum of the round trips, not the longest. The stub answers the first
     * batch quickly and the second slowly; a second in, the first must be on
     * the page and the second must not. */
    step('hosted batches land one by one');
    const hosted = await withTimeout(worker.evaluate(async ({files, url}) => {
        const KEYS = ['provider', 'apiKey', 'model', 'backend'];
        const realFetch = self.fetch;
        const saved = await chrome.storage.local.get(KEYS);
        await chrome.storage.local.set({provider: 'anthropic', apiKey: 'k', backend: 'remote-only', model: ''});
        let calls = 0;
        self.fetch = async (url, o) => {
            // The toolbar icon is fetched through here too when the fill ends; only the provider counts.
            if (!/api\.anthropic\.com/.test(String(url))) return realFetch(url, o);
            calls++;
            const prompt = JSON.parse(o.body).messages[0].content;
            const ids = [...prompt.matchAll(/^(\d+) /gm)].map(m => +m[1]);
            await new Promise(r => setTimeout(r, ids.includes(0) ? 200 : 2500));
            return new Response(JSON.stringify({
                content: [{type: 'text', text: JSON.stringify({values: ids.map(id => ({id, value: 'Remote ' + id}))})}]
            }), {status: 200});
        };
        try {
            const tab = await chrome.tabs.create({url, active: false});
            await new Promise(r => setTimeout(r, 600));
            await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files});
            const count = () => chrome.scripting.executeScript({
                target: {tabId: tab.id},
                func: () => [...document.querySelectorAll('input')].filter(i => /^Remote /.test(i.value)).length
            }).then(r => r[0].result);
            const fill = chrome.tabs.sendMessage(tab.id, {
                kind: 'fill', settings: {seed: 'REMOTE1', locale: 'en-US', useAI: true, overwrite: true}
            });
            await new Promise(r => setTimeout(r, 1200));
            const early = await count();
            const res = await fill;
            const late = await count();
            await chrome.tabs.remove(tab.id);
            return {calls, early, late, aiUsed: res.aiUsed, via: res.modelVia, requestMs: res.modelRequestMs};
        } finally {
            self.fetch = realFetch;
            await chrome.storage.local.remove(KEYS);
            await chrome.storage.local.set(saved);
        }
    }, {files: INJECTED, url: `${origin}/manyfields.html`}).catch(e => ({error: e.message})), 40000, 'hosted');
    /* The slower of the two answers at 2.5s. Sequential, the request could not
     * come in under five; the bound is halfway between, not a stopwatch. */
    check('hosted batches go out together', hosted.calls === 2 && hosted.requestMs < 3800,
        hosted.error || `${hosted.calls} calls, request ${hosted.requestMs}ms`);
    // A hosted batch is twice an on-device one: the round trip, not the decode, is the cost.
    check('and the first batch is on the page before the second has answered',
        hosted.early === 16, `${hosted.early} of 30 from the model a second in`);
    check('and every hosted answer lands, attributed to the provider',
        hosted.late === 30 && hosted.aiUsed === 30 && hosted.via === 'anthropic',
        `${hosted.late}/30 on the page, aiUsed=${hosted.aiUsed}, via=${hosted.via}`);

    /* Ten fills are kept, not one. "It worked a minute ago" is a comparison, and
     * the run before the broken one is the half that makes it — a report that can
     * only describe whichever fill somebody saved it after answers nothing. */
    step('keeping the last ten fills in full');
    const history = await withTimeout((async () => {
        const older = Array.from({length: 10}, (_, i) => ({
            at: Date.now() - (20 - i) * 60000, title: `older ${i}`, url: 'about:blank',
            count: 1, filled: [{label: 'x', value: 'y', source: 'rule'}], phase: {total: 1}, persona: {seed: 'OLD'}
        }));
        const pop2 = await ctx.newPage();
        await pop2.goto(`chrome-extension://${id}/src/popup.html`);
        await pop2.waitForTimeout(500);
        await pop2.evaluate(async (seed) => {
            await new Promise(r => chrome.storage.local.set({fillHistory: seed}, r));
        }, older);
        await worker.evaluate(async () => {
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find(t => t.url && t.url.includes('form.html'));
            await self.askPage(tab.id, {
                kind: 'fill', settings: {seed: 'HIST01', locale: 'en-US', useAI: false, overwrite: true}
            });
        });
        const seen = await pop2.evaluate(async () => {
            /* The record is written after the fill has answered — it is not
             * something a fill should block on — so wait for it rather than
             * assuming it has landed. */
            const read = () => new Promise(r => chrome.storage.local.get({fillHistory: [], fillLog: []}, r));
            let got = await read();
            for (let i = 0; i < 40 && (got.fillHistory.slice(-1)[0] || {}).persona.seed !== 'HIST01'; i++) {
                await new Promise(r => setTimeout(r, 100));
                got = await read();
            }
            document.getElementById('tabDebug').click();
            await new Promise(r => setTimeout(r, 300));
            const trail = document.getElementById('debugBody').innerText;
            const pins = document.querySelectorAll('#debugBody [data-fill]');
            // The pin row itself does not change, so read the heading of the fill on show.
            const head = () => (document.querySelector('#debugBody .dbg-h') || {}).textContent || '';
            const shown = head();
            if (pins.length > 1) pins[pins.length - 1].click();      // rendered newest first, so this is the oldest
            await new Promise(r => setTimeout(r, 250));
            return {
                kept: got.fillHistory.length,
                oldestGone: !got.fillHistory.some(h => h.title === 'older 0'),
                newestKept: got.fillHistory[got.fillHistory.length - 1].persona.seed,
                pins: pins.length,
                shown,
                trail,
                afterClick: head()
            };
        });
        await pop2.close();
        /* The report is a page of its own now, so it is read there: the text it
         * offers for download, and the cards it renders, both describe every kept
         * fill. A popup could only ever save; a tab can be read first. */
        const rep = await ctx.newPage();
        await rep.goto(`chrome-extension://${id}/src/report.html`);
        await rep.waitForTimeout(600);
        const report = await rep.evaluate(async () => {
            const got = await new Promise(r => chrome.storage.local.get({fillHistory: [], fillLog: []}, r));
            const text = globalThis.FormForgeReport.text(got.fillHistory, got.fillLog, {
                version: 't',
                ua: 't',
                locale: 't',
                model: 't'
            });
            return {
                blocks: (text.match(/^======== /gm) || []).length,
                cards: document.querySelectorAll('details.fill').length,
                downloads: !!document.getElementById('download'),
                title: document.title
            };
        });
        await rep.close();
        return Object.assign(seen, {report});
    })().catch(e => ({error: e.message})), 40000, 'history');

    check('ten fills are kept, and the eleventh pushes the oldest out',
        history.kept === 10 && history.oldestGone && history.newestKept === 'HIST01',
        history.error || `kept=${history.kept} newest=${history.newestKept}`);
    check('the report describes every one of them, not just the last',
        history.report && history.report.blocks === 10 && history.report.cards === 10,
        `${history.report && history.report.blocks} fill block(s), ${history.report && history.report.cards} card(s)`);
    check('and the report page offers the text as a download, without the downloads permission',
        history.report && history.report.downloads && !mf.permissions.includes('downloads'),
        `download button: ${history.report && history.report.downloads}, permissions: ${mf.permissions.join(', ')}`);
    check('and the Debug tab can be pointed at any of them',
        history.pins === 10 && history.shown === 'Last fill' && history.afterClick === 'Fill 1 of 10',
        `${history.pins} pin(s): "${history.shown}" → "${history.afterClick}"`);
    /* One fill is an anecdote. How often a fill finishes with nothing left, what
     * one usually costs and how much of it the model answered are questions
     * about the run — counted here, on this machine, from records holding no
     * values at all. */
    check('and says what the run of fills has looked like',
        /ACROSS THE LAST \d+ FILLS/i.test(history.trail || '')
        && /Finished with nothing left\s+\d+ of \d+/i.test(history.trail || '')
        && /Typical fill/i.test(history.trail || ''),
        (String(history.trail || '').match(/ACROSS THE LAST[\s\S]{0,120}/i) || ['(no trend section)'])[0].replace(/\s+/g, ' '));

    check('no service worker errors', swErrors.length === 0, swErrors.join(' | '));

    server.close();
}

clearTimeout(watchdog);
await ctx.close();
console.log(`\n${failures === 0 ? 'Extension loads and works.' : failures + ' check(s) failed.'}`);
process.exit(failures === 0 ? 0 : 1);
