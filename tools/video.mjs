/* Render the promo film, reproducibly: the same frames on every run.
 *
 * The film is tools/video/stage.html stepped one frame at a time. The form in
 * its window is the real fixture with the real extension filling it, so what
 * the film shows is what Fillsmith does — but the filler's clock is the film's
 * (tools/video/film.js), so a fill that takes two seconds can be shown at the
 * pace of the script and still come out the same twice. The words and the
 * timings are in tools/video/script.mjs; this file only records.
 *
 *   node tools/video.mjs                    # docs/video/fillsmith-promo.mp4 and the poster
 *   node tools/video.mjs --stills           # one key frame per scene, docs/video/stills/
 *   node tools/video.mjs --from 4 --to 9    # a test cut of part of it, docs/video/test.mp4
 *   node tools/video.mjs --vertical         # the 1080×1920 cut for Shorts, as well
 *   node tools/video.mjs --draft            # half the pixels, for checking timing quickly
 */
import {chromium} from 'playwright';
import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FPS, SIZE, FILL, EPOCH, DURATION, KEY_FRAMES, POSTER, GIF} from './video/script.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'docs', 'video');
mkdirSync(OUT, {recursive: true});
const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? null : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(name);
const STILLS = flag('--stills');
const DRAFT = flag('--draft');
const FROM = Number(arg('--from') || 0);
const TO = Math.min(DURATION, Number(arg('--to') || DURATION));
const PART = FROM > 0 || TO < DURATION;
/* Drawn at twice the size and reduced, as the store pictures are: text keeps
 * its edges and a slow camera move does not step from pixel to pixel. */
const SS = DRAFT ? 1 : 2;

// -------------------------------------------------------------- the server ----
const files = {
    '/stage.html': 'tools/video/stage.html',
    '/script.js': 'tools/video/script.mjs',
    '/form.html': 'test/demo-form.html',
    '/person.html': 'tools/video/person.html'
};
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg'};
const caps = new Map();       // the popup's panes, captured once
let freeze = Buffer.alloc(0);  // the last frame, for the next scene to dissolve from
const drawMark = readFileSync(join(root, 'src/background.js'), 'utf8').match(/^function drawMark\(g, size\) \{[\s\S]*?^\}/m)[0];
const server = createServer((q, r) => {
    const path = q.url.split('?')[0];
    const send = (body, type) => {
        r.writeHead(200, {'content-type': type, 'cache-control': 'no-store'});
        r.end(body);
    };
    if (files[path]) return send(readFileSync(join(root, files[path])), TYPES[extname(files[path])]);
    if (path === '/mark.js') return send(drawMark, TYPES['.js']);
    if (path === '/freeze.jpg') return send(freeze, TYPES['.jpg']);
    const cap = path.match(/^\/cap\/(.+)\.png$/);
    if (cap && caps.has(cap[1])) return send(caps.get(cap[1]), TYPES['.png']);
    r.writeHead(404);
    r.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------- the browser ----
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ff-film-')), {
    channel: 'chromium', headless: true, viewport: {width: SIZE.w, height: SIZE.h}, deviceScaleFactor: SS,
    colorScheme: 'light', locale: 'en-US',
    env: Object.assign({}, process.env, {LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8'}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox', '--no-first-run',
        '--lang=en-US', '--force-color-profile=srgb', '--hide-scrollbars']
});
const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', {timeout: 15000});
const extId = worker.url().split('/')[2];

/* "Today" in the page's own world as well: the calendar draws the month it
 * thinks it is, and the fill's world has the film's clock already. */
await ctx.addInitScript(({epoch}) => {
    if (!/^\/(form|person)\.html$/.test(location.pathname)) return;
    const Real = Date;
    const at = new Real(epoch).getTime();
    globalThis.Date = class extends Real {
        constructor(...a) {
            if (a.length) super(...a);
            else super(at);
        }

        static now() {
            return at;
        }
    };
}, {epoch: EPOCH});

/* As for the store pictures: a headless browser has no Gemini Nano, so the
 * worker gets a stand-in that answers through the same session, schema and
 * write path, with fixed words. It answers at once; when the answer reaches the
 * page is the film clock's business. */
await worker.evaluate(() => {
    const ANSWERS = {
        'Internal ticket': 'REL-2417',
        'Release notes': 'Moves invoice export to the new queue; rollback is the export.queue flag.'
    };
    const session = {
        inputUsage: 1, inputQuota: 4096,
        async prompt(text, opts) {
            const ids = Object.keys(((opts || {}).responseConstraint || {}).properties || {});
            const labels = {};
            for (const m of String(text).matchAll(/^(\S+)(?: \w+)? "([^"]*)"/gm)) labels[m[1]] = m[2];
            return JSON.stringify(Object.fromEntries(ids.map(id => [id, ANSWERS[labels[id]] || 'Staging rollout'])));
        },
        async clone() {
            return session;
        },
        destroy() {
        }
    };
    self.LanguageModel = {
        async availability() {
            return 'available';
        },
        async create() {
            return session;
        }
    };
    nanoSession = null;
    // Up before the first fill, so every take finds the model ready, as a tester's second fill does.
    return nanoSessionGet({allowDownload: false}).then(() => true);
});

const stage = await ctx.newPage();
await stage.goto(`${origin}/stage.html`);
await stage.waitForFunction(() => !!window.film);

/* Into the window's frame only, the film clock first: the stage's own frame
 * has nothing to fill and must not grow a card of its own. */
const inject = (page) => worker.evaluate(async ({page}) => {
    const [tab] = (await chrome.tabs.query({})).filter(t => (t.url || '').includes('/stage.html'));
    const frames = await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, func: () => location.pathname});
    const frame = frames.find(f => f.result === `/${page}`);
    await chrome.scripting.executeScript({
        target: {tabId: tab.id, frameIds: [frame.frameId]}, injectImmediately: true,
        files: ['tools/video/film.js', ...FILLER_FILES]
    });
    self.__film = {tab: tab.id, frame: frame.frameId, answer: null};
}, {page});

const press = async () => {
    await worker.evaluate((settings) => {
        const f = self.__film;
        f.answer = chrome.tabs.sendMessage(f.tab, {kind: 'fill', settings}, {frameId: f.frame}).catch(e => ({error: String(e)}));
    }, FILL);
    await stage.waitForFunction(() => document.getElementById('app').contentDocument
        .documentElement.getAttribute('data-film-received') >= '1');
};

const takeOn = async (page) => {
    await stage.evaluate((p) => window.film.load(p), page);
    await inject(page);
    await stage.waitForFunction(() => document.getElementById('app').contentDocument
        .documentElement.hasAttribute('data-film-ready'));
};

// ---------------------------------------------------------- the rehearsals ----
/* Each page is filled once, quickly, before anything is filmed: its log is
 * what the script's beats are pinned to. The demo form's fill is also the one
 * the popup is captured after, as a tester would see it. */
const film = await stage.evaluate(() => ({takes: window.film.takes, scenes: window.film.scenes}));
const logs = {};
for (const page of [...new Set(film.takes.map(t => t.page))]) {
    await takeOn(page);
    await press();
    logs[page] = await stage.evaluate(() => window.film.rehearse(7000, 20));
    await stage.evaluate(({page, log}) => window.film.setLog(page, log), {page, log: logs[page]});
    const answer = await worker.evaluate(async ({keep, at}) => {
        const r = await self.__film.answer;
        if (keep && r && r.persona) {
            await remember(r);
            // Recorded at the film's "today", so the Debug tab says the same "ago" on every run.
            const {fillHistory} = await chrome.storage.local.get({fillHistory: []});
            fillHistory[fillHistory.length - 1].at = at;
            await chrome.storage.local.set({fillHistory});
        }
        return r && {count: r.count, aiUsed: r.aiUsed, person: r.persona && r.persona.fullName};
    }, {keep: page === 'form.html', at: new Date(EPOCH).getTime()});
    console.log(`rehearsed ${page}: ${logs[page].length} moments, ${JSON.stringify(answer)}`);
}
if (flag('--log')) {
    writeFileSync(arg('--log'), JSON.stringify(logs, null, 1));
    await ctx.close();
    server.close();
    process.exit(0);
}

// ------------------------------------------------------- the popup's panes ----
/* At three times their size, because the film shows them magnified. */
{
    await worker.evaluate(() => chrome.storage.local.set({debugTab: true}));
    const pop = await ctx.newPage();
    const cdp = await ctx.newCDPSession(pop);
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 360, height: 900, deviceScaleFactor: 3, mobile: false});
    await pop.clock.setFixedTime(new Date(new Date(EPOCH).getTime() + 3000)).catch(() => 0);
    await pop.goto(`chrome-extension://${extId}/src/popup.html`);
    await pop.waitForFunction(() => /ready/.test(document.getElementById('statusText').textContent), null, {timeout: 10000})
        .catch(() => console.log('the popup never said the model was ready'));
    const clip = (sel, pad = 0, full = false) => pop.evaluate(({sel, pad, full}) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return full ? {x: 0, y: r.top - pad, width: 360, height: r.height + pad * 2}
            : {x: r.left - pad, y: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2};
    }, {sel, pad, full});
    const shot = async (name, sel, pad, full) => caps.set(name, await pop.screenshot({type: 'png', clip: await clip(sel, pad, full)}));

    await shot('pill', '#status', 3);
    await pop.click('#tabDebug');
    await pop.waitForSelector('#debugBody .dbg-sec');
    await pop.waitForTimeout(300);
    await shot('debug', '#debugBody .dbg-sec', 0);
    await pop.click('#tabSettings');
    await pop.waitForTimeout(300);
    const row = await pop.evaluate(() => {
        const a = document.querySelector('label[for="seed"]').getBoundingClientRect();
        const b = document.getElementById('seed').parentElement.getBoundingClientRect();
        const x = Math.min(a.left, b.left), y = Math.min(a.top, b.top);
        return {x, y, width: Math.max(a.right, b.right) - x, height: Math.max(a.bottom, b.bottom) - y};
    });
    for (let n = 0; n <= FILL.seed.length; n++) {
        await pop.fill('#seed', FILL.seed.slice(0, n));
        await pop.evaluate(() => document.getElementById('seed').blur());
        await pop.waitForTimeout(60);
        caps.set(`seed-${n}`, await pop.screenshot({type: 'png', clip: row}));
    }
    await pop.fill('#seed', '');
    await pop.close();
    await stage.evaluate((names) => window.film.preload(names), [...caps.keys()]);
}

// ------------------------------------------------------------- the frames ----
/* Before each frame: load the take it belongs to if that is a new one, and
 * press Fill when the script says. */
let current = -1, pressed = false;
async function render(t) {
    const take = await stage.evaluate((t) => window.film.takeOf(t), t);
    if (take >= 0 && take !== current) {
        current = take;
        pressed = false;
        await takeOn(film.takes[take].page);
    }
    if (take >= 0 && !pressed && t >= film.takes[current].fillAt) {
        pressed = true;
        await press();
    }
    return stage.evaluate((t) => window.film.frame(t), t);
}

const shoot = () => stage.screenshot({type: 'jpeg', quality: 95});

if (STILLS) {
    /* One frame per scene, where the scene has said what it came to say. */
    const dir = join(OUT, 'stills');
    mkdirSync(dir, {recursive: true});
    let k = 0;
    for (const s of film.scenes) {
        const end = s.start + KEY_FRAMES[s.id];
        // Walk the scene up to its key frame, so the fill in it is where the film has it.
        for (let f = Math.round(s.start * FPS); f <= Math.round(end * FPS); f += f < Math.round(end * FPS) - 6 ? 6 : 1) {
            const id = await render(f / FPS);
            if (f === Math.round(end * FPS)) {
                const name = `${++k}-${id}.png`;
                writeFileSync(join(dir, name), await stage.screenshot({type: 'png'}));
                console.log(`docs/video/stills/${name}`);
            }
        }
    }
} else {
    const out = PART ? join(OUT, 'test.mp4') : join(OUT, 'fillsmith-promo.mp4');
    const enc = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
        '-vf', `scale=${SIZE.w}:${SIZE.h}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '10', '-tune', 'animation', '-profile:v', 'high',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-r', String(FPS), '-movflags', '+faststart', out], {stdio: ['pipe', 'inherit', 'inherit']});
    const done = new Promise((r, j) => enc.on('close', c => c ? j(new Error(`ffmpeg exited ${c}`)) : r()));
    const first = Math.round(FROM * FPS), last = Math.round(TO * FPS);
    const starts = new Set(film.scenes.map(s => Math.round(s.start * FPS)));
    const t0 = Date.now();
    // A cut that starts mid-scene still has to walk the fill up to its first frame.
    const lead = PART ? Math.round((film.scenes.findLast(s => FROM >= s.start) || film.scenes[0]).start * FPS) : 0;
    const posterAt = PART ? -1 : Math.round(POSTER.at * FPS);
    for (let f = lead; f < last; f++) {
        if (f < first && (f - lead) % 6) continue;
        if (starts.has(f) && f) freeze = await shoot();
        await render(f / FPS);
        if (f < first) continue;
        const jpg = await shoot();
        freeze = jpg;
        if (f === posterAt) {
            spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', '-', '-vf', `scale=${POSTER.w}:${POSTER.h}:flags=lanczos`,
                join(OUT, 'poster.png')], {input: await stage.screenshot({type: 'png'})});
        }
        if (!enc.stdin.write(jpg)) await new Promise(r => enc.stdin.once('drain', r));
        if (f % FPS === 0) process.stdout.write(`\r${(f / FPS).toFixed(0)}s of ${TO.toFixed(0)}s  ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`);
    }
    enc.stdin.end();
    await done;
    console.log(`\n${out.replace(root + '/', '')}`);
    if (!PART) {
        console.log(`docs/video/poster.png  ${POSTER.w}×${POSTER.h}`);
        /* One palette for the whole cut, built from what changes between frames, and
         * only the changed rectangle written per frame: a form that sits still costs nothing. */
        const gif = join(OUT, 'fillsmith-demo.gif');
        spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(GIF.from), '-to', String(GIF.to), '-i', out,
            '-vf', `fps=${GIF.fps},scale=${GIF.width}:-1:flags=lanczos,split[a][b];` +
            '[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
            gif], {stdio: 'inherit'});
        console.log(`docs/video/fillsmith-demo.gif  ${GIF.width}px, ${GIF.fps} fps, ${(readFileSync(gif).length / 1e6).toFixed(1)} MB`);
    }
}

await ctx.close();
server.close();
