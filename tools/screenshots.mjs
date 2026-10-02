/* Render the store screenshots and the site's popup pictures, reproducibly.
 *
 * The Chrome Web Store takes 1280×800 exactly, and a picture taken by hand on a
 * Retina screen is neither that size nor the same twice. This loads the real
 * extension, fills the bundled fixture through the same path the shortcuts use,
 * and stages each frame at the size the store wants.
 *
 * Three things decide whether the result looks like a product or like a webpage
 * somebody photographed:
 *
 *   Everything is drawn at twice the size and reduced. A 1280×800 frame
 *   rendered directly is thin and soft wherever the store shows it smaller;
 *   the same frame drawn at 2560×1600 and boxed down keeps its edges.
 *
 *   A popup is 360px wide, a sixth of the frame. At its own size it is a stamp
 *   in a field of nothing, so it is magnified — and the magnification comes out
 *   of the 2x render rather than out of thin air.
 *
 *   A pane is cut to the height it actually uses. A popup page is shorter than
 *   the window it is measured in, and `fullPage` hands back the empty half too:
 *   on a white card that reads as a screenshot of something that failed to load.
 *
 *   node tools/screenshots.mjs             # docs/store/*.png and site/img/popup-*.png
 *   node tools/screenshots.mjs --dark      # the popup frames in the dark theme
 */
import {chromium} from 'playwright';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'docs', 'store');
mkdirSync(OUT, {recursive: true});
const dark = process.argv.includes('--dark');

const W = 1280, H = 800;          // what the store takes, exactly
const TILE = {w: 440, h: 280};    // the small promo tile
const MARQUEE = {w: 1400, h: 560}; // the large one, used when the store features it
const SOCIAL = {w: 1280, h: 640};   // the card a link to the repository or the site unfurls into
const SHOT_WIDTH = 440;           // how wide a popup sits in a frame
const SHOT_MAX = Math.round(730 * 360 / SHOT_WIDTH);   // and how much of it fits at that width

const body = readFileSync(join(root, 'test/demo-form.html'));
const server = createServer((q, r) => {
    r.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    r.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

/* English, whatever the machine is set to: a file input draws its button in the
 * browser's own language, and a store screenshot with a Russian "choose file"
 * on it is a screenshot of somebody else's browser. */
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ff-shots-')), {
    channel: 'chromium', headless: true, viewport: {width: W, height: H},
    deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light', locale: 'en-US',
    env: Object.assign({}, process.env, {LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8'}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox', '--no-first-run',
        '--lang=en-US', '--force-color-profile=srgb']
});
const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', {timeout: 15000});
const id = worker.url().split('/')[2];

/* The 2x render, boxed down to the size the store wants, in a browser of its
 * own at 1x so the screenshot is the canvas pixel for pixel. Through a
 * screenshot, not the canvas's own encoder: that one writes RGBA, and the store
 * takes screenshots and tiles only as 24-bit PNG, without alpha. */
const plain = await chromium.launch({channel: 'chromium', headless: true});
const scaler = await plain.newPage({deviceScaleFactor: 1});
const reduce = async (png, w, h) => {
    await scaler.setViewportSize({width: w, height: h});
    await scaler.setContent('<body style="margin:0;overflow:hidden"><canvas id="c" style="display:block"></canvas>');
    await scaler.evaluate(async ({data, w, h}) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + data;
        await img.decode();
        const c = document.getElementById('c');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, w, h);
    }, {data: png.toString('base64'), w, h});
    return scaler.screenshot({type: 'png', clip: {x: 0, y: 0, width: w, height: h}});
};

const save = async (name, png, w = W, h = H) => {
    const out = await reduce(png, w, h);
    writeFileSync(join(OUT, name), out);
    console.log(`docs/store/${name}  ${w}×${h}`);
    return out;
};

/* A headless browser has no Gemini Nano, and a listing for an AI filler whose
 * every frame says "rules only" sells the fallback. So the worker gets a stand-in
 * that answers the way the real model does, through the same session, schema and
 * write path, in about the time it takes — only the words are fixed, so the
 * frames come out the same twice. */
await worker.evaluate(() => {
    const ANSWERS = {
        'Internal ticket': 'REL-2417',
        'Release notes': 'Moves invoice export to the new queue; rollback is the export.queue flag.'
    };
    const session = {
        inputUsage: 1, inputQuota: 4096,
        async prompt(text, opts) {
            await new Promise(r => setTimeout(r, 1400));    // about what a warm on-device batch takes
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
});

// 1. The form, filled, with the card still up: the first frame.
const page = await ctx.newPage();
await page.goto(`${origin}/form.html`);
await page.waitForTimeout(500);
await worker.evaluate(async ({url}) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url === url);
    await self.askPage(tab.id, {
        kind: 'fill',
        settings: {
            locale: 'en-US',
            seed: 'STORE1',
            useAI: true,
            overwrite: true,
            emailDomain: 'example.com',
            debugTab: true
        }
    });
}, {url: `${origin}/form.html`});
// The model's answer lands after the rules have filled the form; the frame wants both.
await page.waitForFunction(() => document.getElementById('ticket').value === 'REL-2417' &&
    !!document.querySelector('#fillsmith-hud:not(.ff-busy) .ff-tick'), null, {timeout: 20000})
    .catch(() => console.log('the model answer did not land; the frame shows what did'));
await page.waitForTimeout(350);
const formPng = await page.screenshot({type: 'png'});

/* What a store frame shows has to be read at half its size, so a frame shows a
 * part, magnified, never a whole screen: the first rows of the form and the card. */
const boxOf = (target, pick, pad = 0) => target.evaluate(({pick, pad}) => {
    const els = pick.flatMap(sel => Array.from(document.querySelectorAll(sel.css)).slice(sel.from || 0, sel.to));
    const r = els.map(e => e.getBoundingClientRect()).filter(b => b.width && b.height);
    const x = Math.min(...r.map(b => b.left)) - pad, y = Math.min(...r.map(b => b.top)) - pad;
    return {x, y, width: Math.max(...r.map(b => b.right)) + pad - x, height: Math.max(...r.map(b => b.bottom)) + pad - y};
}, {pick, pad});
const formCrop = await page.screenshot({type: 'png', clip: await boxOf(page, [{css: '.field', from: 0, to: 6}], 14)});
const cardCrop = await page.screenshot({type: 'png', clip: await boxOf(page, [{css: '#fillsmith-hud'}], 0)});

// 2–4. The popup's panes, magnified and staged beside one line about each.
// The Debug tab is opt-in and hidden until it is asked for, here as anywhere.
await worker.evaluate(() => chrome.storage.local.set({debugTab: true}));
const pop = await ctx.newPage();
await pop.setViewportSize({width: 360, height: 900});
await pop.goto(`chrome-extension://${id}/src/popup.html`);
await pop.waitForTimeout(700);

/* The site shows the panes at their own size beside text it writes itself: a
 * store frame, text and all, shrunk to a third of a page is unreadable. */
const SITE_IMG = join(root, 'site', 'img');
mkdirSync(SITE_IMG, {recursive: true});
const keep = (name, shot) => {
    writeFileSync(join(SITE_IMG, name), shot.png);
    console.log(`site/img/${name}`);
    return shot;
};

const pane = async () => {
    const tall = await pop.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    const height = Math.min(tall, SHOT_MAX);
    return {
        png: await pop.screenshot({type: 'png', clip: {x: 0, y: 0, width: 360, height}}),
        cut: tall > height          // a pane taller than the frame; the stage says so rather than slicing it
    };
};

const stage = await ctx.newPage();
await stage.setViewportSize({width: W, height: H});
/* The mark is drawn from the toolbar's own function rather than kept as a
 * second copy of the silhouette, which would be a second thing to keep in step. */
const drawMark = readFileSync(join(root, 'src/background.js'), 'utf8').match(/^function drawMark\(g, size\) \{[\s\S]*?^\}/m);
const MARK_SCRIPT = `<script>${drawMark ? drawMark[0] : ''}
  document.querySelectorAll('canvas.mark').forEach(c => drawMark(c.getContext('2d'), c.width));<\/script>`;

/* Every store frame on the brand's green, the claim set large enough to read
 * in the carousel's thumbnail, the product big and running off the edge. On a
 * pale ground the frames sank into the store's own white page. */
const GREEN = 'radial-gradient(120% 140% at 22% 0%, #2a8a62, #16553b 58%, #0f3a29)';
const FONT = "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
const brandRow = `<div style="position:absolute;left:64px;top:50px;display:flex;align-items:center;gap:12px">
  <div style="padding:3px;border-radius:12px;background:rgba(255,255,255,.14);display:flex">
    <canvas class="mark" width="88" height="88" style="width:44px;height:44px"></canvas></div>
  <span style="font-size:26px;font-weight:700;letter-spacing:-.02em">Fillsmith</span></div>`;
const claim = (caption, width) => `<div style="position:absolute;left:64px;top:0;bottom:0;width:${width}px;
    display:flex;flex-direction:column;justify-content:center">
    <div style="font-size:60px;line-height:1.02;font-weight:800;letter-spacing:-.035em;margin-bottom:22px">${caption.title}</div>
    <div style="font-size:32px;line-height:1.25;font-weight:500;letter-spacing:-.01em;color:rgba(255,255,255,.93);text-wrap:balance">${caption.text}</div>
  </div>`;
const greenFrame = (inner) => `<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;
  position:relative;background:${GREEN};color:#fff;font:16px/1.5 ${FONT};-webkit-font-smoothing:antialiased">
  ${brandRow}${inner}${MARK_SCRIPT}</body></html>`;

/* A part of the popup, magnified: at its own size it is a stamp the store
 * shrinks again. Flat, on a white card — the angle read as a gimmick. */
const POP_ZOOM = 1.7;
const card = (png, width, extra = '') => `<img src="data:image/png;base64,${png.toString('base64')}" alt=""
    style="display:block;width:${width}px;border-radius:18px;background:#fff;
           box-shadow:0 40px 90px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.10);${extra}">`;
const widthOf = async (png) => (await scaler.evaluate(async (d) => {
    const i = new Image();
    i.src = 'data:image/png;base64,' + d;
    await i.decode();
    return i.naturalWidth;
}, png.toString('base64'))) / 2;      // the captures are 2x

/* One or more crops on one white card, in order, each at the popup zoom. A crop
 * taken tight to its content gets the card's padding instead of the page's
 * neighbours, which leaked a stray shadow into the corner. */
const frame = async (name, caption, pngs, pad = 0, zoom = POP_ZOOM) => {
    const parts = Array.isArray(pngs) ? pngs : [pngs];
    const imgs = [];
    for (const [k, png] of parts.entries()) {
        const w = Math.round((await widthOf(png)) * zoom);
        imgs.push(`<img src="data:image/png;base64,${png.toString('base64')}" alt="" style="display:block;width:${w}px;
            ${k ? 'border-top:1px solid #e3e6ec;' : ''}">`);
    }
    await stage.setContent(greenFrame(`${claim(caption, 470)}
      <div style="position:absolute;right:72px;top:0;bottom:0;display:flex;align-items:center">
        <div style="background:#fff;border-radius:18px;padding:${pad}px;overflow:hidden;
                    box-shadow:0 40px 90px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.10)">${imgs.join('')}</div>
      </div>`));
    await stage.waitForTimeout(150);
    await save(name, await stage.screenshot({type: 'png'}));
};

// `full` takes the popup's whole width, so crops stacked on one card line up.
const popCrop = async (pick, pad = 10, full = false) => {
    const box = await boxOf(pop, pick, pad);
    if (full) Object.assign(box, {x: 0, width: 360});
    return pop.screenshot({type: 'png', clip: box});
};

/* The first frame is the only one most people see: the claim across the top,
 * the form's first rows under it, and the card that says what one press did. */
{
    const fw = Math.round((await widthOf(formCrop)) * 1.3);
    const cw = Math.round((await widthOf(cardCrop)) * 1.5);
    await stage.setContent(greenFrame(`
      <div style="position:absolute;left:64px;top:128px;right:64px">
        <div style="font-size:64px;line-height:1;font-weight:800;letter-spacing:-.035em">Fill any form in one click.</div>
        <div style="font-size:32px;line-height:1.25;font-weight:500;letter-spacing:-.01em;color:rgba(255,255,255,.93);margin-top:16px">Even custom dropdowns, date pickers and uploads.</div>
      </div>
      <div style="position:absolute;left:64px;top:330px">${card(formCrop, fw)}</div>
      <div style="position:absolute;right:44px;bottom:40px">${card(cardCrop, cw, 'border-radius:16px')}</div>`));
    await stage.waitForTimeout(150);
    await save('1-filled-form.png', await stage.screenshot({type: 'png'}));
}

/* The second frame is the whole case at a glance, the way a reader skims: four
 * claims, each a word-sized title and one line, large enough to read as a thumbnail. */
{
    const ICONS = {
        cursor: '<path d="M4 4l7.5 16 2.2-6.3L20 11.5z"/>',
        person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
        shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
        spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'
    };
    const tiles = [
        ['cursor', 'Custom controls', 'Dropdowns, calendars, editors, uploads.'],
        ['person', 'One person', 'Email, postcode and phone that match.'],
        ['shield', 'Valid on submit', 'Limits kept, nothing left empty.'],
        ['spark', 'Free AI', 'Built into Chrome. No API key.']
    ].map(([icon, title, text]) => `<div style="background:#fff;color:#101418;border-radius:20px;padding:30px 26px;
          box-shadow:0 28px 44px -18px rgba(0,0,0,.55)">
        <svg viewBox="0 0 24 24" style="width:56px;height:56px;padding:12px;border-radius:14px;background:#e7f3ed;
             stroke:#1f6f4f;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;box-sizing:border-box">${ICONS[icon]}</svg>
        <div style="font-size:27px;line-height:1.15;font-weight:800;letter-spacing:-.02em;margin:22px 0 12px">${title}</div>
        <div style="font-size:23px;line-height:1.35;color:#3d4653">${text}</div></div>`).join('');
    await stage.setContent(greenFrame(`
      <div style="position:absolute;left:64px;right:64px;top:150px;text-align:center">
        <div style="font-size:56px;line-height:1.05;font-weight:800;letter-spacing:-.035em">What one click does</div>
        <div style="font-size:32px;font-weight:500;letter-spacing:-.01em;color:rgba(255,255,255,.93);margin-top:14px">Every field, filled like a person would.</div>
      </div>
      <div style="position:absolute;left:64px;right:64px;top:330px;display:grid;grid-template-columns:repeat(4,1fr);gap:22px">${tiles}</div>`));
    await stage.waitForTimeout(150);
    await save('2-features.png', await stage.screenshot({type: 'png'}));
}

await frame('3-one-person.png', {
    title: 'One believable<br>person.',
    text: 'Email, postcode and phone that belong together.'
}, (keep('popup-fill.png', await pane()), await popCrop([{css: '#result'}])));

await pop.click('#tabDebug');
await pop.waitForTimeout(400);
await frame('4-debug.png', {
    title: 'Reproduce<br>any bug.',
    text: 'Same seed, same data. One report for the ticket.'
}, (keep('popup-debug.png', await pane()), await popCrop([{css: '#debugBody .dbg-sec', from: 0, to: 3}], 0)), 22);

await pop.click('#tabSettings');
await pop.waitForTimeout(300);
await frame('5-ai-free.png', {
    title: 'AI built into<br>Chrome. Free.',
    text: 'No API key. No account. No subscription.'
}, (keep('popup-settings.png', await pane()), [
    await popCrop([{css: 'header.head'}], 0, true),
    await popCrop([{css: '#paneSettings .opt', from: 0, to: 1}], 8, true),
    await popCrop([{css: '#advanced > summary'}], 12, true)
]), 0, 1.8);

/* The promo tile, drawn from the same mark the toolbar animates. */
await stage.setViewportSize({width: TILE.w, height: TILE.h});
await stage.setContent(`<!doctype html><html><body style="margin:0;width:${TILE.w}px;height:${TILE.h}px;
  background:${dark ? '#14171c' : '#ffffff'};display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:13px;font:16px ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  color:${dark ? '#e9ebef' : '#101418'};-webkit-font-smoothing:antialiased">
  <canvas id="m" width="144" height="144" style="width:72px;height:72px"></canvas>
  <div style="font-size:27px;font-weight:700;letter-spacing:-.02em">Fillsmith</div>
  <div style="font-size:15px;color:${dark ? '#98a1ac' : '#5a6472'}">Free AI form filler. No key. No subscription.</div>
  <script>${drawMark ? drawMark[0] : ''}
    drawMark(document.getElementById('m').getContext('2d'), 144);
  <\/script></body></html>`);
await stage.waitForTimeout(150);
await save('promo-440x280.png', await stage.screenshot({type: 'png'}), TILE.w, TILE.h);

/* The marquee, shown only when the store features the extension: the claim on
 * the left, the filled form on the right, in the site's closing green. */
await stage.setViewportSize({width: MARQUEE.w, height: MARQUEE.h});
await stage.setContent(`<!doctype html><html><body style="margin:0;width:${MARQUEE.w}px;height:${MARQUEE.h}px;
  overflow:hidden;position:relative;color:#fff;-webkit-font-smoothing:antialiased;
  font:16px ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  background:radial-gradient(120% 140% at 30% 0%, #2a8a62, #16553b 60%, #0f3a29)">
  <div style="position:absolute;left:84px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center">
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:30px">
      <canvas id="m" width="112" height="112" style="width:56px;height:56px"></canvas>
      <span style="font-size:30px;font-weight:700;letter-spacing:-.02em">Fillsmith</span>
    </div>
    <div style="font-size:50px;line-height:1.05;font-weight:700;letter-spacing:-.03em;margin-bottom:22px">Fill any form with realistic test data. In one click.</div>
    <div style="font-size:20px;color:rgba(255,255,255,.8)">Free · AI built into Chrome · No API key · No account</div>
  </div>
  <img src="data:image/png;base64,${formPng.toString('base64')}" alt=""
       style="position:absolute;left:720px;top:70px;width:760px;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.45)">
  <script>${drawMark ? drawMark[0] : ''}
    drawMark(document.getElementById('m').getContext('2d'), 112);
  <\/script></body></html>`);
await stage.waitForTimeout(150);
await save('marquee-1400x560.png', await stage.screenshot({type: 'png'}), MARQUEE.w, MARQUEE.h);

/* The social card: what a link to the repository or the site turns into in a
 * chat. 2:1, which is what GitHub shows and what the chats crop least; the
 * marquee's 2.5:1 would lose its edges. GitHub takes it by hand, in Settings. */
await stage.setViewportSize({width: SOCIAL.w, height: SOCIAL.h});
await stage.setContent(`<!doctype html><html><body style="margin:0;width:${SOCIAL.w}px;height:${SOCIAL.h}px;
  overflow:hidden;position:relative;color:#fff;-webkit-font-smoothing:antialiased;
  font:16px ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  background:radial-gradient(120% 140% at 30% 0%, #2a8a62, #16553b 60%, #0f3a29)">
  <div style="position:absolute;left:72px;top:0;bottom:0;width:540px;display:flex;flex-direction:column;justify-content:center">
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:34px">
      <canvas id="m" width="112" height="112" style="width:56px;height:56px"></canvas>
      <span style="font-size:32px;font-weight:700;letter-spacing:-.02em">Fillsmith</span>
    </div>
    <div style="font-size:52px;line-height:1.06;font-weight:700;letter-spacing:-.03em;margin-bottom:24px">Fill any form with<br>realistic test data.<br><span style="color:#9fe3c2">In one click.</span></div>
    <div style="font-size:21px;line-height:1.45;color:rgba(255,255,255,.82)">Free AI form filler for Chrome.<br>No API key · No account · No subscription</div>
  </div>
  <img src="data:image/png;base64,${formPng.toString('base64')}" alt=""
       style="position:absolute;left:660px;top:92px;width:760px;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.45)">
  <script>${drawMark ? drawMark[0] : ''}
    drawMark(document.getElementById('m').getContext('2d'), 112);
  <\/script></body></html>`);
await stage.waitForTimeout(150);
{
    const card = await reduce(await stage.screenshot({type: 'png'}), SOCIAL.w, SOCIAL.h);
    writeFileSync(join(root, 'docs', 'social-preview.png'), card);
    console.log(`docs/social-preview.png  ${SOCIAL.w}×${SOCIAL.h}`);
}

await ctx.close();
await plain.close();
server.close();
