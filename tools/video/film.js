/* The film clock: injected into a frame's extension world before the filler,
 * so a real fill can be stepped one video frame at a time.
 *
 * Timers, Date and performance.now all read a virtual clock that moves only
 * when the stage says so, and anything that finishes in real time — a message
 * to the worker, a PNG being encoded — is waited for before the clock moves
 * past it. So the same seed gives the same fill at the same virtual moments on
 * every run, however long each screenshot takes.
 *
 * The stage speaks through the frame's DOM, which both worlds share: it sets
 * data-film-to and dispatches `film-advance`; this answers with `film-done`.
 * What the fill did, and when, is kept on data-film-log for the stage to time
 * its scenes by.
 */
(function () {
    'use strict';
    if (globalThis.__film) return;

    const doc = document.documentElement;
    const EPOCH = Number(doc.getAttribute('data-film-epoch')) || Date.now();
    const MODEL_MS = Number(doc.getAttribute('data-film-model-ms')) || 1400;
    const real = {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        Date: globalThis.Date,
        perf: performance.now.bind(performance)
    };
    const realTick = () => new Promise(r => real.setTimeout(r, 0));

    let vnow = 0;
    let seq = 1;
    const timers = new Map();
    const schedule = (fn, ms, args, repeat) => {
        const id = seq++;
        const wait = Math.max(0, Number(ms) || 0);
        timers.set(id, {id, due: vnow + wait, fn, args, every: repeat ? Math.max(1, wait) : 0});
        return id;
    };
    const cancel = (id) => void timers.delete(id);
    globalThis.setTimeout = (fn, ms, ...args) => schedule(fn, ms, args, false);
    globalThis.setInterval = (fn, ms, ...args) => schedule(fn, ms, args, true);
    globalThis.clearTimeout = cancel;
    globalThis.clearInterval = cancel;
    // A frame is the next thing the film draws, so a callback waiting for one runs a millisecond on.
    globalThis.requestAnimationFrame = (fn) => schedule(() => fn(vnow), 1, [], false);
    globalThis.cancelAnimationFrame = cancel;

    class FilmDate extends real.Date {
        constructor(...a) {
            if (a.length) super(...a);
            else super(EPOCH + vnow);
        }

        static now() {
            return EPOCH + vnow;
        }
    }

    globalThis.Date = FilmDate;
    Object.defineProperty(performance, 'now', {configurable: true, value: () => vnow});

    /* Work that finishes in real time. The clock does not move while any of it
     * is outstanding, so where it lands in virtual time never depends on how
     * fast the machine was. */
    const pending = new Set();
    const track = (p) => {
        const t = Promise.resolve(p).finally(() => pending.delete(t));
        pending.add(t);
        return t;
    };
    const settleReal = async () => {
        for (let i = 0; pending.size && i < 400; i++) {
            await Promise.race([Promise.allSettled([...pending]), new Promise(r => real.setTimeout(r, 25))]);
            await realTick();
        }
    };

    const wrapAsync = (proto, name) => {
        const fn = proto && proto[name];
        if (typeof fn !== 'function') return;
        // Handed back on the next virtual millisecond: a step of its own, wherever the machine finished it.
        proto[name] = function (...a) {
            const later = (settle) => new Promise(r => globalThis.setTimeout(() => r(settle()), 1));
            return track(fn.apply(this, a)).then(v => later(() => v), e => later(() => Promise.reject(e)));
        };
    };
    wrapAsync(globalThis.OffscreenCanvas && OffscreenCanvas.prototype, 'convertToBlob');
    wrapAsync(Blob.prototype, 'arrayBuffer');
    wrapAsync(Blob.prototype, 'text');

    /* A reply from the worker is handed over at a fixed virtual time: at once
     * for everything but the model, whose answer lands MODEL_MS after it was
     * asked — about what a warm on-device batch takes. */
    const rt = chrome.runtime;
    const send = rt.sendMessage.bind(rt);
    let askedAt = 0;
    const filmSend = (...a) => {
        const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
        const msg = a.find(x => x && typeof x === 'object' && x.kind) || {};
        const asking = msg.kind === 'generate';
        if (asking) askedAt = vnow;
        // The answer's batches stream in first (see the listener below); the reply closes it a millisecond later.
        const due = vnow + (asking ? MODEL_MS + 1 : 0);
        let reply = {ok: false};
        const got = track(send(...a).then(v => (reply = {ok: true, v}), e => (reply = {ok: false, e}))
            // A batch the worker streamed just before replying may still be on its way.
            .then(() => asking && new Promise(r => real.setTimeout(r, 40))));
        const out = new Promise((resolve, reject) => {
            got.then(() => schedule(() => {
                if (cb) return cb(reply.ok ? reply.v : undefined);
                return reply.ok ? resolve(reply.v) : reject(reply.e);
            }, due - vnow, [], false));
        });
        return cb ? undefined : out;
    };
    Object.defineProperty(rt, 'sendMessage', {configurable: true, writable: true, value: filmSend});

    // What happened when, for the stage to time its scenes by.
    const log = [];
    const mark = (e) => {
        log.push(Object.assign({v: Math.round(vnow * 1000) / 1000}, e));
        doc.setAttribute('data-film-log', JSON.stringify(log));
    };

    /* The filler's own surfaces are wrapped as they are published, before the
     * files that read them at load time have taken their copies. */
    const onPublish = (name, wrap) => {
        let held;
        Object.defineProperty(globalThis, name, {
            configurable: true,
            get: () => held,
            set: (v) => {
                held = v && wrap(v);
            }
        });
    };
    /* A fill on a quick page runs from one control to the next without giving
     * the browser a frame: four fields, a dropdown opened and picked, in one
     * task. Every wait the filler makes first yields a millisecond, so the film
     * has a moment to stop in — the dropdown open, its options listed — and the
     * fill decides exactly what it would have. */
    const YIELD_MS = 1;
    const yielding = (surface) => {
        const out = Object.assign({}, surface);
        for (const [k, fn] of Object.entries(surface)) {
            if (typeof fn !== 'function' || fn.constructor.name !== 'AsyncFunction') continue;
            out[k] = async function (...a) {
                await new Promise(r => globalThis.setTimeout(r, YIELD_MS));
                return fn.apply(this, a);
            };
        }
        return out;
    };
    for (const name of ['FillsmithDom', 'FillsmithOverlays', 'FillsmithWidgets', 'FillsmithUploads']) onPublish(name, yielding);

    onPublish('FillsmithHud', (H) => Object.assign({}, H, {
        progress(stage, text, at) {
            mark({kind: 'progress', stage, text, done: at && at.done, total: at && at.total, label: at && at.label});
            return H.progress(stage, text, at);
        },
        toast(title, detail) {
            const r = H.toast(title, detail);
            mark({kind: 'toast', title});
            return r;
        }
    }));

    let received = 0;
    const listen = rt.onMessage.addListener.bind(rt.onMessage);
    rt.onMessage.addListener = (fn) => listen((msg, sender, respond) => {
        received++;
        doc.setAttribute('data-film-received', String(received));
        if (msg && msg.kind === 'fill') mark({kind: 'fill'});
        // The model's answers land when the model is due to have answered, not when the stand-in did.
        if (msg && msg.kind === 'model-batch') {
            schedule(() => fn(msg, sender, respond), askedAt + MODEL_MS - vnow, [], false);
            return false;
        }
        return fn(msg, sender, respond);
    });

    const box = (el) => {
        const r = el.getBoundingClientRect();
        return {x: r.left, y: r.top, w: r.width, h: r.height};
    };
    document.addEventListener('pointerdown', (e) => {
        if (e.isTrusted) return;
        const t = /** @type {Element} */ (e.target);
        mark({kind: 'press', x: e.clientX, y: e.clientY, target: t.id || t.className || t.tagName, box: box(t)});
    }, true);
    document.addEventListener('paste', () => mark({kind: 'paste'}), true);
    document.addEventListener('change', (e) => {
        const t = /** @type {HTMLInputElement} */ (e.target);
        if (t.type === 'file') mark({kind: 'file'});
    }, true);
    new MutationObserver((list) => {
        for (const m of list) {
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1 || !/overlay|panel/.test(n.className)) continue;
                mark({kind: 'open', what: n.className, box: box(n)});
                /* The demo's list is in the panel the instant it opens, so the filler
                 * picks in the same task and the open list is never on screen. Here
                 * it renders a millisecond after its panel, as a list rendered on
                 * the next tick does: the filler waits for it as it always does,
                 * and the film has the list open to show. */
                const list = n.querySelector('[role="listbox"]');
                if (list) {
                    const parent = list.parentNode, next = list.nextSibling;
                    list.remove();
                    globalThis.setTimeout(() => parent.insertBefore(list, next), 1);
                }
            }
            for (const n of m.removedNodes) {
                if (n.nodeType === 1 && /overlay|panel/.test(n.className)) mark({kind: 'close', what: n.className});
            }
        }
    }).observe(document.body, {childList: true});

    async function advance(to) {
        for (; ;) {
            await settleReal();
            let next = null;
            for (const t of timers.values()) {
                if (t.due <= to && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
            }
            if (!next) break;
            vnow = Math.max(vnow, next.due);
            if (next.every) next.due = vnow + next.every;
            else timers.delete(next.id);
            try {
                next.fn(...(next.args || []));
            } catch (_) { /* a callback that throws in the page throws here too, and the clock goes on */
            }
            await realTick();
        }
        vnow = Math.max(vnow, to);
        await settleReal();
    }

    let queue = Promise.resolve();
    document.addEventListener('film-advance', () => {
        const to = Number(doc.getAttribute('data-film-to')) || 0;
        queue = queue.then(() => advance(to)).then(() => {
            doc.setAttribute('data-film-at', String(vnow));
            document.dispatchEvent(new Event('film-done'));
        });
    });

    globalThis.__film = {now: () => vnow};
    doc.setAttribute('data-film-ready', '1');
})();
