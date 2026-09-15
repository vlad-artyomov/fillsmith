/* FormForge — service worker.
 *
 * Owns two things: the list of files that make up the filler, and the model.
 * Chrome's on-device Gemini Nano is tried first (no network, no key), then an
 * optional user-supplied API key. Filling never depends on either: with no
 * model the content script's rules fill everything.
 */

/* The filler, in load order. Everything that injects it — the popup, the
 * commands, the test suites — reads this list, so adding a file is one line. */
const FILLER_FILES = [
    'src/dom.js',
    'src/vocab.js',
    'src/generator.js',
    'src/adapters.js',
    'src/overlays.js',
    'src/fillers.js',
    'src/uploads.js',
    'src/hud.js',
    'src/content.js'
];

const newSeed = () => Math.random().toString(36).slice(2, 8).toUpperCase();
// Storage that may be unavailable and callbacks nobody listens to share one no-op.
const ignore = () => {
};

// ------------------------------------------------------------ worker health ----
/* A popup that hears "message port closed" cannot tell a crashed worker from a
 * slow one. Session storage outlives the worker, so it keeps the start time,
 * the last uncaught errors and the stage a running check has reached; the popup
 * reads them back when an answer fails to arrive. */
const scratch = chrome.storage.session || chrome.storage.local;
const startedAt = Date.now();
const workerErrors = [];

function noteWorkerError(text) {
    workerErrors.push({at: Date.now(), text: String(text).slice(0, 300)});
    while (workerErrors.length > 5) workerErrors.shift();
    scratch.set({workerErrors}).catch(ignore);
}

self.addEventListener('error', e => noteWorkerError(e.message || e.error || 'error'));
self.addEventListener('unhandledrejection', e => noteWorkerError((e.reason && e.reason.message) || e.reason || 'rejection'));
scratch.set({workerStartedAt: startedAt}).catch(ignore);

/* Chrome ends a worker it has seen idle for 30s, and waiting on the model is
 * not activity it counts. A cheap extension API call every 20s keeps the worker
 * up for as long as the work runs. */
async function keptAlive(promise) {
    const tick = setInterval(() => chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError), 20000);
    try {
        return await promise;
    } finally {
        clearInterval(tick);
    }
}

// ---------------------------------------------------------------- prompting ----
/* Standing instructions live in the session, so they are paid for once; the
 * per-call prompt carries only what changes. On a small on-device model the
 * request length is most of the latency. */
const SYSTEM_PROMPT = [
    'You invent realistic test data for QA engineers filling forms on their own staging sites.',
    'Given form fields, return one believable value each. Data only, never commentary.',
    'Match the persona given (same person, company, country) and the page language.',
    'Infer from the label: "Project code" -> "PRJ-2481", not a name.',
    'Obey stated limits: maxLength, min, max, pattern. If options are listed, copy one verbatim.',
    'HTML (<p>, <strong>, <em>, <ul><li>) only where a field says html.',
    'Never output: test, asdf, lorem ipsum, string, N/A, example, or leading/trailing spaces.'
].join('\n');

/* The languages a fill can ask for and answer in. Declaring them is what makes
 * Chrome load the right weights: undeclared, a German form gets English values
 * back, or a refusal. Keep in step with LOCALES in generator.js. */
const LANGUAGES = ['en', 'de'];

const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        values: {
            type: 'array',
            items: {
                type: 'object',
                properties: {id: {type: 'integer'}, value: {type: 'string'}},
                required: ['id', 'value']
            }
        }
    },
    required: ['values']
};

/* The schema constrains the decoder without being spelled out to the model:
 * on a small on-device model the prompt length is most of the latency, and the
 * shape is already stated in the last line of every prompt. */
const CONSTRAIN = {responseConstraint: RESPONSE_SCHEMA, omitResponseConstraintInput: true};

const BATCH = 12;

function buildUserPrompt(persona, pageTitle, fields, context, examples) {
    const c = context || {};
    const lines = [];
    // One context line, most specific first: a dialog's title beats the breadcrumb beats the page title.
    const where = c.dialog || c.heading || c.breadcrumb || c.title || pageTitle;
    if (where) lines.push(`Form: ${where}`);
    if (examples && examples.length) {
        lines.push(`Similar existing values: ${examples.slice(0, 3).map(e => `"${e}"`).join(', ')}`);
    }
    lines.push(`Persona: ${persona.fullName}, ${persona.company}, ${persona.city} ${persona.country}`);
    lines.push('');
    for (const f of fields) {
        const bits = [`${f.id}`, f.type];
        const label = String(f.label || '').split('|')[0].replace(/\s+/g, ' ').trim().slice(0, 60);
        bits.push(`"${label}"`);
        if (f.section) bits.push(`in "${String(f.section).slice(0, 40)}"`);
        if (f.required) bits.push('required');
        if (f.maxLength) bits.push(`max${f.maxLength}`);
        if (f.min != null || f.max != null) bits.push(`${f.min ?? ''}..${f.max ?? ''}`);
        if (f.pattern) bits.push(`pattern ${String(f.pattern).slice(0, 30)}`);
        if (f.richText) bits.push('html');
        if (f.options && f.options.length) {
            bits.push(`one of: ${f.options.slice(0, 12).map(o => `"${String(o).slice(0, 30)}"`).join(', ')}`);
        }
        lines.push(bits.join(' '));
    }
    /* One entry per field in the skeleton, never a single {"id":N}. The schema
     * is deliberately not spelled out to the model (omitResponseConstraintInput
     * keeps the prompt short), so this line is the only shape it ever sees — and
     * it copies that shape literally. A one-entry example got exactly one value
     * back for a batch of twelve, and the other eleven fields fell through to
     * the filler with "the model had no answer for it". */
    const ids = fields.map(f => f.id);
    lines.push('', `Answer all ${ids.length} field${ids.length === 1 ? '' : 's'}, one entry each, in this order: ${ids.join(', ')}`);
    lines.push(`JSON: {"values":[${ids.map(id => `{"id":${id},"value":"..."}`).join(',')}]}`);
    return lines.join('\n');
}

function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

/* Line the reply up with what was asked. Small models renumber ids, so an id
 * we recognise is honoured and anything else is matched by position. */
function parseValues(text, asked) {
    const out = {};
    if (!text) return out;
    let data = null;
    try {
        data = JSON.parse(text);
    } catch (_) {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                data = JSON.parse(m[0]);
            } catch (_) { /* unparseable */
            }
        }
    }
    if (!data) return out;
    const list = Array.isArray(data) ? data : data.values;
    if (!Array.isArray(list)) return out;

    const items = list.filter(x => x && typeof x.value === 'string');
    const ids = (asked || []).map(f => String(f.id));
    const known = new Set(ids);
    const clean = (v) => v.trim().slice(0, 2000);
    let positional = 0;
    for (const item of items) {
        const id = item.id == null ? null : String(item.id);
        if (id !== null && known.has(id)) {
            out[id] = clean(item.value);
            continue;
        }
        while (positional < ids.length && out[ids[positional]] !== undefined) positional++;
        if (positional < ids.length) out[ids[positional++]] = clean(item.value);
    }
    return out;
}

// ----------------------------------------------------------- on-device model ----
function nanoGlobal() {
    return (typeof LanguageModel !== 'undefined' && LanguageModel) || (self.ai && self.ai.languageModel) || null;
}

async function nanoStatus() {
    const LM = nanoGlobal();
    if (!LM) return 'unsupported';
    try {
        /* Asked without the language hints on purpose: a build with no German
         * weights answers "unavailable" for them and would read here as "no
         * model at all", when an English session is there and works. Which
         * languages are actually on hand is create()'s problem. */
        if (typeof LM.availability === 'function') return await LM.availability();
        if (typeof LM.capabilities === 'function') {
            const c = await LM.capabilities();
            return c.available === 'readily' ? 'available' : c.available === 'after-download' ? 'downloadable' : 'unavailable';
        }
    } catch (_) { /* fall through */
    }
    return 'unsupported';
}

let nanoSession = null;
let nanoPending = null;         // the build in flight, so three callers share one
let nanoBuilding = false;
let nanoBuildStarted = 0;
let sessionBuiltAt = 0;
let downloading = false;

async function buildSession(LM, withMonitor) {
    const opts = {
        initialPrompts: [{role: 'system', content: SYSTEM_PROMPT}],
        expectedInputs: [{type: 'text', languages: LANGUAGES}],
        expectedOutputs: [{type: 'text', languages: LANGUAGES}]
    };
    if (withMonitor) {
        opts.monitor = (m) => m.addEventListener('downloadprogress', e => {
            chrome.storage.local.set({nanoDownloadProgress: Math.round((e.loaded || 0) * 100)});
        });
    }
    // An older build of the API rejects the modality hints rather than ignoring them.
    const session = await LM.create(opts).catch(() => LM.create({initialPrompts: opts.initialPrompts}));
    sessionBuiltAt = Date.now();
    return session;
}

/* Only touch the model when it is already on disk: create() on a downloadable
 * model starts a multi-gigabyte download and does not settle until it ends.
 * The download is opt-in from the popup. */
async function nanoSessionGet({allowDownload = false} = {}) {
    const LM = nanoGlobal();
    if (!LM) return null;
    if (nanoSession) return nanoSession;
    if (nanoPending) return nanoPending;

    nanoBuilding = true;
    nanoBuildStarted = Date.now();
    nanoPending = (async () => {
        const status = await nanoStatus();
        if (status === 'available') {
            nanoSession = await buildSession(LM, false);
            return nanoSession;
        }
        if (!allowDownload || downloading) return null;
        downloading = true;
        try {
            nanoSession = await buildSession(LM, true);
            return nanoSession;
        } finally {
            downloading = false;
        }
    })();
    try {
        return await nanoPending;
    } finally {
        nanoPending = null;
        nanoBuilding = false;
    }
}

// The first create() after a browser start brings the model into memory; begin it before anyone presses Fill.
function warmOnStart() {
    nanoSessionGet({allowDownload: false}).catch(ignore);
}

chrome.runtime.onInstalled.addListener(warmOnStart);
chrome.runtime.onStartup.addListener(warmOnStart);

// A session remembers every prompt; each batch runs on a clone that starts from the system prompt alone.
async function statelessSession(session) {
    if (!session || typeof session.clone !== 'function') return {s: session, temporary: false};
    try {
        return {s: await session.clone(), temporary: true};
    } catch (_) {
        return {s: session, temporary: false};
    }
}

// The last exchange with the model, for the popup's Debug tab.
let lastExchange = null;

const PROMPT_HEADROOM_MS = 2500;

async function generateOnDevice(persona, pageTitle, fields, context, examples, opts) {
    const {sessionWaitMs = 0, tabId = null, fieldCount = 0} = opts || {};
    const tSession = Date.now();
    let session = nanoSession;
    if (!session) {
        // The caller says how long it will wait for the model to come up, separately from the answer.
        const wanted = nanoSessionGet({allowDownload: false});
        session = await Promise.race([
            wanted,
            new Promise(r => setTimeout(() => r(null), Math.max(1200, sessionWaitMs || PROMPT_HEADROOM_MS)))
        ]);
        wanted.catch(ignore);
        if (session && tabId != null) {
            chrome.tabs.sendMessage(tabId, {
                    kind: 'model-stage', stage: 'asking',
                    text: `Asking the model about ${fieldCount} field${fieldCount === 1 ? '' : 's'}`
                },
                () => void chrome.runtime.lastError);
        }
    }
    lastExchange.sessionMs = Date.now() - tSession;
    if (!session) {
        // "Still loading" and "no model" call for opposite advice.
        const warming = nanoBuilding || !!nanoPending;
        lastExchange.warming = warming;
        lastExchange.note = warming
            ? `the model is still loading (${Math.round((Date.now() - nanoBuildStarted) / 1000)}s so far) — the first use after a reload pays for it`
            : 'no on-device session available';
        return null;
    }
    // Batches run together: each is its own clone and shares nothing.
    const groups = chunk(fields, BATCH);
    const results = await Promise.all(groups.map(g => askBatch(session, persona, pageTitle, g, context, examples)));
    return Object.assign({}, ...results);
}

async function askBatch(session, persona, pageTitle, group, context, examples) {
    const prompt = buildUserPrompt(persona, pageTitle, group, context, examples);
    const t0 = Date.now();
    const {s: turn, temporary} = await statelessSession(session);
    let text = '';
    try {
        try {
            text = await turn.prompt(prompt, CONSTRAIN);
        } catch (_) {
            text = await turn.prompt(prompt);
        }
    } catch (err) {
        lastExchange.batches.push({prompt, error: String(err && err.message || err), ms: Date.now() - t0});
        return {};
    } finally {
        if (temporary) {
            try {
                turn.destroy();
            } catch (_) {
            }
        }
    }
    const parsed = parseValues(text, group);
    lastExchange.batches.push({
        prompt, reply: String(text || '').slice(0, 4000),
        answered: Object.keys(parsed).length, asked: group.length, ms: Date.now() - t0
    });
    return parsed;
}

// ------------------------------------------------------------ hosted models ----
const PROVIDERS = {
    anthropic: {
        model: 'claude-sonnet-5',
        request: (cfg, model, prompt) => ({
            url: 'https://api.anthropic.com/v1/messages',
            headers: {
                'x-api-key': cfg.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            // Short structured values: low effort keeps the round trip quick.
            body: {
                model, max_tokens: 4000, system: SYSTEM_PROMPT,
                output_config: {effort: 'low'},
                messages: [{role: 'user', content: prompt}]
            }
        }),
        text: (j) => (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('')
    },
    openai: {
        model: 'gpt-4o-mini',
        request: (cfg, model, prompt) => ({
            url: 'https://api.openai.com/v1/chat/completions',
            headers: {authorization: `Bearer ${cfg.apiKey}`},
            body: {
                model, response_format: {type: 'json_object'},
                messages: [{role: 'system', content: SYSTEM_PROMPT}, {role: 'user', content: prompt}]
            }
        }),
        text: (j) => j.choices?.[0]?.message?.content || ''
    },
    gemini: {
        model: 'gemini-2.0-flash',
        request: (cfg, model, prompt) => ({
            url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
            headers: {},
            body: {
                systemInstruction: {parts: [{text: SYSTEM_PROMPT}]},
                contents: [{parts: [{text: prompt}]}],
                generationConfig: {responseMimeType: 'application/json'}
            }
        }),
        text: (j) => j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || ''
    }
};

// The API's own words for what went wrong, not a status code alone.
function apiErrorText(provider, status, body) {
    const msg = body && (body.error && (body.error.message || body.error.type) || body.message);
    return `${provider} answered HTTP ${status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}`;
}

// One request to a hosted provider, parsed the way a fill parses it.
// A hosted call that never returns must still end: the fill has a budget, and a check must reach a verdict.
let REMOTE_CAP_MS = 30000;

async function remoteCall(cfg, group, prompt) {
    const provider = PROVIDERS[cfg.provider];
    const model = cfg.model || provider.model;
    const t0 = Date.now();
    const out = {model, ms: 0, status: null, text: '', parsed: {}, error: null};
    try {
        const req = provider.request(cfg, model, prompt);
        const r = await fetch(req.url, {
            method: 'POST',
            headers: Object.assign({'content-type': 'application/json'}, req.headers),
            body: JSON.stringify(req.body),
            signal: AbortSignal.timeout(REMOTE_CAP_MS)
        });
        out.status = r.status;
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(apiErrorText(cfg.provider, r.status, j));
        out.text = provider.text(j);
        out.parsed = parseValues(out.text, group);
    } catch (err) {
        out.error = err && err.name === 'TimeoutError'
            ? `no answer from ${cfg.provider} within ${Math.ceil(REMOTE_CAP_MS / 1000)}s`
            : String(err && err.message || err);
    }
    out.ms = Date.now() - t0;
    return out;
}

async function generateRemote(cfg, persona, pageTitle, fields, context, examples) {
    if (!PROVIDERS[cfg.provider]) return {values: {}, error: `unknown provider "${cfg.provider}"`};
    const values = {};
    let error = null;
    for (const group of chunk(fields, BATCH * 2)) {
        const prompt = buildUserPrompt(persona, pageTitle, group, context, examples);
        const r = await remoteCall(cfg, group, prompt);
        if (r.error) {
            error = error || r.error;
            lastExchange.batches.push({prompt, error: r.error, ms: r.ms});
            continue;
        }
        lastExchange.batches.push({
            prompt, reply: String(r.text).slice(0, 4000),
            answered: Object.keys(r.parsed).length, asked: group.length, ms: r.ms
        });
        Object.assign(values, r.parsed);
    }
    return {values, error: Object.keys(values).length ? null : error};
}

// ------------------------------------------------------------------ routing ----
async function generate(payload, tabId) {
    const {persona, pageTitle, fields, context, examples, sessionWaitMs} = payload;
    const cfg = await chrome.storage.local.get(['provider', 'apiKey', 'model', 'backend']);
    const backend = cfg.backend || 'ondevice-first';
    lastExchange = {at: Date.now(), backend, asked: fields.length, context, examples, batches: []};

    if (backend !== 'remote-only') {
        const local = await generateOnDevice(persona, pageTitle, fields, context, examples, {
            sessionWaitMs,
            tabId,
            fieldCount: fields.length
        });
        if (local && Object.keys(local).length) return {ok: true, values: local, via: 'on-device', debug: lastExchange};
        if (backend === 'ondevice-only') return {
            ok: true,
            values: {},
            via: 'none',
            warming: !!lastExchange.warming,
            debug: lastExchange
        };
    }
    if (cfg.apiKey && cfg.provider) {
        const remote = await generateRemote(cfg, persona, pageTitle, fields, context, examples);
        return {
            ok: true,
            values: remote.values,
            via: cfg.provider,
            error: remote.error || undefined,
            debug: lastExchange
        };
    }
    return {ok: true, values: {}, via: 'none', warming: !!lastExchange.warming, debug: lastExchange};
}

/* "Is the model ready?" answered with a real round trip through the same
 * prompt shape and parser a fill uses. The verdict is whether a usable value
 * came back, never whether it matched a magic word. */
async function nanoCheck(onStage = ignore) {
    const out = {at: Date.now()};
    try {
        out.availability = await nanoStatus();
        out.hasSession = !!nanoSession;
        out.sessionAgeMs = sessionBuiltAt ? Date.now() - sessionBuiltAt : null;
        out.building = !!nanoPending;

        onStage(nanoSession ? 'reusing the on-device session' : 'building an on-device session');
        const tBuild = Date.now();
        const session = await nanoSessionGet({allowDownload: false});
        out.buildMs = Date.now() - tBuild;
        if (!session) {
            out.ok = false;
            out.note = 'no session could be built';
            return out;
        }
        // Renamed with the API; the older pair is still what older Chromes report.
        out.inputUsage = session.contextUsage ?? session.inputUsage;
        out.inputQuota = session.contextWindow ?? session.inputQuota;

        const probeField = [{id: 0, type: 'text', label: 'City', required: true, maxLength: 40}];
        const probePrompt = buildUserPrompt(
            {fullName: 'Test Person', company: 'Test GmbH', city: 'Köln', country: 'Deutschland'},
            'FormForge self-check', probeField, {dialog: 'FormForge self-check'}, []);
        const {s: turn, temporary} = await statelessSession(session);
        onStage('waiting for the on-device reply');
        const t0 = Date.now();
        const reply = await turn.prompt(probePrompt, CONSTRAIN);
        out.replyMs = Date.now() - t0;
        out.reply = String(reply || '').slice(0, 200);
        if (temporary) {
            try {
                turn.destroy();
            } catch (_) {
            }
        }

        out.value = parseValues(out.reply, probeField)['0'];
        out.ok = typeof out.value === 'string' && out.value.trim() !== '';
        if (!out.ok) out.note = 'replied, but nothing usable for the field asked about';
        else if (out.replyMs > 3000) out.note = 'answering, but slowly — expect multi-second fills';
    } catch (e) {
        out.ok = false;
        out.error = String((e && e.message) || e);
    }
    return out;
}

// ---------------------------------------------------------------- injecting ----
async function injectFiller(tabId) {
    await chrome.scripting.executeScript({target: {tabId, allFrames: true}, files: FILLER_FILES});
}

/* Something on screen before the six files land: the shortcut otherwise does
 * nothing visible for a second. Draws the same element the real indicator
 * uses, which then adopts it. */
function bootIndicator() {
    if (document.getElementById('formforge-hud')) return;
    const box = document.createElement('div');
    box.id = 'formforge-hud';
    box.setAttribute('data-formforge-boot', '');
    box.setAttribute('role', 'status');
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    box.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'right:14px', 'bottom:14px',
        'display:flex', 'align-items:center', 'gap:8px', 'width:272px',
        'box-sizing:border-box', 'padding:10px 12px', 'border-radius:10px',
        `background:${dark ? '#1b2027' : '#fff'}`, `color:${dark ? '#e9ebef' : '#14171c'}`,
        `border:1px solid ${dark ? '#2c323a' : '#e2e5ea'}`,
        'font:12px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        'box-shadow:0 2px 6px rgba(16,24,40,.06),0 10px 28px rgba(16,24,40,.14)',
        'opacity:0', 'transform:translateY(6px)', 'transition:opacity .18s ease,transform .18s ease'
    ].join(';');
    const spin = document.createElement('span');
    spin.style.cssText = `flex:none;width:11px;height:11px;border-radius:50%;border:2px solid ` +
        `${dark ? '#35a377' : '#1f6f4f'};border-top-color:transparent;animation:formforge-spin .7s linear infinite`;
    const label = document.createElement('span');
    label.style.cssText = 'font-weight:600';
    label.textContent = 'Starting FormForge';
    box.append(spin, label);
    if (!document.getElementById('formforge-spin-style')) {
        const st = document.createElement('style');
        st.id = 'formforge-spin-style';
        st.textContent = '@keyframes formforge-spin{to{transform:rotate(360deg)}}';
        document.documentElement.appendChild(st);
    }
    document.documentElement.appendChild(box);
    requestAnimationFrame(() => {
        box.style.opacity = '1';
        box.style.transform = 'none';
    });
}

async function showBooting(tabId) {
    // A page the extension may not script (chrome://, the Web Store, a PDF) has the badge instead.
    try {
        await chrome.scripting.executeScript({target: {tabId}, func: bootIndicator});
    } catch (_) {
    }
}

// ------------------------------------------------------------- toolbar icon ----
/* A light passing across the mark while a fill runs. Drawn here rather than
 * shipped as PNGs; keeps the silhouette, so the icon stays recognisable at
 * sixteen pixels where a bare spinner blinks out. */
const SPIN_FRAMES = 14;
const SPIN_MS = 60;
let spinTimer = null;
let spinFrame = 0;
let spinIcons = null;
let spinTab = null;
let spinWatchdog = null;

function drawMark(g, size) {
    g.fillStyle = '#1f6f4f';
    g.beginPath();
    g.roundRect(0, 0, size, size, size * 0.19);
    g.fill();
    g.fillStyle = '#ffffff';
    for (const [x, y, w] of [[0.20, 0.26, 0.60], [0.20, 0.44, 0.60], [0.20, 0.62, 0.34]]) {
        g.beginPath();
        g.roundRect(size * x, size * y, size * w, size * 0.12, size * 0.06);
        g.fill();
    }
}

function spinnerFrames() {
    if (spinIcons) return spinIcons;
    const size = 32;
    const canvas = new OffscreenCanvas(size, size);
    const g = canvas.getContext('2d');
    spinIcons = [];
    for (let i = 0; i < SPIN_FRAMES; i++) {
        const t = i / SPIN_FRAMES;
        g.clearRect(0, 0, size, size);
        drawMark(g, size);
        g.save();
        g.beginPath();
        g.roundRect(0, 0, size, size, size * 0.19);
        g.clip();
        const x = -size + t * size * 2.6;          // off-canvas at both ends of the cycle
        const band = g.createLinearGradient(x, 0, x + size * 0.62, size);
        band.addColorStop(0, 'rgba(255,255,255,0)');
        band.addColorStop(0.5, 'rgba(255,255,255,.52)');
        band.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = band;
        g.fillRect(0, 0, size, size);
        g.restore();
        spinIcons.push(g.getImageData(0, 0, size, size));
    }
    return spinIcons;
}

function working(tabId, on) {
    try {
        chrome.action.setBadgeText({tabId, text: on ? '···' : ''});
        if (on) chrome.action.setBadgeBackgroundColor({tabId, color: '#1f6f4f'});
    } catch (_) {
    }
    if (on) startSpin(tabId); else stopSpin(tabId);
}

function startSpin(tabId) {
    if (spinTimer && spinTab === tabId) return;
    if (spinTimer) stopSpin(spinTab);
    let frames;
    try {
        frames = spinnerFrames();
    } catch (_) {
        return;
    }
    spinTab = tabId;
    spinFrame = 0;
    spinTimer = setInterval(() => {
        try {
            chrome.action.setIcon({
                tabId,
                imageData: {32: frames[spinFrame % frames.length]}
            }, () => void chrome.runtime.lastError);
        } catch (_) {
            stopSpin(tabId);
        }
        spinFrame++;
    }, SPIN_MS);
    // A page navigated away from mid-fill never reports finishing.
    clearTimeout(spinWatchdog);
    spinWatchdog = setTimeout(() => stopSpin(tabId), 90000);
}

function stopSpin(tabId) {
    if (spinTimer) {
        clearInterval(spinTimer);
        spinTimer = null;
    }
    clearTimeout(spinWatchdog);
    if (tabId == null) tabId = spinTab;
    spinTab = null;
    if (tabId == null) return;
    /* setIcon({ tabId }) alone throws rather than restoring the manifest icon,
     * and a relative path cannot be fetched from a worker: rooted paths it is. */
    try {
        chrome.action.setIcon({
                tabId,
                path: {16: '/icons/icon16.png', 24: '/icons/icon24.png', 32: '/icons/icon32.png'}
            },
            () => void chrome.runtime.lastError);
    } catch (_) {
    }
}

// ------------------------------------------------------------- entry points ----
async function activeTabId() {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    return tab ? tab.id : null;
}

// Shortcuts and context menu: indicator first, then inject on demand, then ask the tab.
async function send(kind, settings, tabId, extra) {
    const id = tabId == null ? await activeTabId() : tabId;
    if (id == null) return {ok: false, error: 'no active tab'};
    const msg = Object.assign({kind, settings}, extra || {});
    if (kind !== 'clear') await showBooting(id);
    working(id, true);
    try {
        try {
            return await chrome.tabs.sendMessage(id, msg);
        } catch (_) {
            await injectFiller(id);
            return await chrome.tabs.sendMessage(id, msg);
        }
    } catch (err) {
        // A page the extension may not script. Not an error worth a red badge on the extension card.
        return {ok: false, error: String(err && err.message || err)};
    } finally {
        working(id, false);
    }
}

const MENUS = [
    {
        id: 'ff-fill-page',
        title: 'Fill this page with test data',
        contexts: ['page', 'editable', 'selection', 'link', 'image']
    },
    // `editable` only: a Select or a switch is a div and is filled with the whole form.
    {id: 'ff-fill-field', title: 'Fill just this field', contexts: ['editable']},
    {id: 'ff-clear-page', title: 'Clear what FormForge filled', contexts: ['page', 'editable']}
];

function installMenus() {
    chrome.contextMenus.removeAll(() => {
        for (const m of MENUS) chrome.contextMenus.create(m);
    });
}

chrome.runtime.onInstalled.addListener(installMenus);
chrome.runtime.onStartup.addListener(installMenus);

const SETTINGS_KEYS = ['locale', 'seed', 'useAI', 'overwrite', 'emailDomain', 'plusTag', 'modelTimeout'];

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || tab.id == null) return;
    const s = await chrome.storage.local.get(SETTINGS_KEYS);
    if (info.menuItemId === 'ff-fill-page') await send('fill', s, tab.id);
    if (info.menuItemId === 'ff-fill-field') await send('fill-one', s, tab.id);
    if (info.menuItemId === 'ff-clear-page') await send('clear', {}, tab.id);
});

chrome.commands.onCommand.addListener(async (command) => {
    const s = await chrome.storage.local.get(SETTINGS_KEYS);
    if (command === 'fill-form') await send('fill', s);
    // A fresh seed for this fill only; storing it would pin it for every fill after.
    if (command === 'refill-form') await send('fill', Object.assign({}, s, {seed: newSeed()}));
    // The field the cursor is in, not the whole form. Pressing again gives that field a new value.
    if (command === 'fill-field') await send('fill-one', s, null, {focusFirst: true});
    if (command === 'clear-form') await send('clear', {});
});

// --------------------------------------------------------------- messaging ----
/* The whole setup, checked the way a fill would use it: which backend is
 * configured, whether the on-device model answers, and whether the hosted
 * provider accepts the key and the model name — a real round trip, with the
 * API's own error text when it does not. */
const PROBE_FIELD = [{id: 0, type: 'text', label: 'City', required: true, maxLength: 40}];
const PROBE_PERSONA = {fullName: 'Test Person', company: 'Test GmbH', city: 'Köln', country: 'Deutschland'};

async function setupCheck() {
    // Each stage is recorded before it starts, so a worker that dies mid-check leaves its last step behind.
    const stage = (name) => scratch.set({checkStage: {stage: name, at: Date.now()}}).catch(ignore);
    await stage('reading the settings');
    const cfg = await chrome.storage.local.get(['provider', 'apiKey', 'model', 'backend']);
    const backend = cfg.backend || 'ondevice-first';
    const out = {backend, provider: cfg.provider || '', model: '', ondevice: null, remote: null};

    // Bounded: a session that is still coming up must not hold the popup's port open indefinitely.
    if (backend !== 'remote-only') {
        await stage('asking the on-device model');
        out.ondevice = await keptAlive(Promise.race([
            nanoCheck(stage),
            new Promise(r => setTimeout(() => r({
                ok: false,
                note: 'no answer within 20s — the model may still be loading'
            }), 20000))
        ]));
    } else out.ondevice = {ok: false, availability: await nanoStatus(), note: 'not used with this backend'};

    if (backend !== 'ondevice-only') {
        if (!cfg.provider) out.remote = {ok: false, error: 'no provider chosen'};
        else if (!cfg.apiKey) out.remote = {ok: false, error: 'no API key entered'};
        else if (!PROVIDERS[cfg.provider]) out.remote = {ok: false, error: `unknown provider "${cfg.provider}"`};
        else {
            await stage(`asking ${cfg.provider}`);
            const prompt = buildUserPrompt(PROBE_PERSONA, 'FormForge self-check', PROBE_FIELD, {dialog: 'FormForge self-check'}, []);
            const r = await keptAlive(remoteCall(cfg, PROBE_FIELD, prompt));
            const value = r.parsed['0'];
            out.model = r.model;
            out.remote = {
                ok: !r.error && typeof value === 'string' && value.trim() !== '',
                status: r.status, ms: r.ms, value, reply: String(r.text || '').slice(0, 200), error: r.error,
                note: !r.error && !value ? 'replied, but nothing usable for the field asked about' : undefined
            };
        }
    }
    // The result is stored as well as sent: a lost port must not lose a finished check.
    out.at = Date.now();
    await scratch.set({checkResult: out, checkStage: {stage: 'done', at: out.at}}).catch(ignore);
    return out;
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg) return false;
    const tabId = sender && sender.tab ? sender.tab.id : null;

    if (msg.kind === 'generate') {
        generate(msg.payload, tabId).then(respond).catch(e => respond({ok: false, error: String(e)}));
        return true;
    }
    if (msg.kind === 'nano-download') {
        nanoSessionGet({allowDownload: true}).then(s => respond({ok: !!s})).catch(e => respond({
            ok: false,
            error: String(e)
        }));
        return true;
    }
    if (msg.kind === 'inject') {
        injectFiller(msg.tabId).then(() => respond({ok: true, files: FILLER_FILES}))
            .catch(e => respond({ok: false, error: String(e && e.message || e)}));
        return true;
    }
    // The one signal every entry point shares; the toolbar icon follows it.
    if (msg.kind === 'fill-progress' && tabId != null) {
        working(tabId, !(msg.step && msg.step.stage === 'done'));
        return false;
    }
    // Answer whether a session already exists, and start building one if not.
    if (msg.kind === 'nano-warm') {
        const ready = !!nanoSession;
        nanoSessionGet({allowDownload: false}).catch(ignore);
        respond({ok: true, ready});
        return false;
    }
    if (msg.kind === 'last-exchange') {
        respond({ok: true, exchange: lastExchange});
        return false;
    }
    if (msg.kind === 'nano-check') {
        nanoCheck().then(respond);
        return true;
    }
    if (msg.kind === 'setup-check') {
        setupCheck().then(respond).catch(e => respond({error: String(e)}));
        return true;
    }
    // The popup shows which model a provider falls back to; the table lives here so it is written once.
    if (msg.kind === 'providers') {
        respond({ok: true, defaults: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.model]))});
        return false;
    }
    if (msg.kind === 'worker-info') {
        respond({ok: true, startedAt, errors: workerErrors});
        return false;
    }
    if (msg.kind === 'nano-status') {
        nanoStatus().then(s => respond({ok: true, status: s}));
        return true;
    }
    return false;
});

// Handles for tooling that evaluates inside this worker.
self.FILLER_FILES = FILLER_FILES;
self.injectFiller = injectFiller;
