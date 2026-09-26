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
const frame = async (name, caption, shot) => {
    const bg = dark ? '#14171c' : '#eef1f5';
    const fg = dark ? '#e9ebef' : '#101418';
    const dim = dark ? '#98a1ac' : '#5a6472';
    const shadow = dark ? '0 30px 70px rgba(0,0,0,.55)'
        : '0 2px 8px rgba(16,24,40,.07),0 30px 70px rgba(16,24,40,.20)';
    await stage.setContent(`<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;background:${bg};
      display:flex;align-items:center;justify-content:center;gap:72px;overflow:hidden;
      font:16px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:${fg};
      -webkit-font-smoothing:antialiased">
      <div style="width:450px;flex:none">
        <div style="font-size:40px;line-height:1.12;font-weight:700;letter-spacing:-.025em;margin-bottom:18px">${caption.title}</div>
        <div style="font-size:19px;line-height:1.55;color:${dim}">${caption.text}</div>
      </div>
      <div style="position:relative;flex:none;border-radius:16px;box-shadow:${shadow}">
        <img src="data:image/png;base64,${shot.png.toString('base64')}"
             style="display:block;width:${SHOT_WIDTH}px;height:auto;border-radius:16px" alt="">
        ${shot.cut ? `<div style="position:absolute;left:0;right:0;bottom:0;height:72px;border-radius:0 0 16px 16px;
             background:linear-gradient(to bottom, rgba(0,0,0,0), ${bg})"></div>` : ''}
      </div>
      </body></html>`);
    await stage.waitForTimeout(120);
    await save(name, await stage.screenshot({type: 'png'}));
};

/* The first frame is the only one most people see, so it carries the claim in
 * words as well as in the picture: the form, under one line saying what it shows. */
{
    const bg = dark ? '#14171c' : '#eef1f5';
    const shadow = dark ? '0 24px 60px rgba(0,0,0,.55)'
        : '0 2px 8px rgba(16,24,40,.07),0 24px 60px rgba(16,24,40,.18)';
    await stage.setContent(`<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;background:${bg};
      display:flex;flex-direction:column;align-items:center;gap:26px;padding-top:40px;box-sizing:border-box;
      overflow:hidden;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
      color:${dark ? '#e9ebef' : '#101418'};-webkit-font-smoothing:antialiased">
      <div style="font-size:38px;line-height:1.1;font-weight:700;letter-spacing:-.025em">One click. Every field. Even the custom ones.</div>
      <img src="data:image/png;base64,${formPng.toString('base64')}"
           style="display:block;width:1000px;height:auto;border-radius:14px;box-shadow:${shadow}" alt="">
      </body></html>`);
    await stage.waitForTimeout(120);
    await save('1-filled-form.png', await stage.screenshot({type: 'png'}));
}

await frame('2-one-press.png', {
    title: 'One believable person, not random noise.',
    text: 'The email follows the name, the postcode follows the city, the phone follows the country — and every field shows where its value came from.'
}, keep('popup-fill.png', await pane()));

await pop.click('#tabDebug');
await pop.waitForTimeout(400);
await frame('3-debug.png', {
    title: 'Reproduce any bug with the same data.',
    text: 'Pin a seed to get the same person again. See which rule answered, what the AI was asked, and save one report for the ticket.'
}, keep('popup-debug.png', await pane()));

await pop.click('#tabSettings');
await pop.waitForTimeout(300);
await frame('4-settings.png', {
    title: 'AI built into Chrome.<br>No key. No bill.',
    text: 'Gemini Nano runs on your machine and answers the fields no rule knows. No account, no subscription — your own API key only if you want one.'
}, keep('popup-settings.png', await pane()));

/* The promo tile, drawn from the same mark the toolbar animates rather than
 * beside it: a second copy of a silhouette is a second thing to keep in step. */
const drawMark = readFileSync(join(root, 'src/background.js'), 'utf8').match(/^function drawMark\(g, size\) \{[\s\S]*?^\}/m);
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
await save('5-promo-440x280.png', await stage.screenshot({type: 'png'}), TILE.w, TILE.h);

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
await save('6-marquee-1400x560.png', await stage.screenshot({type: 'png'}), MARQUEE.w, MARQUEE.h);

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
