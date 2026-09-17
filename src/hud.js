/* FormForge — the on-page indicator (#formforge-hud).
 *
 * One element in three states: the stage the fill is in, how far along it is,
 * and what it did. It lives on the page rather than in the popup because a
 * fill takes seconds and the popup is usually closed by then. Every stage is
 * also relayed to the popup through a `fill-progress` message.
 *
 * The stylesheet starts with `all: initial !important` because the box is a
 * guest in the host page's CSS, which reaches it through `*`, `div` and
 * `!important`. Two consequences: every declaration below must be important
 * too, and anything that varies at run time travels in a custom property
 * (`--ff-fill`, `--ff-arc`), which `all` does not reset. Hiding is a class.
 * Light DOM, not shadow: the test suites read the card through innerText.
 */
(function () {
    'use strict';

    const STYLE = `
#formforge-hud, #formforge-hud *{ all: initial!important; }
#formforge-hud *{
  box-sizing:border-box!important; display:block!important; color:inherit!important;
  font:inherit!important; text-align:left!important; letter-spacing:normal!important;
  text-transform:none!important; background:transparent!important;
  border:0!important; margin:0!important; padding:0!important;
  overflow:hidden!important; text-overflow:ellipsis!important; white-space:nowrap!important;
}
#formforge-hud{
  position:fixed!important; z-index:2147483647!important; right:14px!important; bottom:14px!important;
  display:block!important; width:272px!important; box-sizing:border-box!important;
  padding:10px 12px!important; border-radius:10px!important; text-align:left!important;
  font:12px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif!important;
  letter-spacing:normal!important; text-transform:none!important;
  background:#fff!important; color:#14171c!important; border:1px solid #e2e5ea!important;
  box-shadow:0 2px 6px rgba(16,24,40,.06),0 10px 28px rgba(16,24,40,.14)!important;
  cursor:default!important; user-select:none!important; pointer-events:auto!important;
  opacity:0!important; transform:translateY(6px)!important;
  transition:opacity .18s ease,transform .18s ease!important;
}
#formforge-hud.ff-in{ opacity:1!important; transform:none!important; }
#formforge-hud .ff-top{ display:flex!important; align-items:center!important; gap:8px!important; overflow:visible!important; }
/* The stage wraps rather than being cut. Every descendant is nowrap-with-ellipsis
   by default, which is right for a field caption the page supplied and wrong for
   our own sentence: "Waiting for the model — 14 fields left" lost its half in a
   272px card and left the reader looking at "Waiting for the model — 1...".
   Clamped at two lines so an unexpectedly long one still cannot grow the card. */
#formforge-hud .ff-title{ font-weight:600!important; flex:1 1 auto!important; min-width:0!important;
  white-space:normal!important; overflow-wrap:anywhere!important;
  display:-webkit-box!important; -webkit-box-orient:vertical!important; -webkit-line-clamp:2!important; }
/* Literal colours and background-image, not currentColor and the shorthand: the text is made
   transparent for the gradient to show through, and the shorthand resets background-clip. */
#formforge-hud.ff-busy .ff-title{
  background-image:linear-gradient(90deg,#14171c 20%,#a8b0ba 45%,#14171c 70%)!important;
  background-size:220% 100%!important;
  -webkit-background-clip:text!important; background-clip:text!important;
  -webkit-text-fill-color:transparent!important; color:transparent!important;
  animation:formforge-shimmer 1.6s linear infinite!important; }
#formforge-hud .ff-now.ff-rise{ animation:formforge-rise .22s ease-out!important; }
#formforge-hud .ff-count{ flex:none!important; font-variant-numeric:tabular-nums!important;
  font-size:11px!important; color:#5d6672!important; }
#formforge-hud .ff-x{ flex:none!important; width:16px!important; height:16px!important;
  margin:-2px -3px -2px 0!important; border-radius:4px!important; background:transparent!important;
  border:0!important; color:#9aa3ae!important; font:inherit!important; font-size:15px!important;
  line-height:14px!important; text-align:center!important; cursor:pointer!important; }
#formforge-hud .ff-x:hover{ background:#f1f3f6!important; color:#14171c!important; }
/* An arc whose length changes as it turns reads as work; a fixed ring at 13px reads as a circle.
   The two rates must not divide each other or the loop stutters. */
@property --ff-arc{ syntax:"<angle>"; inherits:false; initial-value:120deg; }
#formforge-hud .ff-spin{ flex:none!important; width:14px!important; height:14px!important;
  border-radius:50%!important; border:0!important;
  background:conic-gradient(from 0deg,
    rgba(31,111,79,0) 0deg, rgba(31,111,79,.18) calc(var(--ff-arc) * .3),
    #1f6f4f var(--ff-arc), rgba(31,111,79,0) 0deg)!important;
  -webkit-mask:radial-gradient(farthest-side, #0000 calc(100% - 2.5px), #000 calc(100% - 2.5px))!important;
  mask:radial-gradient(farthest-side, #0000 calc(100% - 2.5px), #000 calc(100% - 2.5px))!important;
  animation:formforge-spin .75s linear infinite, formforge-breathe 1.9s ease-in-out infinite!important; }
#formforge-hud .ff-tick{ flex:none!important; width:13px!important; height:13px!important;
  border-radius:50%!important; background:#1f6f4f!important; position:relative!important;
  animation:formforge-pop .32s cubic-bezier(.2,1.5,.4,1)!important; }
#formforge-hud .ff-tick::after{ content:""!important; position:absolute!important;
  left:50%!important; top:47%!important; width:3px!important; height:6px!important;
  border:solid #fff!important; border-width:0 2px 2px 0!important;
  transform:translate(-50%,-50%) rotate(45deg)!important; }
#formforge-hud .ff-tick.ff-warn{ background:#b1741a!important; }
#formforge-hud .ff-bar{ position:relative!important; height:3px!important; margin:8px 0 0!important;
  border-radius:2px!important; background:#e7eaef!important; }
#formforge-hud .ff-bar i{ position:absolute!important; top:0!important; bottom:0!important;
  left:0!important; width:var(--ff-fill,0%)!important; border-radius:2px!important;
  background:#1f6f4f!important; overflow:hidden!important; transition:width .16s linear!important; }
#formforge-hud.ff-busy .ff-bar i::after{ content:""!important; position:absolute!important;
  top:0!important; bottom:0!important; left:0!important; width:100%!important;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent)!important;
  animation:formforge-sheen 1.1s linear infinite!important; }
/* Wraps for the same reason the title does: this line is our own sentence, and
   the default nowrap-with-ellipsis cut it at "16 fields still to i...". Two
   lines at most, so an unexpectedly long one cannot grow the card. */
#formforge-hud .ff-now{ margin-top:6px!important; font-size:11px!important; color:#5d6672!important;
  white-space:normal!important; overflow-wrap:anywhere!important;
  display:-webkit-box!important; -webkit-box-orient:vertical!important; -webkit-line-clamp:2!important; }
#formforge-hud .ff-now.ff-off{ display:none!important; }
#formforge-hud .ff-tags{ display:flex!important; flex-wrap:wrap!important; gap:4px 5px!important;
  margin-top:7px!important; font-size:11px!important; overflow:visible!important; }
#formforge-hud .ff-tags:empty{ display:none!important; margin-top:0!important; }
#formforge-hud .ff-tag{ display:inline-block!important; padding:1px 6px!important;
  border-radius:999px!important; background:#f1f3f6!important; color:#5d6672!important; }
#formforge-hud .ff-tag.ff-ai{ background:#e7f3ed!important; color:#1f6f4f!important; }
#formforge-hud .ff-tag.ff-miss{ background:#fdf3e3!important; color:#8a5a12!important; }
#formforge-hud .ff-off{ display:none!important; }
@keyframes formforge-spin{ to{ transform:rotate(360deg) } }
@keyframes formforge-breathe{ 0%,100%{ --ff-arc:70deg } 50%{ --ff-arc:300deg } }
@keyframes formforge-sheen{ 0%{ transform:translateX(-100%) } 100%{ transform:translateX(100%) } }
@keyframes formforge-shimmer{ 0%{ background-position:120% 0 } 100%{ background-position:-120% 0 } }
@keyframes formforge-pop{ 0%{ transform:scale(.4) } 60%{ transform:scale(1.12) } 100%{ transform:scale(1) } }
@keyframes formforge-rise{ 0%{ opacity:0; transform:translateY(3px) } 100%{ opacity:1; transform:none } }
@media (prefers-color-scheme: dark){
  #formforge-hud{ background:#1b2027!important; color:#e9ebef!important; border-color:#2c323a!important;
    box-shadow:0 2px 6px rgba(0,0,0,.35),0 10px 28px rgba(0,0,0,.45)!important; }
  #formforge-hud .ff-count,#formforge-hud .ff-now{ color:#98a1ac!important; }
  #formforge-hud.ff-busy .ff-title{ background-image:linear-gradient(90deg,#e9ebef 20%,#6b7684 45%,#e9ebef 70%)!important; }
  #formforge-hud .ff-spin{ background:conic-gradient(from 0deg,
    rgba(53,163,119,0) 0deg, rgba(53,163,119,.2) calc(var(--ff-arc) * .3),
    #35a377 var(--ff-arc), rgba(53,163,119,0) 0deg)!important; }
  #formforge-hud .ff-tick{ background:#35a377!important; }
  #formforge-hud .ff-tick::after{ border-color:#07130d!important; }
  #formforge-hud .ff-tick.ff-warn{ background:#d9a344!important; }
  #formforge-hud .ff-bar{ background:#2c323a!important; }
  #formforge-hud .ff-bar i{ background:#35a377!important; }
  #formforge-hud .ff-tag{ background:#242a32!important; color:#98a1ac!important; }
  #formforge-hud .ff-tag.ff-ai{ background:#16281f!important; color:#59c295!important; }
  #formforge-hud .ff-tag.ff-miss{ background:#2a2115!important; color:#d9a344!important; }
  #formforge-hud .ff-x:hover{ background:#242a32!important; color:#e9ebef!important; }
}
@media (prefers-reduced-motion: reduce){
  #formforge-hud,#formforge-hud .ff-bar i{ transition:none!important; }
  #formforge-hud .ff-spin,#formforge-hud .ff-tick,#formforge-hud .ff-now,
  #formforge-hud.ff-busy .ff-title,#formforge-hud.ff-busy .ff-bar i::after{ animation:none!important; }
  #formforge-hud.ff-busy .ff-title{ background-image:none!important; color:inherit!important;
    -webkit-text-fill-color:currentColor!important; }
  #formforge-hud.ff-busy .ff-bar i::after{ display:none!important; }
}`;

    /* One bar for the whole job, and it only moves forward: each stage owns a
     * band of it. A stage with nothing to count creeps towards the end of its
     * band without arriving. */
    /* The bar only ever moves forward, so the bands are in fill order. `improve`
     * sits after `fill` because that is when it happens: the form is complete and
     * the model is replacing what it finds. */
    const BANDS = {
        read: [0.01, 0.06],
        model: [0.06, 0.22],
        fill: [0.22, 0.80],
        improve: [0.80, 0.95],
        repair: [0.95, 0.98],
        done: [1.00, 1.00]
    };

    let hudTimer = null;
    let trickle = null;
    let barAt = 0;
    let lastStage = '';
    let lastPing = 0;
    let dismissed = false;

    /* The card shows one line, so it shows the furthest the fill has got. Stages
     * do not all start in order: the model request is sent before the writing
     * starts but reports "warming up" a moment after it, which used to land on
     * top of the stage that had already overtaken it and stay there for the whole
     * request. The popup keeps a row per stage and can still take them in any
     * order, so the relay is unconditional; only the card is held forward. */
    const ORDER = ['read', 'model', 'fill', 'improve', 'repair', 'done'];
    let shown = -1;

    function reset() {
        clearTimeout(hudTimer);
        clearInterval(trickle);
        barAt = 0;
        lastStage = '';
        shown = -1;
        lastPing = 0;
        dismissed = false;
    }

    /* The box. The service worker may already have put up a stub with the same
     * id before the filler was injected; adopting it means no blink and never
     * two of them. */
    function box() {
        let st = document.getElementById('formforge-spin-style');
        if (!st || st.getAttribute('data-formforge-full') == null) {
            if (st) st.remove();
            st = document.createElement('style');
            st.id = 'formforge-spin-style';
            st.setAttribute('data-formforge-full', '');
            st.textContent = STYLE;
            document.documentElement.appendChild(st);
        }

        let el = document.getElementById('formforge-hud');
        if (el && document.contains(el) && el.querySelector('.ff-top')) return el;
        const adopted = el && document.contains(el);
        if (!adopted) {
            el = document.createElement('div');
            el.id = 'formforge-hud';
            document.documentElement.appendChild(el);
        }
        el.removeAttribute('style');
        el.removeAttribute('data-formforge-boot');
        el.setAttribute('data-formforge-hud', '');
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.innerHTML =
            '<div class="ff-top"><span class="ff-spin"></span>' +
            '<span class="ff-title"></span><span class="ff-count"></span>' +
            '<button class="ff-x" type="button" aria-label="Close">×</button></div>' +
            '<div class="ff-bar"><i></i></div>' +
            '<div class="ff-now"></div><div class="ff-tags"></div>';
        if (adopted) el.classList.add('ff-in');
        else requestAnimationFrame(() => el.classList.add('ff-in'));
        return el;
    }

    function setBar(el, frac) {
        barAt = Math.max(barAt, Math.min(1, frac));
        el.querySelector('.ff-bar i').style.setProperty('--ff-fill', (barAt * 100).toFixed(1) + '%');
    }

    function creep(el, band) {
        clearInterval(trickle);
        const [from, to] = band;
        setBar(el, from);
        trickle = setInterval(() => {
            if (!document.contains(el)) return clearInterval(trickle);
            setBar(el, barAt + (to - barAt) * 0.06);
        }, 120);
    }

    // Closed means closed: the fill goes on, but the card must not come back.
    function closable(el) {
        const x = el.querySelector('.ff-x');
        if (!x || x.dataset.wired) return;
        x.dataset.wired = '1';
        x.addEventListener('click', (e) => {
            e.stopPropagation();
            clearTimeout(hudTimer);
            dismissed = true;
            el.classList.remove('ff-in');
            setTimeout(() => el.remove(), 220);
        });
    }

    function ping(step) {
        try {
            chrome.runtime.sendMessage({kind: 'fill-progress', step}, () => void chrome.runtime.lastError);
        } catch (_) {
        }
    }

    // Every stage change reaches the popup; movement within a stage is rate-limited.
    function relay(stage, text, at) {
        const t = Date.now();
        if (stage === lastStage && t - lastPing <= 120) return;
        lastStage = stage;
        lastPing = t;
        ping({stage, text, done: at && at.done, total: at && at.total, label: at && at.label});
    }

    /* Report a stage. `at` = { done, total, label } when there is something to
     * count; otherwise the bar creeps. `stage` is an identity the popup keys on. */
    function progress(stage, text, at) {
        if (dismissed) return relay(stage, text, at);
        const rank = ORDER.indexOf(stage);
        if (rank >= 0 && rank < shown) return relay(stage, text, at);
        if (rank > shown) shown = rank;
        const el = box();
        clearTimeout(hudTimer);
        el.classList.add('ff-busy');
        closable(el);
        el.querySelector('.ff-top').firstChild.className = 'ff-spin';
        const now = el.querySelector('.ff-now');
        if (at && at.total) {
            clearInterval(trickle);
            const [from, to] = BANDS[stage] || BANDS.fill;
            setBar(el, from + (to - from) * (at.done / at.total));
            el.querySelector('.ff-count').textContent = `${at.done}/${at.total}`;
            if (now.textContent !== (at.label || '')) {
                now.textContent = at.label || '';
                now.classList.remove('ff-rise');
                void now.offsetWidth;                  // restart the arrival animation
                now.classList.add('ff-rise');
            }
            now.classList.toggle('ff-off', !at.label);
        } else {
            creep(el, BANDS[stage] || BANDS.repair);
            el.querySelector('.ff-count').textContent = '';
            now.textContent = '';
            now.classList.add('ff-off');
        }
        el.querySelector('.ff-title').textContent = text;
        el.querySelector('.ff-tags').textContent = '';
        relay(stage, text, at);
    }

    const fmtMs = (ms) => ms < 950 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

    /* The result, in the same box. It names what did not work — a fill that
     * left required fields empty must not read as a success — and stays up
     * longer when there is bad news to read. */
    function toast(title, detail) {
        const d = detail || {};
        /* The toast is the end of the job by definition, so it is what says so.
         * Only the "filled N fields" path used to, and every other ending — no
         * fillable fields, a control we cannot drive, a cleared form — left the
         * toolbar icon animating until its 90-second watchdog, which reads as a
         * fill that is still running. Sent before the dismissed guard: the job
         * finished whether or not the card is still on screen to show it. */
        ping({
            stage: 'done', text: title,
            done: d.filled ? d.filled.length : undefined, total: d.total,
            aiUsed: d.aiUsed, skipped: d.skipped ? d.skipped.length : undefined, ms: d.ms
        });
        if (dismissed) return;
        const el = box();
        const p = d.persona;
        clearTimeout(hudTimer);
        el.classList.remove('ff-busy');
        closable(el);

        el.querySelector('.ff-top').firstChild.className =
            'ff-tick' + (d.hint || (d.skipped && d.skipped.length) ? ' ff-warn' : '');
        el.querySelector('.ff-title').textContent = title;
        el.querySelector('.ff-count').textContent = d.ms != null ? fmtMs(d.ms) : '';

        clearInterval(trickle);
        setBar(el, 1);
        el.querySelector('.ff-bar').classList.toggle('ff-off', !(d.persona || d.ms != null));

        const now = el.querySelector('.ff-now');
        now.classList.add('ff-off');

        const tags = el.querySelector('.ff-tags');
        tags.textContent = '';
        const tag = (text, cls) => {
            const s = document.createElement('span');
            s.className = 'ff-tag' + (cls ? ' ' + cls : '');
            s.textContent = text;
            tags.appendChild(s);
        };
        const by = {};
        for (const f of (d.filled || [])) {
            const how = String(f.source || '').split('/')[0];
            by[how] = (by[how] || 0) + 1;
        }
        /* One row, one question: where the values came from. The chips come to
         * the total above them, so the arithmetic the card invites is arithmetic
         * that works — a row reading 25 and 20 over "Filled 58 fields" lost the
         * thirteen the control itself chose, which had no chip. How many of
         * those fields were widgets is a second question about the same fields,
         * and the answer is a line down in the popup and in the report; on a
         * card four words wide it reads as another number to add. */
        if (by.rule || by.type) tag(`${(by.rule || 0) + (by.type || 0)} from rules`);
        if (by.ai) tag(`${by.ai} from the model`, 'ff-ai');
        if (by.choice) tag(`${by.choice} chosen`);
        if (by.fallback) tag(`${by.fallback} filler`);
        if (d.skipped && d.skipped.length) {
            tag(`${d.skipped.length} left empty`, 'ff-miss');
            const names = d.skipped.slice(0, 2).map(s => s.label).filter(Boolean).join(', ');
            if (names) {
                now.textContent = names + (d.skipped.length > 2 ? ` +${d.skipped.length - 2} more` : '');
                now.classList.remove('ff-off');
            }
        }

        /* No second debug report on the card. Its job is the verdict — how many
         * fields, how long, what was left — and it takes itself off screen after a
         * few seconds, which is no place to keep something a tester needs to copy
         * into a ticket. That lives in the Debug tab now. */

        const dismiss = () => {
            el.classList.remove('ff-in');
            setTimeout(() => el.remove(), 220);
        };
        const arm = (ms) => {
            clearTimeout(hudTimer);
            hudTimer = setTimeout(dismiss, ms);
        };
        arm(d.skipped && d.skipped.length ? 6000 : 3200);
        el.onmouseenter = () => clearTimeout(hudTimer);
        el.onmouseleave = () => {
            arm(1200);
        };
        el.onclick = dismiss;
    }

    globalThis.FormForgeHud = {reset, progress, toast, ping};
})();
