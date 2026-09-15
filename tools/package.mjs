/* Build the ZIP that goes to the Chrome Web Store.
 *
 * An allow-list, never "zip the folder": this working tree also holds live
 * session cookies (.ff-auth.json, .ff-profile/), node_modules and the suites.
 * A store package is public and permanent, so the only safe default is to name
 * what ships and refuse anything surprising.
 *
 *   node tools/package.mjs
 */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPS = ['manifest.json', 'src', 'icons'];

const fail = (msg) => {
    console.error(`\n  ${msg}\n`);
    process.exit(1);
};

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// A store version can only ever go up, so a mismatch here is worth stopping for.
if (manifest.version !== pkg.version) {
    fail(`manifest.json is ${manifest.version} but package.json is ${pkg.version} — they must match.`);
}

// Everything the manifest points at has to be in the package, or Chrome rejects the upload.
const referenced = new Set();
const walk = (v) => {
    if (typeof v === 'string') {
        if (/\.(js|html|css|png|json)$/.test(v)) referenced.add(v.replace(/^\//, ''));
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
};
walk(manifest);
referenced.add('src/content.js');                       // injected by name, not named in the manifest
for (const f of referenced) {
    if (!existsSync(join(root, f))) fail(`manifest.json refers to ${f}, which does not exist.`);
}

// The injected list is the worker's to own; the package must carry all of it.
const worker = readFileSync(join(root, 'src/background.js'), 'utf8');
const listed = worker.match(/const FILLER_FILES = \[([\s\S]*?)]/);
if (listed) {
    for (const f of listed[1].match(/'([^']+)'/g).map(s => s.slice(1, -1))) {
        if (!existsSync(join(root, f))) fail(`FILLER_FILES names ${f}, which does not exist.`);
    }
}

const out = join(root, `formforge-${manifest.version}.zip`);
rmSync(out, {force: true});
execFileSync('zip', ['-r', '-X', '-q', out, ...SHIPS], {cwd: root});

// Read the archive back and prove it holds only what was asked for.
const inside = execFileSync('unzip', ['-Z1', out], {cwd: root, encoding: 'utf8'})
    .split('\n').filter(Boolean);
const stray = inside.filter(f => !SHIPS.some(s => f === s || f.startsWith(s + '/')));
if (stray.length) fail(`the archive picked up ${stray.length} unexpected entr${stray.length === 1 ? 'y' : 'ies'}: ${stray.slice(0, 5).join(', ')}`);
if (!inside.includes('manifest.json')) fail('manifest.json is not at the root of the archive.');

const kb = Math.round(statSync(out).size / 1024);
console.log(`\n  ${out.replace(root + '/', '')}  ${kb} KB, ${inside.length} files`);
console.log(`  ${manifest.name} ${manifest.version}`);
console.log(`  permissions: ${(manifest.permissions || []).join(', ')}`);
console.log(`  host access: ${(manifest.host_permissions || []).join(', ') || 'none beyond activeTab'}\n`);
