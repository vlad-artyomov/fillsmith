/* Assemble the site from what the repository already holds, and serve it.
 *
 * The landing page is the only thing written for the site; its demo is the
 * form the suites fill and its pictures are the store's, so nothing on it is a
 * copy that can drift. The pages workflow builds with this same script.
 *
 *   node tools/site.mjs            # build into .ff-site and serve it at :8100
 *   node tools/site.mjs --out DIR  # build into DIR and stop
 */
import {copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = process.argv.indexOf('--out');
const out = at > 0 ? resolve(process.argv[at + 1]) : join(root, '.ff-site');

rmSync(out, {recursive: true, force: true});
cpSync(join(root, 'site'), out, {recursive: true});
mkdirSync(join(out, 'demo'), {recursive: true});
mkdirSync(join(out, 'img'), {recursive: true});
copyFileSync(join(root, 'test/demo-form.html'), join(out, 'demo/index.html'));
copyFileSync(join(root, 'docs/demo.gif'), join(out, 'img/demo.gif'));
for (const f of readdirSync(join(root, 'docs/store')).filter(f => f.endsWith('.png'))) {
    copyFileSync(join(root, 'docs/store', f), join(out, 'img', f));
}
for (const f of ['icon32.png', 'icon128.png']) copyFileSync(join(root, 'icons', f), join(out, 'img', f));
copyFileSync(join(root, 'docs/social-preview.png'), join(out, 'img/social.png'));
console.log(`site built in ${out}`);

if (at < 0) {
    const TYPES = {'.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.gif': 'image/gif'};
    const PORT = 8100;
    createServer((q, r) => {
        let p = join(out, decodeURIComponent((q.url || '/').split('?')[0]));
        if (!p.startsWith(out)) p = out;                    // no walking out of the site
        if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
        if (!existsSync(p)) {
            r.writeHead(404);
            return r.end('not found');
        }
        r.writeHead(200, {'content-type': TYPES[extname(p)] || 'application/octet-stream'});
        r.end(readFileSync(p));
    }).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}/`));
}
