/* Move the version on, in both files that carry it.
 *
 * The version is two numbers that must agree — manifest.json is what Chrome
 * reads, package.json is what everything else does — and the tag that publishes
 * has to match them. Editing two files by hand is the one part of releasing
 * that is easy to get half right, so this does that part and stops: the commit
 * subject is this project's changelog and belongs to whoever made the change.
 *
 *   node tools/release.mjs patch      1.0.0 -> 1.0.1
 *   node tools/release.mjs minor      1.0.0 -> 1.1.0
 *   node tools/release.mjs major      1.0.0 -> 2.0.0
 *   node tools/release.mjs 2.3.0      exactly that
 */
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['manifest.json', 'package.json'];

const fail = (msg) => {
    console.error(`\n  ${msg}\n`);
    process.exit(1);
};

const read = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));
const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
    return m ? m.slice(1).map(Number) : null;
};

const [manifest, pkg] = FILES.map(read);
if (manifest.version !== pkg.version) {
    fail(`manifest.json is ${manifest.version} but package.json is ${pkg.version} — fix that first, they must agree.`);
}

const current = parse(manifest.version);
if (!current) fail(`the current version, ${manifest.version}, is not x.y.z — this tool only moves those.`);

const asked = (process.argv[2] || '').trim();
if (!asked) fail('say what to move: patch, minor, major, or an exact x.y.z.');

const [major, minor, patch] = current;
const next = asked === 'patch' ? [major, minor, patch + 1]
    : asked === 'minor' ? [major, minor + 1, 0]
        : asked === 'major' ? [major + 1, 0, 0]
            : parse(asked);
if (!next) fail(`"${asked}" is not patch, minor, major, or an x.y.z version.`);

const version = next.join('.');

/* A version only ever goes up. A store refuses a build numbered below one it has
 * already seen, and so does anybody reading the log. */
const higher = next.some((n, i) => n > current[i] && next.slice(0, i).every((m, j) => m === current[j]));
if (!higher) fail(`${version} is not above ${manifest.version} — a version only ever goes up.`);

// The tag is the thing that publishes, so one that already exists is a release
// that already happened. `v` in front, as GitHub tags are written.
const tag = `v${version}`;
try {
    const known = execFileSync('git', ['tag', '--list', tag], {cwd: root, encoding: 'utf8'}).trim();
    if (known) fail(`${tag} already exists — that release has been cut.`);
} catch (err) {
    if (err && err.status === 1) fail(`${tag} already exists — that release has been cut.`);
    // No git, or not a repository: the files are still worth writing.
}

for (const f of FILES) {
    const json = read(f);
    json.version = version;
    writeFileSync(join(root, f), JSON.stringify(json, null, 2) + '\n');
}

/* The lockfile carries the version twice more. npm rewrites them on the next
 * install, which put a stray version bump into an unrelated diff — and left a
 * lock that said 1.26.0 beside a manifest that said 1.0.1. */
const LOCK = 'package-lock.json';
let wrote = FILES.slice();
try {
    const lock = read(LOCK);
    lock.version = version;
    if (lock.packages && lock.packages['']) lock.packages[''].version = version;
    writeFileSync(join(root, LOCK), JSON.stringify(lock, null, 2) + '\n');
    wrote.push(LOCK);
} catch (_) {
    // No lockfile: nothing to keep in step.
}

console.log(`\n  ${manifest.version} -> ${version}   (${wrote.join(', ')})\n`);
console.log('  Land it with the change it belongs to, then publish:\n');
console.log(`    git commit -am "Fillsmith ${version}: what landed"`);
console.log(`    git push origin main`);
console.log(`    git tag ${tag} && git push origin ${tag}\n`);
console.log('  The tag runs the suites, checks it matches the manifest, and puts the ZIP on a release.\n');
