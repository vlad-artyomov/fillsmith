/* FormForge — the report page.
 *
 * A tab, not a popup: a popup closes the moment a save dialog takes focus,
 * which is why saving used to need the downloads permission. Here the browser
 * owns the page, a plain download link works, and the report can be read
 * before it is attached to anything.
 */
(function () {
    'use strict';

    const R = globalThis.FormForgeReport;
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const when = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
    const ms = R.ms;

    const ask = (msg) => new Promise(r => {
        try {
            chrome.runtime.sendMessage(msg, (v) => {
                void chrome.runtime.lastError;
                r(v || null);
            });
        } catch (_) {
            r(null);
        }
    });

    // "0 of 7" and "never asked" are different answers; a dash is the second one.
    const ai = (s) => ((s.ai || {}).off ? '—' : `${(s.ai || {}).used || 0}/${(s.ai || {}).asked || 0}`);

    function tag(source) {
        const s = String(source || '');
        const how = s.split('/')[0];
        const cls = how === 'rule' ? 'rule' : how === 'ai' ? 'ai' : '';
        return `<span class="tag ${cls}" title="${esc(s)}">${esc(how || '?')}</span>`;
    }

    function fillCard(d, i, total) {
        const p = d.persona || {};
        const ph = d.phase || {};
        const rows = (d.filled || []).map(f =>
            `<tr><td class="clip" title="${esc(f.label)}">${esc(f.label)}</td>` +
            `<td class="mono clip" title="${esc(f.value)}">${esc(f.value)}</td><td>${tag(f.source)}</td>` +
            `<td class="dim">${esc(f.why || '')}</td></tr>`).join('');
        const skipped = (d.skipped || []).map(s => `<li>${esc(s.label)} <span class="dim">${esc(s.type)}</span></li>`).join('');
        const notes = (d.notes || []).map(n => `<li>${esc(n)}</li>`).join('');
        const batches = (d.modelDebug && d.modelDebug.batches) || [];
        const model = `asked ${d.unresolvedCount || 0}, used ${d.aiUsed || 0}, via ${d.modelVia || 'none'}` +
            (d.modelSwitchedOff ? ', switched off in the settings' : '') +
            (d.modelWarming ? ', still loading' : '') + (d.modelTimedOut ? ', ran past its window' : '') +
            (d.modelError ? `, error: ${d.modelError}` : '');
        return `<details class="fill"${i === 0 ? ' open' : ''}>
  <summary>${esc(d.title || d.url || 'Untitled page')} <span class="dim">${when(d.at)} · ${d.count} field${d.count === 1 ? '' : 's'} in ${ms(ph.total)} · ${i + 1} of ${total}</span></summary>
  <div class="fill-kv">
    <div><span class="dim">${esc(d.url || '')}</span></div>
    <div><b>${esc(p.fullName || '')}</b> · ${esc(p.email || '')} · ${esc(p.phone || '')} · seed ${esc(p.seed || '')}</div>
    <div>${esc(p.company || '')} · ${esc(p.street || '')}, ${esc(p.postal || '')} ${esc(p.city || '')}, ${esc(p.country || '')}</div>
    <div>${d.widgets || 0} widget(s) · ${d.revealed || 0} appeared mid-fill · ${d.repaired || 0} repaired · form complete in ${ms(ph.firstPass)}, ${d.upgraded || 0} upgraded over the ${ms(ph.model)} after it</div>
    <div>Model: ${esc(model)}</div>
  </div>
  <table class="rp"><colgroup><col class="c-field"><col class="c-value"><col class="c-source"><col></colgroup>
  <thead><tr><th>Field</th><th>Value</th><th>Source</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table>
  ${skipped ? `<div class="fill-kv"><b>Planned but wrote nothing</b><ul>${skipped}</ul></div>` : ''}
  ${(d.leftOpen || []).length ? `<div class="fill-kv"><b>Left on screen</b>: ${esc(d.leftOpen.join(', '))}</div>` : ''}
  ${notes ? `<div class="fill-kv"><b>Notes about the page</b><ul>${notes}</ul></div>` : ''}
  ${batches.length ? `<details class="rp-prompts"><summary>Model prompts (${batches.length})</summary>${batches.map(b =>
            `<pre class="rp-pre">--- asked ${b.asked}, answered ${b.answered != null ? b.answered : 'none'}, ${b.ms} ms ---\n${esc(b.prompt)}` +
            (b.reply ? `\n--- reply ---\n${esc(b.reply)}` : '') + (b.error ? `\n--- error: ${esc(b.error)}` : '') + '</pre>').join('')}</details>` : ''}
</details>`;
    }

    function render(history, log) {
        const out = [];
        if (!log.length && !history.length) {
            $('body').innerHTML = '<div class="empty">No fill recorded yet. Fill a page, then come back here.</div>';
            return;
        }
        if (log.length) {
            /* Fixed columns, and every number on one line. Left to itself the
               table gave the page title as much width as it wanted and squeezed
               "12.3 s" onto two lines, so a row was three lines tall and the
               column of totals — the one thing being compared down the page —
               was the hardest thing in it to read. */
            out.push(`<section class="rp-sec"><h2>Recent fills (${log.length})</h2><table class="rp fills rows-are-lines">` +
                '<colgroup><col class="c-when"><col class="c-num" span="5"><col class="c-pair" span="2"><col></colgroup>' +
                '<thead><tr><th>When</th><th class="num">Total</th><th class="num">Reading</th><th class="num">Model</th>' +
                '<th class="num">Filling</th><th class="num">Checking</th><th class="num">Fields</th><th class="num">AI</th>' +
                '<th>Page</th></tr></thead><tbody>' +
                log.slice().reverse().map(s => {
                    const ph = s.phase || {};
                    const page = s.title || s.url || '';
                    const slow = (ph.total || 0) >= 5000;     // the row worth looking at twice
                    return `<tr><td class="when">${when(s.at)}</td>` +
                        `<td class="num${slow ? ' hot' : ''}">${ms(ph.total)}</td><td class="num">${ms(ph.collect)}</td>` +
                        `<td class="num">${ms(ph.model)}</td><td class="num">${ms(ph.firstPass)}</td><td class="num">${ms(ph.secondPass)}</td>` +
                        `<td class="num">${s.filled}/${s.fields}</td><td class="num">${ai(s)}</td>` +
                        `<td class="page" title="${esc(s.url || page)}">${esc(page)}</td></tr>`;
                }).join('') + '</tbody></table></section>');
            const slow = log.flatMap(s => (s.slowest || []).map(t => ({...t, at: s.at})))
                .sort((a, b) => b.ms - a.ms).slice(0, 15);
            if (slow.length) {
                out.push(`<section class="rp-sec"><h2>Slowest controls across those fills</h2><table class="rp rows-are-lines">` +
                    '<colgroup><col class="c-num"><col class="c-kind"><col class="c-lib"><col></colgroup>' +
                    '<thead><tr><th class="num">Took</th><th>Kind</th><th>Library</th><th>Field</th></tr></thead><tbody>' +
                    slow.map(t => `<tr><td class="num">${t.ms} ms</td><td>${esc(t.type || '')}</td><td>${esc(t.lib || '')}</td>` +
                        `<td class="page" title="${esc(t.label || '')}">${esc(t.label || '')}</td></tr>`).join('') +
                    '</tbody></table></section>');
            }
        }
        const fills = history.slice().reverse();
        out.push(`<section class="rp-sec"><h2>${fills.length} fill${fills.length === 1 ? '' : 's'} kept in full, newest first</h2>` +
            fills.map((d, i) => fillCard(d, i, fills.length)).join('') + '</section>');
        $('body').innerHTML = out.join('');
    }

    async function load() {
        const got = await new Promise(r => chrome.storage.local.get({fillLog: [], fillHistory: []}, (v) => {
            void chrome.runtime.lastError;
            r(v || {});
        }));
        const status = await ask({kind: 'nano-status'});
        const env = {
            version: chrome.runtime.getManifest().version,
            ua: (navigator.userAgent.match(/Chrome\/[\d.]+/) || ['Chrome ?'])[0] + ' on ' + navigator.platform,
            locale: chrome.i18n && chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : navigator.language,
            model: (status && status.status) || 'unknown'
        };
        $('env').textContent = `FormForge ${env.version} · ${env.ua} · model: ${env.model}`;
        render(got.fillHistory || [], got.fillLog || []);

        const text = () => R.text(got.fillHistory || [], got.fillLog || [], env);
        const name = () => `formforge-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
        $('download').addEventListener('click', () => {
            const url = URL.createObjectURL(new Blob([text()], {type: 'text/plain'}));
            const a = document.createElement('a');
            a.href = url;
            a.download = name();
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
        });
        $('copy').addEventListener('click', async () => {
            const btn = $('copy');
            try {
                await navigator.clipboard.writeText(text());
                btn.textContent = 'Copied';
            } catch (_) {
                btn.textContent = 'Could not copy';
            }
            setTimeout(() => (btn.textContent = 'Copy as text'), 1800);
        });
    }

    document.addEventListener('DOMContentLoaded', load);
})();
