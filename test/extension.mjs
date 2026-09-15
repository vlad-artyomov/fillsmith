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
const watchdog = setTimeout(() => {
    console.log('\nWATCHDOG: suite exceeded 160s, aborting');
    process.exit(1);
}, 160000);
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
    ...Object.values(mf.icons)
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
check('the setup check covers both halves of the configured backend',
    /kind === 'setup-check'/.test(bgSrc) && /checkSetup/.test(popupSrc));
check('the popup never hands the API key to the page', /apiKey, \.\.\.forPage/.test(popupSrc));
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
        '/primevue-form.html': readFileSync(join(root, 'test/primevue-form.html'))
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

    // Drive it the way the popup does: a message to the tab.
    step('sending fill message');
    const res = await withTimeout(worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.includes('form.html'));
        return await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill',
            settings: {seed: 'EXT001', locale: 'de-DE', useAI: true, overwrite: true, emailDomain: 'example.com'}
        });
    }).catch(e => ({ok: false, error: e.message})), 30000, 'fill');

    check('content script answered the fill message', res && res.ok === true, JSON.stringify(res?.error || ''));
    check('fields were filled through the extension path', (res?.count || 0) >= 15, `count=${res?.count}`);

    const email = await page.inputValue('#em');
    const phone = await page.inputValue('#ph');
    check('email filled via extension', /@example\.com$/.test(email), email);
    // Two locales only — English and German, matching what the app ships.
    check('German locale applied end-to-end', /^49\d{9}$/.test(phone), phone);

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
    check('two locales, English and German', surface.locales.join('/') === 'English/Deutsch',
        surface.locales.join('/'));
    check('nothing is pinned by default, so each fill is fresh data',
        surface.pinnedByDefault === '', surface.pinnedByDefault);

    /* Pinning repeats a fill exactly — the reproduce-a-bug case. */
    const pinned = await pop.evaluate(async () => {
        const seed = document.getElementById('seed');
        const set = (v) => {
            seed.value = v;
            seed.dispatchEvent(new Event('input', {bubbles: true}));
            return new Promise(r => setTimeout(r, 100));
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
        return document.getElementById('debugBody').innerText;
    });
    /* To scale, and in words. A list of raw counts under the variable names they
     * are stored as made a nine-millisecond contribution and a nine-second one
     * look alike — which is how the model came to be blamed for a sixteen-second
     * fill it had no part in. */
    check('debug shows where the time went, phase by phase',
        /WHERE THE [\d.]+m?s WENT/i.test(dbg) && /Reading the form/.test(dbg)
        && /Filling/.test(dbg),
        (dbg.match(/WHERE THE [^\n]*/i) || ['(no timing section)'])[0]);
    check('debug explains the model', /MODEL[\s\S]*(Asked for|Not consulted)/.test(dbg));
    check('debug names the rule behind a value', /matched \/.+\/[a-z]*/.test(dbg));
    check('debug says why a fallback was used', /no rule matched/.test(dbg));

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
        const fill = await new Promise(r => chrome.storage.local.get(['lastFill'], v => r(v.lastFill)));
        fill.modelTimedOut = true;
        fill.modelAsked = true;
        fill.modelDebug = {
            at: Date.now() - 60000, asked: 1, waitedMs: 1500,
            note: 'gave up after 1500ms of a 1500ms budget', batches: [], pending: true
        };
        await new Promise(r => chrome.storage.local.set({lastFill: fill}, r));
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

    /* The parser is the thing under test and it lives in the service worker, so
     * test it there — no page needed. */
    step('reconciling a reply whose ids do not match the request');
    const reconciled = await withTimeout(worker.evaluate(() => ({
        shifted: parseValues('{"values":[{"id":1,"value":"Training"}]}', [{id: 0}]),
        correct: parseValues('{"values":[{"id":0,"value":"Training"}]}', [{id: 0}]),
        allWrong: parseValues('{"values":[{"id":1,"value":"A"},{"id":2,"value":"B"}]}', [{id: 4}, {id: 7}]),
        noIds: parseValues('{"values":[{"value":"A"},{"value":"B"}]}', [{id: 4}, {id: 7}])
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

    /* A field with no rule should get a model answer, not a fallback — including
     * one that only appears part-way through the fill, which earlier went
     * straight to the fallback because the model is a batched round trip. One
     * batch per pass costs what the first one did. */
    step('filling with a model that answers');
    const answered = await withTimeout(worker.evaluate(async ({files, url}) => {
        const stub = (msg, sender, respond) => {
            if (msg.kind !== 'generate') return;
            const values = {};
            for (const f of msg.payload.fields) values[f.id] = 'MODEL-' + f.id;
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
        await chrome.tabs.remove(tab.id);
        chrome.runtime.onMessage.removeListener(stub);
        const weak = (res.filled || []).find(f => /notiz|comment|description|information/i.test(f.label));
        return {
            aiUsed: res.aiUsed,
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
        let seen = '';
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => ({
                clone: async function () {
                    return {...this};
                },
                // As many answers as the example shows, in the order the fields were listed.
                prompt: async (p) => {
                    seen = p;
                    const shown = (p.split('\n').pop().match(/\{"id":/g) || []).length;
                    const ids = [...p.matchAll(/^(\d+) /gm)].map(m => +m[1]);
                    return JSON.stringify({values: ids.slice(0, shown).map(id => ({id, value: 'Wert ' + id}))});
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
        return {answered: Object.keys(res.values || {}).length, tail: seen.split('\n').pop()};
    }).catch(e => ({error: e.message})), 25000, 'skeleton');

    check('a batch of twelve comes back with twelve values',
        skeleton && !skeleton.error && skeleton.answered === 12,
        skeleton && skeleton.error ? skeleton.error : `${skeleton && skeleton.answered} answered`);
    check('and the example the model is shown holds every id, not just one',
        skeleton && !skeleton.error && (skeleton.tail.match(/\{"id":/g) || []).length === 12,
        skeleton && skeleton.tail ? skeleton.tail.slice(0, 120) : '');

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

    /* The first `create()` after a reload is where the browser brings a
     * multi-gigabyte model into memory. Capping the wait at a flat four seconds
     * made the first fill after every reload modelless, reliably — the caller's
     * own cold budget, which exists for exactly this, was never spent on the
     * thing that needed it. Measured end to end against a model that takes seven
     * seconds to come up: 16 answers and no fallbacks, where the cap gave 1
     * and 13. */
    step('the first fill after a reload');
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
        const res = await chrome.tabs.sendMessage(tab.id, {
            kind: 'fill',
            settings: {locale: 'de-DE', useAI: true, overwrite: true}
        });
        await chrome.tabs.remove(tab.id);
        self.LanguageModel = real;
        nanoSession = realSession;
        return {
            aiUsed: res.aiUsed, warming: !!res.modelWarming, via: res.modelVia,
            fallbacks: (res.filled || []).filter(f => String(f.source).startsWith('fallback')).length
        };
    }, {files: INJECTED, url: fixtureUrl, cold: 6000}).catch(e => ({error: e.message})), 45000, 'first-fill');

    /* The reported case, to the millisecond: "Model patience: 15 seconds", a
     * model that takes six seconds to come up and eleven to answer, then 1.7s
     * for the revealed field — the reported pair was 5.4 and 9.6, which summed
     * to fifteen exactly and so lost the race by a millisecond. It answered — 8 of 8, on the record in the Debug tab — and
     * every field still got a fallback, because one deadline covered both
     * bringing the model up and getting an answer out of it. */
    step('patience is for an answer, not for loading the model');
    const patience = await withTimeout(worker.evaluate(async ({files, url}) => {
        const real = self.LanguageModel, realSession = nanoSession;
        let built = false, asked = false;
        self.LanguageModel = {
            availability: async () => 'available',
            create: async () => {
                if (!built) {
                    await new Promise(r => setTimeout(r, 6000));
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
            aiUsed: res.aiUsed, timedOut: !!res.modelTimedOut, phase: res.phase,
            fallbacks: (res.filled || []).filter(f => String(f.source).startsWith('fallback')).length
        };
    }, {files: INJECTED, url: fixtureUrl}).catch(e => ({error: e.message})), 60000, 'patience');

    check('a model that loads slowly and then answers is not called too slow',
        patience && !patience.error && patience.timedOut === false && patience.aiUsed > 10,
        patience && patience.error ? patience.error
            : `${patience.aiUsed} answers, timedOut=${patience.timedOut}`);
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
        return {phase: res.phase, aiUsed: res.aiUsed, count: res.count};
    }, {files: INJECTED, url: fixtureUrl}).catch(e => ({error: e.message})), 60000, 'overlap');

    check('the fill starts writing before the model answers',
        overlapped && !overlapped.error && overlapped.phase.model < 1200,
        overlapped && overlapped.error ? overlapped.error
            : `blocked ${overlapped.phase.model}ms of a 2500ms answer`);
    check('and still uses every answer when it arrives',
        overlapped && !overlapped.error && overlapped.aiUsed > 10,
        overlapped && !overlapped.error ? `${overlapped.aiUsed} of ${overlapped.count} from the model` : '');

    check('the very first fill uses the model rather than falling back',
        firstFill && !firstFill.error && firstFill.aiUsed > 3 && firstFill.via === 'on-device',
        firstFill && firstFill.error ? firstFill.error
            : `${firstFill.aiUsed} from the model, ${firstFill.fallbacks} fallback(s)`);

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

    check('no service worker errors', swErrors.length === 0, swErrors.join(' | '));

    server.close();
}

clearTimeout(watchdog);
await ctx.close();
console.log(`\n${failures === 0 ? 'Extension loads and works.' : failures + ' check(s) failed.'}`);
process.exit(failures === 0 ? 0 : 1);
