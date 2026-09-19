/* Render the store screenshots and the README picture, reproducibly.
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
 *   node tools/screenshots.mjs             # docs/store/*.png and docs/filled-form.png
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

/* The 2x render, boxed down to the size the store wants — in the browser that
 * is already open, so this needs nothing else installed. */
const scaler = await ctx.newPage();
await scaler.setContent('<body style="margin:0">');
const reduce = async (png, w, h) => Buffer.from(await scaler.evaluate(async ({data, w, h}) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + data;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/png').split(',')[1];
}, {data: png.toString('base64'), w, h}), 'base64');

const save = async (name, png, w = W, h = H) => {
    const out = await reduce(png, w, h);
    writeFileSync(join(OUT, name), out);
    console.log(`docs/store/${name}  ${w}×${h}`);
    return out;
};

// 1. The form, filled, with the card still up: the README picture and the first frame.
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
            useAI: false,
            overwrite: true,
            emailDomain: 'example.com',
            debugTab: true
        }
    });
}, {url: `${origin}/form.html`});
await page.waitForTimeout(350);
const formShot = await save('1-filled-form.png', await page.screenshot({type: 'png'}));
writeFileSync(join(root, 'docs', 'filled-form.png'), formShot);
console.log('docs/filled-form.png');

// 2–4. The popup's panes, magnified and staged beside one line about each.
// The Debug tab is opt-in and hidden until it is asked for, here as anywhere.
await worker.evaluate(() => chrome.storage.local.set({debugTab: true}));
const pop = await ctx.newPage();
await pop.setViewportSize({width: 360, height: 900});
await pop.goto(`chrome-extension://${id}/src/popup.html`);
await pop.waitForTimeout(700);

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

await frame('2-one-press.png', {
    title: 'One press. The whole form.',
    text: 'Every field, and where its value came from. They belong to one invented person: the email follows the name, the postcode follows the city.'
}, await pane());

await pop.click('#tabDebug');
await pop.waitForTimeout(400);
await frame('3-debug.png', {
    title: 'Says why, field by field.',
    text: 'Which rule answered, what the model was asked, where the time went — and one report to attach to the ticket.'
}, await pane());

await pop.click('#tabSettings');
await pop.waitForTimeout(300);
await frame('4-settings.png', {
    title: 'On-device by default.',
    text: 'Chrome’s built-in model answers the fields no rule knows. Your own API key is optional, and the network can be switched off entirely.'
}, await pane());

/* The promo tile, drawn from the same mark the toolbar animates rather than
 * beside it: a second copy of a silhouette is a second thing to keep in step. */
const drawMark = readFileSync(join(root, 'src/background.js'), 'utf8').match(/^function drawMark\(g, size\) \{[\s\S]*?^\}/m);
await stage.setViewportSize({width: TILE.w, height: TILE.h});
await stage.setContent(`<!doctype html><html><body style="margin:0;width:${TILE.w}px;height:${TILE.h}px;
  background:${dark ? '#14171c' : '#ffffff'};display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:13px;font:16px ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  color:${dark ? '#e9ebef' : '#101418'};-webkit-font-smoothing:antialiased">
  <canvas id="m" width="144" height="144" style="width:72px;height:72px"></canvas>
  <div style="font-size:27px;font-weight:700;letter-spacing:-.02em">FormForge</div>
  <div style="font-size:15px;color:${dark ? '#98a1ac' : '#5a6472'}">Fills any form with QA test data, in one press</div>
  <script>${drawMark ? drawMark[0] : ''}
    drawMark(document.getElementById('m').getContext('2d'), 144);
  <\/script></body></html>`);
await stage.waitForTimeout(150);
await save('5-promo-440x280.png', await stage.screenshot({type: 'png'}), TILE.w, TILE.h);

await ctx.close();
server.close();
