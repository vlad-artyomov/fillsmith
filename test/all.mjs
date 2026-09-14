/* Run the four suites at once. They are independent Chromium sessions, so the
 * wall time is the slowest suite rather than the sum. Each suite's own output is
 * kept and printed in full only when it fails. */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = ['run', 'widgets', 'complete', 'extension'];

const results = await Promise.all(SUITES.map(name => new Promise(done => {
    const t0 = Date.now();
    let out = '';
    const child = spawn(process.execPath, [resolve(here, `${name}.mjs`)], {stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', d => {
        out += d;
    });
    child.stderr.on('data', d => {
        out += d;
    });
    child.on('close', code => done({name, code, out, ms: Date.now() - t0}));
})));

let failed = 0;
for (const r of results) {
    const passes = (r.out.match(/^PASS/gm) || []).length;
    const fails = (r.out.match(/^FAIL/gm) || []).length;
    const ok = r.code === 0 && fails === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(10)} ${String(passes).padStart(3)} passed  ${fails ? fails + ' failed  ' : ''}${(r.ms / 1000).toFixed(0)}s`);
    if (!ok) console.log(r.out.split('\n').filter(l => /^FAIL|Error|WATCHDOG|SKIP/.test(l)).map(l => '      ' + l).join('\n'));
}
console.log(failed ? `\n${failed} suite(s) failed.` : '\nAll suites passed.');
process.exit(failed ? 1 : 0);
