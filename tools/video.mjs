/* Render the promo film, reproducibly: the same frames on every run.
 *
 * The film is tools/video/stage.html stepped one frame at a time. The form in
 * its window is the real fixture with the real extension filling it, so what
 * the film shows is what Fillsmith does — but the filler's clock is the film's
 * (tools/video/film.js), so a fill that takes two seconds can be shown at the
 * pace of the script and still come out the same twice. The words and the
 * timings are in tools/video/script.mjs, the music in tools/video/score.mjs;
 * this file only records.
 *
 *   node tools/video.mjs                    # docs/video: the film (1080p and 4K), its poster and the README GIF
 *   node tools/video.mjs --stills           # one key frame per scene, docs/video/stills/
 *   node tools/video.mjs --probe            # a contact sheet: every scene and both sides of every cut
 *   node tools/video.mjs --from 4 --to 9    # a test cut of part of it, docs/video/test.mp4
 *   node tools/video.mjs --music track.mp3  # someone else's music instead of the score; --silent for none
 *   node tools/video.mjs --draft            # half the pixels and no motion blur, for checking timing
 *   node tools/video.mjs --workers 3        # how many browsers render at once
 *   node tools/video.mjs --gif              # only the README GIF again, from the film already rendered
 */
import {chromium} from 'playwright';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FPS, SIZE, FILL, EPOCH, DURATION, KEY_FRAMES, POSTER, GIF, MOTION_BLUR, MUSIC, POPUP_SCALE} from './video/script.mjs';
import {renderScore, wav} from './video/score.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'docs', 'video');
mkdirSync(OUT, {recursive: true});
const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? null : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(name);
const STILLS = flag('--stills');
const PROBE = flag('--probe');
const DRAFT = flag('--draft');
const FROM = Number(arg('--from') || 0);
const TO = Math.min(DURATION, Number(arg('--to') || DURATION));
const PART = FROM > 0 || TO < DURATION;
const WORKERS = PART ? 1 : Number(arg('--workers') || 3);
/* Drawn at twice the size and reduced, as the store pictures are: text keeps
 * its edges, a slow camera move does not step from pixel to pixel, and the
 * frames are already the 4K master YouTube encodes best from. */
const SS = DRAFT ? 1 : 2;
const BLUR = DRAFT ? 1 : MOTION_BLUR.samples;
const TMP = mkdtempSync(join(tmpdir(), 'ff-film-'));
const rel = (p) => p.replace(root + '/', '');
const ffmpeg = (args, opts = {}) => {
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], Object.assign({maxBuffer: 1 << 30}, opts));
    if (r.status) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr}`);
    return r;
};

/* The README's loop, cut from the 4K master where there is one: reduced from
 * four times the pixels, the dark green arrives clean, where the 1080p copy's
 * own compression shows as blotches once a 256-colour palette has had its say.
 * gifski where it is installed — thousands of colours a frame, dithering that
 * holds still between frames — at full quality: its lossy mode smears dark
 * gradients into stripes. ffmpeg's palette otherwise, built from what changes. */
function makeGif() {
    const gif = join(OUT, 'fillsmith-demo.gif');
    const source = [join(OUT, 'fillsmith-promo-4k.mp4'), join(OUT, 'fillsmith-promo.mp4')].find(existsSync);
    const cut = ['-ss', String(GIF.from), '-to', String(GIF.to), '-i', source];
    const has = spawnSync('gifski', ['--version']).status === 0;
    if (has) {
        const dir = join(TMP, 'gif');
        mkdirSync(dir);
        ffmpeg([...cut, '-vf', `fps=${GIF.fps},scale=${GIF.width}:-1:flags=lanczos`, join(dir, 'f%04d.png')]);
        const frames = readdirSync(dir).sort().map(f => join(dir, f));
        const r = spawnSync('gifski', ['--fps', String(GIF.fps), '--width', String(GIF.width), '--quality', '100', '--extra', '-o', gif, ...frames]);
        if (r.status) throw new Error(`gifski: ${r.stderr}`);
    } else {
        ffmpeg([...cut, '-vf', `fps=${GIF.fps},scale=${GIF.width}:-1:flags=lanczos,split[a][b];` +
            '[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle', gif]);
    }
    console.log(`docs/video/fillsmith-demo.gif  ${GIF.width}px, ${GIF.fps} fps, ${(readFileSync(gif).length / 1e6).toFixed(1)} MB` +
        `, from ${rel(source)}${has ? ', gifski' : ''}`);
}

if (flag('--gif')) {
    makeGif();
    rmSync(TMP, {recursive: true, force: true});
    process.exit(0);
}

// -------------------------------------------------------------- the server ----
const files = {
    '/stage.html': 'tools/video/stage.html',
    '/script.js': 'tools/video/script.mjs',
    '/form.html': 'test/demo-form.html',
    '/person.html': 'tools/video/person.html'
};
const TYPES = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.png': 'image/png'};
const caps = new Map();       // the popup's panes, captured once and shared by every browser
const drawMark = readFileSync(join(root, 'src/background.js'), 'utf8').match(/^function drawMark\(g, size\) \{[\s\S]*?^\}/m)[0];
const server = createServer((q, r) => {
    const path = q.url.split('?')[0];
    const send = (body, type) => {
        r.writeHead(200, {'content-type': type, 'cache-control': 'no-store'});
        r.end(body);
    };
    if (files[path]) return send(readFileSync(join(root, files[path])), TYPES[extname(files[path])]);
    if (path === '/mark.js') return send(drawMark, TYPES['.js']);
    const cap = path.match(/^\/cap\/(.+)\.png$/);
    if (cap && caps.has(cap[1])) return send(caps.get(cap[1]), TYPES['.png']);
    r.writeHead(404);
    r.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------ the recorders ----
/* One browser with the extension, the stage, and the fill it is in the middle
 * of. Several run at once, each on whole takes: a take starts from a freshly
 * loaded form, so where one browser stops and the next starts changes nothing. */
class Recorder {
    static async open() {
        const rec = new Recorder();
        rec.ctx = await chromium.launchPersistentContext(mkdtempSync(join(TMP, 'profile-')), {
            channel: 'chromium', headless: true, viewport: {width: SIZE.w, height: SIZE.h}, deviceScaleFactor: SS,
            colorScheme: 'light', locale: 'en-US',
            env: Object.assign({}, process.env, {LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8'}),
            args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox', '--no-first-run',
                '--lang=en-US', '--force-color-profile=srgb', '--hide-scrollbars']
        });
        rec.worker = rec.ctx.serviceWorkers()[0] || await rec.ctx.waitForEvent('serviceworker', {timeout: 15000});
        rec.extId = rec.worker.url().split('/')[2];

        /* "Today" in the page's own world as well: the calendar draws the month it
         * thinks it is, and the fill's world has the film's clock already. */
        await rec.ctx.addInitScript(({epoch}) => {
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
         * write path, with fixed words. It answers at once; when the answer reaches
         * the page is the film clock's business. */
        await rec.worker.evaluate(() => {
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

        rec.stage = await rec.ctx.newPage();
        await rec.stage.goto(`${origin}/stage.html`);
        await rec.stage.waitForFunction(() => !!window.film);
        rec.current = -1;
        rec.pressed = false;
        rec.lastF = -1;
        return rec;
    }

    /* Into the window's frame only, the film clock first: the stage's own frame
     * has nothing to fill and must not grow a card of its own. */
    inject(page) {
        return this.worker.evaluate(async ({page}) => {
            const [tab] = (await chrome.tabs.query({})).filter(t => (t.url || '').includes('/stage.html'));
            const frames = await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, func: () => location.pathname});
            const frame = frames.find(f => f.result === `/${page}`);
            await chrome.scripting.executeScript({
                target: {tabId: tab.id, frameIds: [frame.frameId]}, injectImmediately: true,
                files: ['tools/video/film.js', ...FILLER_FILES]
            });
            self.__film = {tab: tab.id, frame: frame.frameId, answer: null};
        }, {page});
    }

    async press() {
        await this.worker.evaluate((settings) => {
            const f = self.__film;
            f.answer = chrome.tabs.sendMessage(f.tab, {kind: 'fill', settings}, {frameId: f.frame}).catch(e => ({error: String(e)}));
        }, FILL);
        await this.stage.waitForFunction(() => document.getElementById('app').contentDocument
            .documentElement.getAttribute('data-film-received') >= '1');
    }

    async takeOn(page) {
        await this.stage.evaluate((p) => window.film.load(p), page);
        await this.inject(page);
        await this.stage.waitForFunction(() => document.getElementById('app').contentDocument
            .documentElement.hasAttribute('data-film-ready'));
    }

    /* Before a frame: load the take it belongs to if that is a new one, and press
     * Fill when the script says. `at` is the frame an exposure at `t` belongs to. */
    async render(t, at = t) {
        const take = await this.stage.evaluate((t) => window.film.takeOf(t), at);
        if (take >= 0 && take !== this.current) {
            this.current = take;
            this.pressed = false;
            await this.takeOn(film.takes[take].page);
        }
        if (take >= 0 && !this.pressed && at >= film.takes[this.current].fillAt) {
            this.pressed = true;
            await this.press();
        }
        return this.stage.evaluate(({t, at}) => window.film.frame(t, at), {t, at});
    }

    // To time t the long way: a take is walked from its start, a frame in six, so its fill is where the film has it.
    async walkTo(t) {
        const f = Math.round(t * FPS);
        const take = await this.stage.evaluate((t) => window.film.takeOf(t), t);
        let from = this.lastF + 1;
        if (take >= 0 && take !== this.current) from = Math.round(film.takes[take].at * FPS);
        for (let g = from; g < f; g += 6) await this.render(g / FPS);
        this.lastF = f;
        return this.render(f / FPS);
    }

    shoot(type = 'jpeg') {
        return this.stage.screenshot(type === 'png' ? {type: 'png'} : {type: 'jpeg', quality: 95});
    }

    close() {
        return this.ctx.close();
    }
}

// The frames a camera move is exposed for: half a frame's time (a 180° shutter), centred on the frame.
const exposure = (t) => {
    const open = MOTION_BLUR.shutter / 360 / FPS;
    return Array.from({length: BLUR}, (_, k) => t - open / 2 + (k + 0.5) / BLUR * open);
};

// The average of a frame's exposures, by ffmpeg, which does it in one pass at full depth.
let blends = 0;
function blend(jpgs) {
    const dir = join(TMP, `blend-${blends++}`);
    mkdirSync(dir);
    const inputs = jpgs.flatMap((j, i) => {
        writeFileSync(join(dir, `${i}.jpg`), j);
        return ['-i', join(dir, `${i}.jpg`)];
    });
    return new Promise((resolve, reject) => {
        const p = spawn('ffmpeg', ['-loglevel', 'error', ...inputs, '-filter_complex', `mix=inputs=${jpgs.length}`,
            '-frames:v', '1', '-q:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-']);
        const chunks = [];
        p.stdout.on('data', c => chunks.push(c));
        p.on('close', code => {
            rmSync(dir, {recursive: true, force: true});
            code ? reject(new Error('blend failed')) : resolve(Buffer.concat(chunks));
        });
    });
}

// ------------------------------------------------------------ the rehearsal ----
/* Each page is filled once, quickly, before anything is filmed: its log is
 * what the script's beats are pinned to. The demo form's fill is also the one
 * the popup is captured after, as a tester would see it. */
const lead = await Recorder.open();
const film = await lead.stage.evaluate(() => ({takes: window.film.takes, scenes: window.film.scenes}));
const logs = {};
for (const page of [...new Set(film.takes.map(t => t.page))]) {
    await lead.takeOn(page);
    await lead.press();
    logs[page] = await lead.stage.evaluate(() => window.film.rehearse(7000, 20));
    await lead.stage.evaluate(({page, log}) => window.film.setLog(page, log), {page, log: logs[page]});
    const answer = await lead.worker.evaluate(async ({keep, at}) => {
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
lead.current = -1;
// Where the sound goes, worked out from the same logs the pictures are timed by.
const cues = await lead.stage.evaluate(() => window.film.cues());
if (flag('--log')) {
    writeFileSync(arg('--log'), JSON.stringify(logs, null, 1));
    await lead.close();
    server.close();
    process.exit(0);
}

// ------------------------------------------------------- the popup's panes ----
/* At POPUP_SCALE times their size, because the film shows them magnified. */
{
    await lead.worker.evaluate(() => chrome.storage.local.set({debugTab: true}));
    const pop = await lead.ctx.newPage();
    const cdp = await lead.ctx.newCDPSession(pop);
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 360, height: 900, deviceScaleFactor: POPUP_SCALE, mobile: false});
    await pop.clock.setFixedTime(new Date(new Date(EPOCH).getTime() + 3000)).catch(() => 0);
    await pop.goto(`chrome-extension://${lead.extId}/src/popup.html`);
    await pop.waitForFunction(() => /ready/.test(document.getElementById('statusText').textContent), null, {timeout: 10000})
        .catch(() => console.log('the popup never said the model was ready'));
    const clip = (sel, pad = 0) => pop.evaluate(({sel, pad}) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return {x: r.left - pad, y: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2};
    }, {sel, pad});
    /* Through the protocol, not Playwright's screenshot: that one draws at the
     * context's own scale and ignores the override, so the panes came out at 2x. */
    const grab = async (box) => Buffer.from((await cdp.send('Page.captureScreenshot',
        {format: 'png', clip: Object.assign({scale: 1}, box)})).data, 'base64');
    const shot = async (name, sel, pad) => caps.set(name, await grab(await clip(sel, pad)));

    /* The pill on its own, everything around it transparent: it stands on the
     * film's green, and a margin of the popup's white around it read as a crooked rim. */
    {
        const rid = await pop.evaluate(() => {
            const st = document.createElement('style');
            st.id = 'film-cutout';
            st.textContent = 'html, body, body *:not(#status):not(#status *) { background: transparent !important; ' +
                'box-shadow: none !important; border-color: transparent !important; color: transparent !important; }';
            document.head.appendChild(st);
            return st.id;
        });
        await cdp.send('Emulation.setDefaultBackgroundColorOverride', {color: {r: 0, g: 0, b: 0, a: 0}});
        caps.set('pill', await grab(await clip('#status', 4)));
        await cdp.send('Emulation.setDefaultBackgroundColorOverride', {});
        await pop.evaluate((id) => document.getElementById(id).remove(), rid);
    }
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
        caps.set(`seed-${n}`, await grab(row));
    }
    await pop.fill('#seed', '');
    await pop.close();
    // A PNG says its own size at bytes 16–23; the stage sizes the cards from it, so the log does too.
    console.log(`popup panes: ${['pill', 'debug', `seed-${FILL.seed.length}`].map(n =>
        `${n} ${caps.get(n).readUInt32BE(16) / POPUP_SCALE}×${caps.get(n).readUInt32BE(20) / POPUP_SCALE}`).join(', ')}`);
    await lead.stage.evaluate((names) => window.film.preload(names), [...caps.keys()]);
}

// --------------------------------------------------------------- the audit ----
/* Before a frame is drawn: every piece of copy, how long it is readable, and
 * how big. Under the reading time or under 44 px is said out loud. */
{
    const rows = await lead.stage.evaluate(() => window.film.audit());
    let bad = 0;
    console.log('\ncopy                                       size   shown  needs');
    for (const r of rows) {
        // Quiet copy is small and long on purpose — a link written out for the record, not to be read off the screen.
        const short = r.shown + 0.01 < r.needs && !r.quiet, small = r.px < 44 && !r.quiet;
        if (short || small) bad++;
        console.log(`${short || small ? '✗' : '✓'} ${r.text.slice(0, 40).padEnd(40)} ${String(r.px).padStart(4)}px ${r.shown.toFixed(1).padStart(5)}s ${r.needs.toFixed(1).padStart(5)}s`);
    }
    console.log(bad ? `${bad} piece(s) of copy too short-lived or too small\n` : 'all copy readable in time\n');
}

// ------------------------------------------------------- stills and probes ----
async function sheet(frames, path, cols = 4) {
    /* Small, labelled, in one picture: what a reviewer, or a model with eyes,
     * reads in a glance. Built in the lead browser at 1x. */
    const page = await lead.ctx.newPage();
    await page.setViewportSize({width: cols * 480 + (cols + 1) * 12, height: 600});
    await page.setContent(`<body style="margin:0;padding:12px;background:#111;font:600 15px system-ui;color:#ddd;
        display:grid;grid-template-columns:repeat(${cols},480px);gap:12px">${frames.map(f => `<figure style="margin:0">
        <img src="data:image/jpeg;base64,${f.jpg.toString('base64')}" style="width:480px;height:270px;display:block">
        <figcaption style="padding:6px 2px 0">${f.label}</figcaption></figure>`).join('')}</body>`);
    await page.waitForTimeout(200);
    writeFileSync(path, await page.screenshot({type: 'png', fullPage: true}));
    await page.close();
    console.log(rel(path));
}

if (STILLS || PROBE) {
    const marks = [];
    for (const s of film.scenes) {
        if (STILLS) marks.push({t: s.start + KEY_FRAMES[s.id], label: s.id});
        if (PROBE) {
            if (s.start) marks.push({t: s.start - 0.1, label: `cut −0.1 s`}, {t: s.start + 0.2, label: `${s.id} +0.2 s`});
            marks.push({t: s.start + 0.6, label: `${s.id} entering`}, {t: s.start + s.dur / 2, label: `${s.id} middle`},
                {t: s.start + s.dur - 0.45, label: `${s.id} settled`});
        }
    }
    marks.sort((a, b) => a.t - b.t);
    const shots = [];
    for (const m of marks) {
        await lead.walkTo(m.t);
        shots.push({t: m.t, label: `${m.t.toFixed(2)} s · ${m.label}`, jpg: await lead.shoot()});
    }
    if (STILLS) {
        const dir = join(OUT, 'stills');
        mkdirSync(dir, {recursive: true});
        shots.forEach((s, i) => {
            const name = `${i + 1}-${marks[i].label}.png`;
            ffmpeg(['-f', 'image2pipe', '-i', '-', join(dir, name)], {input: s.jpg});
            console.log(`docs/video/stills/${name}`);
        });
    } else await sheet(shots, join(OUT, 'probe.png'));
    await lead.close();
    server.close();
    process.exit(0);
}

// -------------------------------------------------------------- the frames ----
const masters = [
    // The copy the repository keeps: as good as the eye can tell, at the size of a file worth keeping.
    {name: '1080', file: PART ? 'test.mp4' : 'fillsmith-promo.mp4', vf: `scale=${SIZE.w}:${SIZE.h}:flags=lanczos:`, crf: 14, preset: 'slow', gop: []},
    /* What YouTube takes: it encodes a 4K upload better at every size, 1080p
     * included, and asks for a closed GOP of half the frame rate and two B-frames. */
    ...(PART || DRAFT ? [] : [{name: '4k', file: 'fillsmith-promo-4k.mp4', vf: 'scale=', crf: 12, preset: 'medium', gop: ['-g', String(FPS / 2), '-bf', '2']}])
];

function encoder(file, m) {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
        '-vf', `${m.vf}out_color_matrix=bt709:out_range=tv,format=yuv420p`,
        '-c:v', 'libx264', '-preset', m.preset, '-crf', String(m.crf), '-tune', 'animation', '-profile:v', 'high',
        ...m.gop, '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-color_range', 'tv', '-r', String(FPS), '-movflags', '+faststart', file], {stdio: ['pipe', 'inherit', 'inherit']});
    p.done = new Promise((r, j) => p.on('close', c => c ? j(new Error(`ffmpeg exited ${c}`)) : r()));
    p.put = async (buf) => {
        if (!p.stdin.write(buf)) await new Promise(r => p.stdin.once('drain', r));
    };
    return p;
}

/* Whole takes per browser, about the same number of frames each. A chunk may
 * start only where a take starts, or where no take runs. */
function plan(n) {
    if (PART) return [{from: FROM, to: TO}];
    const starts = film.scenes.filter((s, i) => i === 0 || s.take !== film.scenes[i - 1].take || s.take < 0).map(s => s.start);
    const cuts = [0];
    for (let k = 1; k < n; k++) {
        const want = DURATION * k / n;
        const best = starts.reduce((a, b) => Math.abs(b - want) < Math.abs(a - want) ? b : a);
        if (best > cuts[cuts.length - 1]) cuts.push(best);
    }
    cuts.push(DURATION);
    return cuts.slice(0, -1).map((from, i) => ({from, to: cuts[i + 1]}));
}

const chunks = plan(WORKERS);
const recorders = [lead];
for (let i = 1; i < chunks.length; i++) {
    const rec = await Recorder.open();
    for (const [page, log] of Object.entries(logs)) await rec.stage.evaluate(({page, log}) => window.film.setLog(page, log), {page, log});
    await rec.stage.evaluate((names) => window.film.preload(names), [...caps.keys()]);
    recorders.push(rec);
}

const t0 = Date.now();
let framesDone = 0, blurred = 0;
const total = Math.round((TO - FROM) * FPS);
const posterAt = PART ? -1 : Math.round(POSTER.at * FPS);
const progress = setInterval(() => process.stdout.write(
    `\r${framesDone}/${total} frames, ${blurred} with motion blur, ${((Date.now() - t0) / 1000).toFixed(0)} s   `), 2000);

async function record(rec, chunk, i) {
    const encs = masters.map(m => encoder(join(TMP, `${m.name}-${i}.mp4`), m));
    const first = Math.round(chunk.from * FPS), last = Math.round(chunk.to * FPS);
    // A test cut that starts mid-scene still walks the fill there from the start of its take.
    if (PART) {
        const s = film.scenes.findLast(x => FROM >= x.start) || film.scenes[0];
        const takeStart = s.take >= 0 ? film.takes[s.take].at : s.start;
        if (first > Math.round(takeStart * FPS)) await rec.walkTo((first - 1) / FPS);
    }
    let before = null;
    for (let f = first; f < last; f++) {
        const times = exposure(f / FPS);
        const head = await rec.render(times[0], f / FPS);
        let jpg = await rec.shoot();
        // Something moved since the last frame: expose this one over the whole shutter.
        if (BLUR > 1 && before !== null && head.sig !== before) {
            const shots = [jpg];
            for (const t of times.slice(1)) {
                await rec.render(t, f / FPS);
                shots.push(await rec.shoot());
            }
            jpg = await blend(shots);
            blurred++;
        }
        before = head.sig;
        if (f === posterAt) {
            ffmpeg(['-f', 'image2pipe', '-i', '-', '-vf', `scale=${POSTER.w}:${POSTER.h}:flags=lanczos`, join(OUT, 'poster.png')], {input: await rec.shoot('png')});
        }
        await Promise.all(encs.map(e => e.put(jpg)));
        framesDone++;
    }
    encs.forEach(e => e.stdin.end());
    await Promise.all(encs.map(e => e.done));
}

await Promise.all(chunks.map((c, i) => record(recorders[i], c, i)));
clearInterval(progress);
console.log(`\n${total} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${blurred} of them blurred`);
await Promise.all(recorders.map(r => r.close()));

// One file per master: the chunks end to end, each began on a keyframe of its own.
for (const m of masters) {
    const list = join(TMP, `${m.name}.txt`);
    writeFileSync(list, chunks.map((_, i) => `file '${join(TMP, `${m.name}-${i}.mp4`)}'`).join('\n'));
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', join(TMP, `${m.name}.mp4`)]);
}

// --------------------------------------------------------------- the sound ----
/* The score, written to the film's own cues, or a track brought from outside,
 * cut to length and faded; either way brought to MUSIC.lufs in two passes so
 * the level is exact rather than chased. */
let audio = null;
if (!flag('--silent')) {
    const raw = join(TMP, 'raw.wav');
    if (arg('--music')) {
        ffmpeg(['-i', arg('--music'), '-t', String(TO - FROM), '-af',
            `afade=t=out:st=${Math.max(0, TO - FROM - 2.5)}:d=2.5`, '-ar', '48000', '-ac', '2', raw]);
    } else {
        const here = cues.filter(c => c.t >= FROM && c.t < TO).map(c => ({t: c.t - FROM, kind: c.kind}));
        const scenes = film.scenes.map(s => ({id: s.id, start: s.start - FROM, dur: s.dur}));
        const score = renderScore({duration: TO - FROM, cues: here, scenes, music: Object.assign({}, MUSIC, {offset: MUSIC.offset - FROM})});
        writeFileSync(raw, wav(score));
        console.log(`score: ${here.length} cues, peak ${(20 * Math.log10(score.peak)).toFixed(1)} dBFS before levelling`);
    }
    const target = `I=${MUSIC.lufs}:TP=-1:LRA=11`;
    const measured = JSON.parse(ffmpeg(['-hide_banner', '-loglevel', 'info', '-i', raw, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'],
        {encoding: 'utf8'}).stderr.match(/\{[\s\S]*\}/)[0]);
    audio = join(TMP, 'audio.wav');
    ffmpeg(['-i', raw, '-af', `loudnorm=${target}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:` +
        `measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`,
        '-ar', '48000', audio]);
    console.log(`sound: ${measured.input_i} LUFS → ${MUSIC.lufs} LUFS`);
}

for (const m of masters) {
    const out = join(OUT, m.file);
    ffmpeg(['-i', join(TMP, `${m.name}.mp4`), ...(audio ? ['-i', audio, '-c:a', 'aac', '-b:a', '384k', '-ar', '48000', '-shortest'] : []),
        '-c:v', 'copy', '-movflags', '+faststart', out]);
    console.log(rel(out));
}
if (!PART) console.log(`docs/video/poster.png  ${POSTER.w}×${POSTER.h}`);

// ------------------------------------------------------------- the checks ----
/* The film as a viewer gets it, from the encoded file: a camera that stops for
 * a frame mid-move, and a picture that flashes more than three times a second
 * (WCAG 2.3.1), where a flash is a swing of a tenth of the frame's brightness. */
{
    const stats = join(TMP, 'stats.txt');
    ffmpeg(['-i', join(OUT, masters[0].file), '-vf', `scale=480:-1,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${stats}`, '-f', 'null', '-']);
    const y = [...readFileSync(stats, 'utf8').matchAll(/YAVG=([0-9.e+-]+)/g)].map(m => Number(m[1]));
    const d = y.slice(1).map((v, i) => v - y[i]);
    const stalls = [];
    for (let i = 1; i < d.length - 1; i++) {
        if (Math.abs(d[i]) < 0.02 && Math.abs(d[i - 1]) > 0.3 && Math.abs(d[i + 1]) > 0.3) stalls.push(((i + 1) / FPS).toFixed(2));
    }
    const swings = [];
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) >= 25.5) swings.push(i / FPS);
    const flashes = swings.filter((t, i) => swings.filter(u => u >= t && u < t + 1).length > 3 * 2);
    console.log(`checks: ${stalls.length ? `stalls at ${stalls.join(', ')} s` : 'no stalls'}; ` +
        `${flashes.length ? `flashing near ${flashes[0].toFixed(1)} s` : 'no flashing'}`);
}

if (!PART) makeGif();

rmSync(TMP, {recursive: true, force: true});
server.close();
