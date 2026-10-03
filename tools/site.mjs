/* Assemble the site from what the repository already holds, and serve it.
 *
 * The landing page is the only thing written for the site; its demo is the
 * form the suites fill and its pictures are the store's, so nothing on it is a
 * copy that can drift. The pages workflow builds with this same script.
 *
 *   node tools/site.mjs            # build into .ff-site and serve it at :8100
 *   node tools/site.mjs --out DIR  # build into DIR and stop
 */
import {copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
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
// The demo video's loop for the top of the page, and the whole video, with its poster, further down.
copyFileSync(join(root, 'docs/video/fillsmith-demo.mp4'), join(out, 'img/demo.mp4'));
copyFileSync(join(root, 'docs/video/fillsmith-demo.jpg'), join(out, 'img/demo.jpg'));
copyFileSync(join(root, 'docs/video/fillsmith-promo.mp4'), join(out, 'img/demo-video.mp4'));
copyFileSync(join(root, 'docs/video/poster.png'), join(out, 'img/demo-video.png'));
for (const f of readdirSync(join(root, 'docs/store')).filter(f => f.endsWith('.png'))) {
    copyFileSync(join(root, 'docs/store', f), join(out, 'img', f));
}
for (const f of ['icon32.png', 'icon128.png']) copyFileSync(join(root, 'icons', f), join(out, 'img', f));
copyFileSync(join(root, 'docs/social-preview.png'), join(out, 'img/social.png'));

/* The privacy policy as a page of the site. The store checks that its link
 * answers, and a GitHub file view did not answer its check; PRIVACY.md stays the
 * one text, turned into HTML here — it uses only headings, paragraphs, lists,
 * one table, links, bold, italics and code. */
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/&lt;(https?:\/\/[^&]+)&gt;/g, '<a href="$1">$1</a>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>');
const blocks = readFileSync(join(root, 'PRIVACY.md'), 'utf8').trim().split(/\n\s*\n/);
const body = blocks.map(block => {
    const lines = block.split('\n');
    if (/^#{1,3} /.test(lines[0])) {
        const level = lines[0].match(/^#+/)[0].length;
        return `<h${level}>${inline(lines[0].replace(/^#+ /, ''))}</h${level}>`;
    }
    if (lines[0].startsWith('|')) {
        const cells = (l) => l.split('|').slice(1, -1).map(c => c.trim());
        const [head, , ...rows] = lines;
        return `<table><thead><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
            rows.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
    }
    if (lines[0].startsWith('- ')) {
        const items = block.split(/\n(?=- )/).map(i => i.replace(/^- /, '').replace(/\n\s+/g, ' '));
        return `<ul>${items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`;
    }
    return `<p>${inline(lines.join(' '))}</p>`;
}).join('\n');
mkdirSync(join(out, 'privacy'), {recursive: true});
writeFileSync(join(out, 'privacy/index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Privacy — Fillsmith</title>
<link rel="icon" href="../img/icon32.png"><style>
body{margin:0;background:#fff;color:#101418;font:17px/1.65 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:48px 24px 80px}a{color:#1f6f4f}h1{font-size:40px;letter-spacing:-.02em;margin:24px 0 12px}
h2{font-size:22px;margin:36px 0 8px}code{font:14px ui-monospace,Menlo,monospace;background:#f1f3f5;padding:1px 5px;border-radius:5px}
table{border-collapse:collapse;width:100%;font-size:15px}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid #e4e7ec}
.home{font-weight:600;text-decoration:none}
@media (prefers-color-scheme:dark){body{background:#0f1215;color:#ebedf0}a{color:#3bb07f}code{background:#1d2228}th,td{border-color:#262b33}}
</style></head><body><main><a class="home" href="../">← Fillsmith</a>
${body}
</main></body></html>`);
console.log(`site built in ${out}`);

if (at < 0) {
    const TYPES = {'.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.gif': 'image/gif',
        '.jpg': 'image/jpeg', '.mp4': 'video/mp4'};
    const PORT = 8100;
    createServer((q, r) => {
        let p = join(out, decodeURIComponent((q.url || '/').split('?')[0]));
        if (!p.startsWith(out)) p = out;                    // no walking out of the site
        if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
        if (!existsSync(p)) {
            r.writeHead(404);
            return r.end('not found');
        }
        const file = readFileSync(p), type = TYPES[extname(p)] || 'application/octet-stream';
        // A video is asked for in ranges, as GitHub Pages answers them; without one it will not seek.
        const range = /bytes=(\d*)-(\d*)/.exec(q.headers.range || '');
        if (range) {
            const from = Number(range[1] || 0), to = range[2] ? Number(range[2]) : file.length - 1;
            r.writeHead(206, {'content-type': type, 'accept-ranges': 'bytes', 'content-length': to - from + 1,
                'content-range': `bytes ${from}-${to}/${file.length}`});
            return r.end(file.subarray(from, to + 1));
        }
        r.writeHead(200, {'content-type': type, 'accept-ranges': 'bytes'});
        r.end(file);
    }).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}/`));
}
