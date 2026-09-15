/* Regenerate icons/ from the mark the worker already draws.
 *
 * The animated toolbar frames are rasterised at run time by drawMark() in
 * src/background.js; shipping hand-made PNGs beside it means two sources for
 * one silhouette, and they drift. This reads that function out of the worker
 * and renders it through Chromium at each size Chrome asks for, so the still
 * icon and the moving one cannot disagree.
 *
 *   node tools/icons.mjs
 */
import {chromium} from 'playwright';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 16 toolbar and favicon · 24 toolbar at 1.5x · 32 Windows, and what the
 * spinner draws · 48 the extensions page · 128 the install dialog and the
 * store. The store's own listing icon is the same mark inside 16px of padding,
 * which is what its guidelines ask for and what the package never uses. */
const SIZES = [16, 24, 32, 48, 128];
const STORE = {size: 128, pad: 16, name: 'store-icon128.png'};

const worker = readFileSync(join(root, 'src/background.js'), 'utf8');
const drawMark = worker.match(/^function drawMark\(g, size\) \{[\s\S]*?^\}/m);
if (!drawMark) throw new Error('drawMark() not found in src/background.js — has the mark moved?');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addScriptTag({content: drawMark[0]});

/* Drawn at eight times the size and reduced: a 1.9px bar rasterised directly
 * lands between two rows of pixels and greys out, where a reduction keeps its
 * weight. This is why the shipped 128 used to be a scaled-up 32 — the stair
 * steps on its corners were visible in the store listing. */
async function render(size, inner, pad) {
    return Buffer.from(await page.evaluate(({size, inner, pad}) => {
        const scale = 8;
        const big = document.createElement('canvas');
        big.width = big.height = inner * scale;
        drawMark(big.getContext('2d'), inner * scale);

        const out = document.createElement('canvas');
        out.width = out.height = size;
        const g = out.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(big, pad, pad, inner, inner);
        return out.toDataURL('image/png').split(',')[1];
    }, {size, inner, pad}), 'base64');
}

for (const size of SIZES) {
    writeFileSync(join(root, `icons/icon${size}.png`), await render(size, size, 0));
    console.log(`icons/icon${size}.png`);
}
const inner = STORE.size - STORE.pad * 2;
writeFileSync(join(root, `docs/${STORE.name}`), await render(STORE.size, inner, STORE.pad));
console.log(`docs/${STORE.name}  (${inner}px mark inside ${STORE.size}, for the store listing)`);

await browser.close();
