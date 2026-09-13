const $ = (id) => document.getElementById(id);
/* Read from the generator rather than restated here: a second copy of this
 * list is a second place to forget, which is how the popup went on offering a
 * UK locale the generator had stopped shipping. */
const localeOptions = () => {
  const G = globalThis.FormForgeGen;
  const out = {};
  for (const [k, v] of Object.entries((G && G.LOCALES) || {})) out[k] = v.label || k;
  return Object.keys(out).length ? out : { 'en-US': 'English' };
};
const KEYS = ['locale', 'seed', 'seedPinned', 'emailDomain', 'modelTimeout', 'useAI', 'overwrite', 'plusTag', 'backend', 'provider', 'apiKey', 'model'];

const randomSeed = () => globalThis.FormForgeGen.newSeed();

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ------------------------------------------------------------ data ---- */
/* Every fill invents a fresh, self-consistent set of values: the email follows
 * the name, the postcode follows the city, the phone follows the country. That
 * coherence is what a seeded generator buys, and it is the whole reason one
 * exists here — but it is machinery, not a decision, so the popup neither shows
 * it nor asks about it. Settings can pin a value to repeat a fill exactly,
 * which is what you want when reproducing a bug rather than finding one. */
let currentSeed = randomSeed();

function fixedSeed() {
  const el = $('seed');
  return el ? el.value.trim() : '';
}

function nextData() {
  currentSeed = fixedSeed() || randomSeed();
}

/* ------------------------------------------------------------ tabs ---- */
const PANES = { fill: 'paneFill', settings: 'paneSettings', debug: 'paneDebug' };
const TABS = { fill: 'tabFill', settings: 'tabSettings', debug: 'tabDebug' };

function showTab(which) {
  for (const [name, tab] of Object.entries(TABS)) {
    const on = name === which;
    $(tab).classList.toggle('is-active', on);
    $(tab).setAttribute('aria-selected', String(on));
    $(PANES[name]).hidden = !on;
  }
  if (which === 'debug') renderDebug();
}

/* ------------------------------------------------------------ load ---- */
async function load() {
  for (const [k, v] of Object.entries(localeOptions())) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v;
    $('locale').appendChild(o);
  }
  const s = await chrome.storage.local.get(KEYS);
  $('locale').value = s.locale || 'en-US';
  /* Only a seed the user deliberately pinned counts. Earlier builds kept the
   * seed on the main pane and wrote it to storage on every change, so an
   * upgraded profile arrives with one set — which silently turns off the "new
   * data every fill" default and makes every fill identical. */
  $('seed').value = s.seedPinned ? (s.seed || '') : '';
  if (s.seed && !s.seedPinned) chrome.storage.local.set({ seed: '' });
  currentSeed = fixedSeed() || randomSeed();
  $('emailDomain').value = s.emailDomain || 'example.com';
  $('modelTimeout').value = String(s.modelTimeout || 0);
  $('useAI').checked = s.useAI !== false;
  $('overwrite').checked = s.overwrite !== false;
  $('plusTag').checked = s.plusTag !== false;
  $('backend').value = s.backend || 'ondevice-first';
  $('provider').value = s.provider || '';
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || '';
  save();

  /* A popup is a fresh page every time. Put the last result back so closing it
   * does not throw away the answer to "what did it just do". */
  chrome.storage.local.get(['lastFill'], ({ lastFill }) => {
    if (!lastFill || !lastFill.filled) return;
    if ($('result').innerHTML) return;          // a fresh fill has already rendered
    const note = lastFill.aiUsed ? `${lastFill.aiUsed} from model`
               : lastFill.modelTimedOut ? 'model too slow — rules used' : 'rules only';
    panel(`Last fill · ${lastFill.count} field${lastFill.count === 1 ? '' : 's'}`, note,
      rows(lastFill.filled),
      `${esc(lastFill.persona ? lastFill.persona.fullName : '')} · ${ago(lastFill.at)} · ` +
      `<a href="#" id="toDebug">why?</a>`);
    const link = $('toDebug');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); showTab('debug'); });
  });

  /* Opening the popup means a fill is likely. Get the page ready now — both
   * are fire-and-forget, and the fill works whether or not they finished. */
  tabId().then(id => {
    if (id != null) chrome.runtime.sendMessage({ kind: 'inject', tabId: id }, () => void chrome.runtime.lastError);
  });
  chrome.runtime.sendMessage({ kind: 'nano-warm' }, () => void chrome.runtime.lastError);

  chrome.runtime.sendMessage({ kind: 'nano-status' }, (res) => {
    const pill = $('status');
    const text = $('statusText');
    const status = res && res.status;
    if (status === 'available') {
      pill.className = 'pill ok';
      text.textContent = 'model ready';
      pill.title = 'Gemini Nano answers the fields no rule recognises.';
      return;
    }
    if (status === 'downloadable' || status === 'downloading') {
      // Never auto-download: create() blocks until several GB have arrived,
      // which would stall the first fill. Make it a deliberate click.
      pill.className = 'pill warn';
      text.textContent = 'model not downloaded';
      pill.title = 'Rules fill every recognised field meanwhile.';
      const btn = document.createElement('button');
      btn.className = 'btn wide';
      btn.textContent = 'Download on-device model (one-time, ~2 GB)';
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Downloading… you can keep filling meanwhile';
        chrome.runtime.sendMessage({ kind: 'nano-download' }, (r) => {
          btn.textContent = r && r.ok ? 'Model ready' : 'Download failed';
          if (r && r.ok) { pill.className = 'pill ok'; text.textContent = 'model ready'; }
        });
      });
      $('advanced').before(btn);
      return;
    }
    pill.className = 'pill warn';
    text.textContent = 'rules only';
    pill.title = 'No on-device model in this Chrome. Rules still fill every recognised field.';
  });
}

function settings() {
  return {
    locale: $('locale').value,
    seed: fixedSeed() || currentSeed,
    emailDomain: $('emailDomain').value.trim() || 'example.com',
    modelTimeout: Number($('modelTimeout').value) || 0,
    useAI: $('useAI').checked,
    overwrite: $('overwrite').checked,
    plusTag: $('plusTag').checked,
    backend: $('backend').value,
    provider: $('provider').value,
    apiKey: $('apiKey').value,
    model: $('model').value.trim()
  };
}

function save() {
  // Store the pinned seed as typed — writing the rolled one back would make
  // today's random person tomorrow's fixed one.
  chrome.storage.local.set(Object.assign(settings(), {
    seed: fixedSeed(),
    seedPinned: fixedSeed() !== ''
  }));
}

async function tabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

async function dispatch(kind, extra) {
  const id = await tabId();
  if (id == null) return;
  const msg = { kind, settings: Object.assign(settings(), extra || {}) };
  try {
    return await chrome.tabs.sendMessage(id, msg);
  } catch (_) {
    /* Nothing is injected until it is wanted. The background owns the file
     * list — asking it is what keeps there from being a second copy here. */
    const r = await chrome.runtime.sendMessage({ kind: 'inject', tabId: id });
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'could not inject' };
    return await chrome.tabs.sendMessage(id, msg);
  }
}

/* ---------------------------------------------------------- results ---- */
function panel(title, note, bodyHtml, footHtml) {
  const box = $('result');
  box.hidden = false;
  box.classList.remove('is-live');
  box.innerHTML =
    `<div class="result-head"><span class="result-title">${esc(title)}</span>` +
    `<span class="result-note">${esc(note || '')}</span></div>` +
    bodyHtml +
    (footHtml ? `<div class="result-foot">${footHtml}</div>` : '');
}

function message(text) {
  panel('FormForge', '', `<div class="empty">${esc(text)}</div>`);
}

/* A value's source is the first thing worth knowing when a field looks wrong:
   a rule matched, the type decided, the model guessed, or nothing did. On a
   dry run there is no value yet, so the adapter that claimed the control is
   the interesting half instead. */
function sourceTag(source) {
  const s = String(source || '');
  if (s === 'native') return '<span class="tag">native</span>';
  if (s.startsWith('widget/')) {
    const lib = s.slice('widget/'.length) || 'widget';
    return `<span class="tag widget" title="${esc(lib)}">${esc(lib.replace(/^primevue-/, ''))}</span>`;
  }
  const [how, lib] = s.split('/');
  const cls = how === 'rule' ? 'rule' : how === 'ai' ? 'ai' : '';
  return `<span class="tag ${cls}" title="${esc(lib ? how + ' · ' + lib : how)}">${esc(how || '?')}</span>`;
}

function rows(items) {
  if (!items.length) return '<div class="empty">Nothing to show.</div>';
  return '<div class="rows">' + items.map(f =>
    `<div class="row"><span class="k" title="${esc(f.label)}">${esc(f.label)}</span>` +
    `<span class="v" title="${esc(f.value)}">${esc(f.value)}</span>${sourceTag(f.source)}</div>`
  ).join('') + '</div>';
}

function report(res) {
  if (!res || !res.ok) return message(res && res.error ? res.error : 'No reachable form on this page.');
  if (res.count === 0 && !(res.filled || []).length) {
    return message(res.persona ? 'No fillable fields found on this page.' : 'Nothing to clear.');
  }
  const p = res.persona;
  if (!p) return panel(`${res.count} field${res.count === 1 ? '' : 's'} cleared`, '', '');

  /* "rules only" is true when the model was never needed and misleading when it
   * was asked and did not answer — which looks identical from the outside. */
  const note = res.aiUsed ? `${res.aiUsed} from model`
             : res.modelWarming ? 'model still loading — rules used'
             : res.modelTimedOut ? 'model too slow — rules used'
             : 'rules only';
  let foot = `${p.fullName} · seed <b style="color:var(--accent)">${esc(p.seed)}</b>`;
  if (res.widgets) foot += ` · ${res.widgets} widget${res.widgets === 1 ? '' : 's'}`;
  const skipped = res.skipped || [];
  if (skipped.length) {
    foot += `<br><b>${skipped.length} planned but wrote nothing</b> — ` +
      esc(skipped.slice(0, 3).map(s => s.label).join(', ')) + (skipped.length > 3 ? '…' : '');
  }
  panel(`Filled ${res.count} field${res.count === 1 ? '' : 's'}`, note, rows(res.filled || []), foot);
}

/* ------------------------------------------------------------ debug ---- */
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

function section(title, body) {
  return `<div class="dbg-sec"><div class="dbg-h">${esc(title)}</div>${body}</div>`;
}

function renderDebug() {
  const box = $('debugBody');
  chrome.storage.local.get(['lastFill'], ({ lastFill }) => {
    if (!lastFill) {
      box.innerHTML = '<div class="empty">Nothing filled yet. Fill a page and the whole decision trail lands here.</div>';
      return;
    }
    /* A fill that gave up waiting recorded only that it gave up. The worker
     * kept generating, so what the model was about to say usually exists by
     * the time anybody opens this tab — and "it answered 400ms after we
     * stopped waiting" is a far more actionable thing to read than "ran out
     * of time". Collect it, and say plainly that it arrived late. */
    if (lastFill.modelDebug && lastFill.modelDebug.pending) {
      chrome.runtime.sendMessage({ kind: 'last-exchange' }, (res) => {
        void chrome.runtime.lastError;
        // The worker answers in an envelope; the exchange is inside it.
        const late = res && res.exchange;
        if (late && late.at >= lastFill.modelDebug.at) {
          lastFill.modelDebug = Object.assign({}, late, {
            note: `${lastFill.modelDebug.note}; the model finished afterwards`
          });
        } else {
          lastFill.modelDebug = Object.assign({}, lastFill.modelDebug, { pending: false });
        }
        drawDebug(box, lastFill);
      });
      return;
    }
    drawDebug(box, lastFill);
  });
}

const fmtMs = (ms) => (ms < 950 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

/* Where the time went, to scale. The model was once blamed for a 16-second
 * fill it had contributed 9ms to — a list of raw millisecond counts under the
 * variable names they happen to be stored as does not make that obvious, and a
 * bar does. Only the four phases that partition the run are drawn; `recollect`
 * and `modelLate` are counted *inside* secondPass, so adding them to the bar
 * would total more than the fill took. */
const PHASES = [
  ['collect', 'Reading the form', 'p-read'],
  ['model', 'Asking the model', 'p-model'],
  ['firstPass', 'Filling', 'p-fill'],
  ['secondPass', 'Repairing and revealing', 'p-repair']
];

function timingBar(ph) {
  const parts = PHASES.map(([k, name, cls]) => ({ name, cls, ms: Math.max(0, ph[k] || 0) }))
    .filter(p => p.ms > 0);
  const sum = parts.reduce((n, p) => n + p.ms, 0) || 1;
  const bar = parts.map(p =>
    `<span class="${p.cls}" style="width:${(p.ms / sum * 100).toFixed(2)}%" ` +
    `title="${esc(p.name)} — ${fmtMs(p.ms)}"></span>`).join('');
  const legend = parts.map(p =>
    `<div class="tm-row"><span class="tm-key ${p.cls}"></span>` +
    `<span class="tm-name">${esc(p.name)}</span>` +
    `<span class="tm-ms">${fmtMs(p.ms)}</span></div>`).join('');
  /* The two that sit inside a phase rather than beside it. Worth naming: a
   * second pass that is mostly re-reading the page is a different problem from
   * one that is mostly writing to it. */
  const inner = [['recollect', 'of which, re-reading the page'],
                 ['modelLate', 'of which, asking the model again']]
    .filter(([k]) => ph[k]).map(([k, name]) =>
      `<div class="tm-row tm-sub"><span class="tm-key"></span>` +
      `<span class="tm-name">${esc(name)}</span><span class="tm-ms">${fmtMs(ph[k])}</span></div>`).join('');
  return `<div class="tm-bar">${bar}</div><div class="tm-legend">${legend}${inner}</div>`;
}

function drawDebug(box, d) {
  const out = [];

  out.push(section('Last fill', `<div class="dbg-kv">
    <div><b>${d.count}</b> fields · ${d.widgets} widgets · ${d.revealed} revealed · ${d.repaired} repaired</div>
    <div>${esc(d.title || '')}</div>
    <div class="dim">${ago(d.at)} · ${esc(d.persona ? d.persona.fullName : '')} · seed ${esc(d.persona ? d.persona.seed : '')}</div>
  </div>`));

  out.push(section(`Where the ${fmtMs((d.phase || {}).total || 0)} went`, timingBar(d.phase || {})));

  // The model: asked or not, and what came of it.
  const m = d.modelDebug;
  const head = !d.modelAsked ? 'Not consulted — every field was answered by the rules'
    : d.modelWarming ? `Still loading when this fill ran — the first use after a reload pays for it`
    : d.modelTimedOut ? `Asked for ${d.unresolvedCount} field(s), ran out of time`
    : d.aiUsed ? `Answered ${d.aiUsed} of ${d.unresolvedCount} field(s) · via ${esc(d.modelVia || '?')}`
    : `Asked for ${d.unresolvedCount} field(s), answered none`;
  let modelBody = `<div class="dbg-kv"><div>${esc(head)}</div>`;
  if (m && m.sessionMs != null) modelBody += `<div class="dim">session ready in ${m.sessionMs}ms</div>`;
  if (m && m.note) modelBody += `<div class="dim">${esc(m.note)}</div>`;
  modelBody += '</div>';
  if (m && m.context) {
    modelBody += `<div class="dim" style="margin-top:6px">Page context sent:</div><pre class="dbg-pre">` +
      esc(Object.entries(m.context).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n') || '(none)') +
      (m.examples && m.examples.length ? `\nexisting entries: ${esc(m.examples.join(', '))}` : '') + '</pre>';
  }
  for (const b of (m && m.batches) || []) {
    modelBody += `<details class="dbg-det"><summary>Prompt — ${b.asked || '?'} field(s), ` +
      `${b.answered != null ? b.answered + ' answered' : 'failed'}, ${b.ms}ms</summary>` +
      `<pre class="dbg-pre">${esc(b.prompt)}</pre>` +
      (b.reply ? `<div class="dim">Reply</div><pre class="dbg-pre">${esc(b.reply)}</pre>` : '') +
      (b.error ? `<div class="dim">Error</div><pre class="dbg-pre">${esc(b.error)}</pre>` : '') +
      `</details>`;
  }
  out.push(section('Model', modelBody));

  // Every field, with the reason it got what it got.
  const rows = (d.filled || []).map(f =>
    `<div class="dbg-row"><div class="dbg-row-h"><span class="k">${esc(f.label)}</span>` +
    `<span class="v">${esc(f.value)}</span>${sourceTag(f.source)}</div>` +
    `<div class="dim why">${esc(f.why || '')}</div></div>`).join('');
  out.push(section(`Decisions (${(d.filled || []).length})`, rows || '<div class="empty">none</div>'));

  /* Reported here rather than through console.warn, which lands in the
   * extension's own error list and reads as a crash in FormForge to whoever
   * finds it there. It is a note about the page, and this is where somebody
   * looking for one will look. */
  if ((d.notes || []).length) {
    out.push(section(`Notes about the page (${d.notes.length})`,
      '<div class="dbg-kv">' + d.notes.map(n => `<div class="dim">${esc(n)}</div>`).join('') +
      '</div>'));
  }

  if ((d.leftOpen || []).length) {
    out.push(section(`Still on screen afterwards (${d.leftOpen.length})`,
      '<div class="dbg-kv">' + d.leftOpen.map(c =>
        `<div class="dim">${esc(c)}</div>`).join('') +
      '<div class="dim">A panel FormForge opened and could not close. Anything the ' +
      'page already had up before the fill is not counted.</div></div>'));
  }

  if ((d.skipped || []).length) {
    out.push(section(`Planned but wrote nothing (${d.skipped.length})`,
      d.skipped.map(s => `<div class="dbg-row"><div class="dbg-row-h"><span class="k">${esc(s.label)}</span>` +
        `<span class="v dim">${esc(s.type)} ${esc(s.lib || '')}</span></div></div>`).join('')));
  }

  box.innerHTML = out.join('');
}

/* ------------------------------------------------------ live activity ---- */
/* What the fill is doing, as it does it. A disabled button reading "Filling…"
   for three seconds tells you nothing about whether anything is happening, and
   the interesting part — how many fields there are, how many the model was
   asked about, which one it is on now — is already being computed. One row per
   stage, updated in place: the same stage reported forty times with a moving
   count is a line that counts up, not forty lines of noise.

   Every line here is something that actually happened. There is no pool of
   plausible-sounding phrases: a fill has real stages with real numbers, and
   inventing activity to look busy would make the one honest signal in the
   window — "is it stuck?" — worthless. */
const STAGES = ['read', 'model', 'fill', 'repair', 'done'];
let stream = [];

function renderStream() {
  const box = $('result');
  box.hidden = false;
  box.classList.add('is-live');
  const rows = stream.map((s, i) => {
    const last = i === stream.length - 1;
    const active = last && s.stage !== 'done';
    const detail = s.total != null && s.done != null
      ? `${s.done}/${s.total}` : (s.detail || '');
    return `<div class="act ${active ? 'is-now' : 'is-done'}">` +
      `<span class="act-dot"></span>` +
      `<span class="act-text">${esc(s.text)}</span>` +
      `<span class="act-num">${esc(detail)}</span></div>` +
      (active && s.label ? `<div class="act-sub">${esc(s.label)}</div>` : '');
  }).join('');
  box.innerHTML = `<div class="act-list">${rows}</div>`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.kind !== 'fill-progress' || !msg.step) return;
  const s = msg.step;
  const prev = stream[stream.length - 1];
  if (prev && prev.stage === s.stage) stream[stream.length - 1] = s;
  else if (!prev || STAGES.indexOf(s.stage) >= STAGES.indexOf(prev.stage)) stream.push(s);
  else return;                      // a stale message from a finished run
  renderStream();
  if ($('fill').disabled) $('fill').textContent = s.text;
});

/* Whether the model will actually answer, as opposed to merely being reported
   as available — the two came apart badly enough to be worth a button. */
function renderModelCheck(r) {
  const box = $('modelCheck');
  if (!r) { box.innerHTML = '<div class="dim" style="margin:8px 0">Asking the model…</div>'; return; }
  const rows = [];
  const line = (k, v) => rows.push(`<div><span class="dim">${esc(k)}</span> ${esc(v)}</div>`);
  line('availability', r.availability || '—');
  line('session', r.hasSession ? `reused, ${Math.round((r.sessionAgeMs || 0) / 1000)}s old` : 'built for this check');
  if (r.buildMs != null) line('build', `${r.buildMs}ms`);
  if (r.inputQuota) line('input quota', `${r.inputUsage ?? '?'} of ${r.inputQuota} used`);
  if (r.replyMs != null) line('round trip', `${r.replyMs}ms`);
  if (r.value) line('it answered', `"${r.value}"`);
  if (r.error) line('error', r.error);
  if (r.note) line('note', r.note);
  /* Three outcomes, not two: a model that answers slowly is working, and
     saying so is more useful than a red word. */
  const verdict = !r.ok
    ? '<b style="color:var(--warn)">Not answering</b>'
    : (r.replyMs > 3000)
      ? '<b style="color:var(--warn)">Answering slowly</b>'
      : '<b style="color:var(--accent)">Answering</b>';
  box.innerHTML = `<div class="dbg-sec" style="margin-top:10px"><div class="dbg-h">Model check</div>` +
    `<div class="dbg-kv">${verdict}${rows.join('')}</div>` +
    (r.reply ? `<pre class="dbg-pre">${esc(r.reply)}</pre>` : '') + `</div>`;
}

$('checkModel').addEventListener('click', () => {
  renderModelCheck(null);
  const t0 = Date.now();
  chrome.runtime.sendMessage({ kind: 'nano-check' }, (r) => {
    renderModelCheck(r || { ok: false, error: String((chrome.runtime.lastError || {}).message || 'no answer'),
                            replyMs: Date.now() - t0 });
  });
});

/* ------------------------------------------------------------ wiring ---- */
document.addEventListener('DOMContentLoaded', load);
document.addEventListener('change', save);
document.addEventListener('input', save);

$('tabFill').addEventListener('click', () => showTab('fill'));
$('tabSettings').addEventListener('click', () => showTab('settings'));
$('tabDebug').addEventListener('click', () => showTab('debug'));

// Only meaningful alongside a pinned value: gives a different one to pin.
$('reseed').addEventListener('click', () => {
  $('seed').value = randomSeed();
  save();
});

async function withBusy(btn, label, fn) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = was; }
}

/* Fill, then move on to the next set of values, so pressing Fill again gives
 * different data rather than rewriting the same thing. */
$('fill').addEventListener('click', () => withBusy($('fill'), 'Starting…', async () => {
  stream = [];
  renderStream();
  report(await dispatch('fill'));
  nextData();
}));

$('clear').addEventListener('click', async () => report(await dispatch('clear')));

/* Dry run: what would be filled, and which widget adapter claimed each
 * control. The fastest way to find out why a field on a real app was
 * skipped or mis-typed. */
$('scan').addEventListener('click', () => withBusy($('scan'), 'Scanning…', async () => {
  const res = await dispatch('scan');
  if (!res || !res.ok) return message('Could not reach this page.');
  console.log('[FormForge] scan', res);

  const fields = res.fields || [];
  const widgets = fields.filter(f => f.kind === 'widget');
  const items = fields.map(f => ({
    label: (f.label || '').split('|')[0].trim() || '‹no label›',
    value: f.type,
    source: f.kind === 'widget' ? `widget/${f.lib}` : 'native'
  }));

  let foot = `${widgets.length} widget${widgets.length === 1 ? '' : 's'}, ` +
    `${fields.length - widgets.length} native`;
  const unlabelled = fields.filter(f => !f.label).length;
  if (unlabelled) foot += ` · <b>${unlabelled} with no label</b>`;
  const hidden = (res.hidden || []).length;
  // Nearly always a shut accordion or an inactive tab, not a broken adapter.
  if (hidden) foot += `<br>${hidden} present but not fillable right now`;

  panel(`${res.count} fillable field${res.count === 1 ? '' : 's'}`, 'dry run — nothing written',
    rows(items), foot);
}));
