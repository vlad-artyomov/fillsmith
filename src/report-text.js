/* Fillsmith — the report as plain text.
 *
 * One report, for both readers. A tester attaches it to a ticket; whoever picks
 * the ticket up needs the same thing plus the timings of the fills around it,
 * and a pattern — a stage that is sometimes slow, a model that sometimes never
 * answers — only shows across several fills. So: the run of recent fills first,
 * then each kept fill in full, newest first, prompts last because they are long.
 * Shared by the report page and anything else that wants the text.
 */
(function () {
    'use strict';

    const ms = (n) => (n == null ? '?' : n < 950 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
    const loadFor = (d) => (d && d.modelWarmingMs > 1000) ? ` (${Math.round(d.modelWarmingMs / 1000)}s so far)` : '';

    // One fill, whole: what it faced, what it decided, and what it asked the model.
    function fillDetail(d, line) {
        const p = d.persona || {};
        const ph = d.phase || {};
        line(`  ${d.url || ''}`);
        line(`  ${d.count} field(s) in ${ms(ph.total)} · ${d.widgets || 0} widget(s) · ` +
            `${d.revealed || 0} appeared mid-fill · ${d.repaired || 0} repaired`);
        line(`  phases: ` + Object.entries(ph).map(([k, v]) => `${k} ${ms(v)}`).join(' · '));
        /* Two numbers people confuse, kept apart on purpose: when the form was
           finished, and how long the model went on improving it afterwards. */
        line(`  model: asked ${d.unresolvedCount || 0}, used ${d.aiUsed || 0}, via ${d.modelVia || 'none'}, ` +
            `request ${ms(d.modelRequestMs)}` +
            (d.modelSwitchedOff ? ', switched off in the settings' : '') +
            (d.modelWarming ? `, still loading${loadFor(d)}` : '') + (d.modelTimedOut ? ', ran past its window' : '') +
            (d.modelError ? `, error: ${d.modelError}` : ''));
        line(`  form complete in ${ms(ph.firstPass)}; ${d.upgraded || 0} field(s) upgraded over the ${ms(ph.model)} after it`);
        line('');
        line(`  Persona (seed ${p.seed}, locale ${p.locale})`);
        line(`    ${p.fullName || ''} · ${p.email || ''} · ${p.phone || ''}`);
        line(`    ${p.company || ''} · ${p.street || ''}, ${p.postal || ''} ${p.city || ''}, ${p.country || ''}`);
        line('');
        line('  Fields filled:');
        for (const f of (d.filled || [])) line(`    ${f.label}: ${f.value}  [${f.source}] ${f.why || ''}`);
        if ((d.skipped || []).length) {
            line('');
            line('  Planned but wrote nothing:');
            for (const sk of d.skipped) line(`    ${sk.label}  [${sk.type}]`);
        }
        if ((d.leftOpen || []).length) {
            line('');
            line('  Left on screen: ' + d.leftOpen.join(', '));
        }
        if ((d.notes || []).length) {
            line('');
            line('  Notes:');
            for (const n of d.notes) line(`    ${n}`);
        }
        const batches = (d.modelDebug && d.modelDebug.batches) || [];
        if (batches.length) {
            line('');
            line(`  Model prompts (${batches.length}):`);
            for (const b of batches) {
                line('');
                line(`    --- asked ${b.asked}, answered ${b.answered != null ? b.answered : 'none'}, ${b.ms} ms ---`);
                line(String(b.prompt || '').split('\n').map(x => '    ' + x).join('\n'));
                if (b.reply) {
                    line('    --- reply ---');
                    // Indented line by line: a reply that came back fenced or pretty-printed is several.
                    line(String(b.reply).split('\n').map(x => '    ' + x).join('\n'));
                }
                if (b.error) line(`    --- error: ${b.error}`);
            }
        }
    }

    function text(history, log, env) {
        const out = [];
        const line = (t) => out.push(t == null ? '' : String(t));
        line(`Fillsmith ${env.version} — report`);
        line(`${env.ua} · popup locale ${env.locale} · on-device model: ${env.model}`);
        line(`saved ${new Date().toISOString()}`);
        line('');

        line(`Recent fills (${log.length}):`);
        line('  when                  total   collect  model   first   repair  fields  ai     page');
        for (const s of log) {
            const ph = s.phase || {};
            const cell = (v, w) => String(v == null ? '?' : v).padEnd(w);
            line('  ' + cell(new Date(s.at).toISOString().slice(5, 19).replace('T', ' '), 22) +
                cell(ms(ph.total), 8) + cell(ms(ph.collect), 9) + cell(ms(ph.model), 8) +
                cell(ms(ph.firstPass), 8) + cell(ms(ph.secondPass), 8) +
                cell(`${s.filled}/${s.fields}`, 8) +
                // A dash where the model was switched off: "0/7" reads as a model that failed.
                cell((s.ai || {}).off ? '-' : `${(s.ai || {}).used || 0}/${(s.ai || {}).asked || 0}`, 7) +
                (s.title || s.url || ''));
        }

        const slow = log.flatMap(s => (s.slowest || []).map(t => ({...t, at: s.at})))
            .sort((a, b) => b.ms - a.ms).slice(0, 25);
        if (slow.length) {
            line('');
            line('Slowest controls across those fills:');
            for (const t of slow) line(`  ${String(t.ms).padStart(6)} ms  ${String(t.type || '').padEnd(14)} ${t.lib || ''}  ${t.label || ''}`);
        }

        const fills = (history || []).slice().reverse();
        line('');
        if (!fills.length) {
            line('No fill recorded in full yet.');
            return out.join('\n');
        }
        line(`${fills.length} fill(s) kept in full, newest first.`);
        fills.forEach((d, i) => {
            line('');
            line(`======== ${i + 1}/${fills.length} · ${new Date(d.at).toISOString().slice(0, 19).replace('T', ' ')}` +
                ` · ${d.title || d.url || ''} ========`);
            fillDetail(d, line);
        });
        return out.join('\n');
    }

    globalThis.FillsmithReport = {text, fillDetail, ms};
})();
