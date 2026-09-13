/* FormForge — how to drive each kind of control.
 *
 * One strategy per control shape, and every one ends the same way: read the
 * control back and report what it actually holds — never what was typed or
 * planned. A component that accepts a value and reverts it on the next render
 * is indistinguishable from one that refused it.
 */
(function () {
  'use strict';

  const { note, takeNotes, sleep, visible, textOf, norm, press, key, typeInto, setNativeValue,
          commit, settle, waitFor, safeQuery, PLACEHOLDER } = globalThis.FormForgeDom;
  const { detect, claimed, labelFor, displayedValue, radioLabel } = globalThis.FormForgeAdapters;
  const O = globalThis.FormForgeOverlays;
  const { overlayCandidates, optionsIn, liveOverlay, linkedOverlayId, openOverlay, closeOverlay,
          comboOf, chooseOption, matchAmong, asTexts, scrollerFor, huntByScrolling, typeAhead,
          ownPanels, dismissPanel, PANEL_SELECTOR } = O;

  const isSelected = (el) => el && (el.getAttribute('aria-selected') === 'true'
    || /(^|\s|-)selected(\s|$|-)/.test(el.className || ''));
  const first = (candidates) => (Array.isArray(candidates) ? candidates : [candidates]).find(Boolean);

  // Where a dropdown's time goes: open / hunt / pick / close are four different problems.
  const choiceTimings = [];

  // ----------------------------------------------------------------- choice ----
  async function fillChoice(widget, candidates, ctx, multi) {
    const markBefore = widget.root.innerHTML;
    const tt = { id: widget.id, label: ctx.label || '', open: 0, hunt: 0, pick: 0, close: 0 };
    choiceTimings.push(tt);

    const tOpen = Date.now();
    const overlay = await openOverlay(widget);
    tt.open = Date.now() - tOpen;
    if (!overlay) {
      note(`${ctx.label || widget.id}: would not open`);
      return null;
    }
    overlay.setAttribute('data-formforge-overlay', '1');

    // A list that arrives over the network is empty for a moment after it opens.
    let options = optionsIn(overlay, widget.lib);
    if (!options.length) {
      await settle(() => optionsIn(overlay, widget.lib).length > 0, 1800);
      options = optionsIn(overlay, widget.lib);
    }

    /* Filter or scroll only when rows are out of the document — a virtualised
     * list shows it by scrolling through far more height than its rows hold.
     * A list rendered in full has already been read by the match. */
    const want = first(candidates);
    const filterSel = widget.lib.filter || 'input[type="text"], input:not([type])';
    const filter = overlay.querySelector(filterSel);
    const scroller = scrollerFor(overlay);
    const rowsTall = options.reduce((n, o) => n + o.getBoundingClientRect().height, 0);
    const moreThanShows = (!!scroller && rowsTall > 0 && scroller.scrollHeight > rowsTall * 1.5)
      || (!options.length && !!filter);

    if (filter && want && moreThanShows) {
      const countBefore = options.length;
      typeInto(filter, String(want).slice(0, 24));
      await settle(() => optionsIn(overlay, widget.lib).length !== countBefore, 320);
      const filtered = optionsIn(overlay, widget.lib);
      if (filtered.length) options = filtered;
      else {
        // Nothing matched: clear the query and wait for the full list to come back.
        typeInto(filter, '');
        await settle(() => optionsIn(overlay, widget.lib).length > 0, 900);
        options = optionsIn(overlay, widget.lib);
      }
    }
    if (!options.length) {
      note(`${ctx.label || widget.id}: its list opened with nothing in it`);
      overlay.removeAttribute('data-formforge-overlay');
      await closeOverlay(widget);
      return null;
    }

    /* One budget for the whole hunt, longer when only a match will do (a
     * country picker beside a phone number). Scrolling first, because it is
     * library-agnostic and leaves the match on screen; type-ahead after. */
    const tHunt = Date.now();
    if (want && !multi && moreThanShows && !matchAmong(asTexts(options), candidates)) {
      const budgetEnds = tHunt + (ctx.requireMatch ? 2500 : 600);
      let after = await huntByScrolling(overlay, widget.lib, candidates, budgetEnds);
      if (after && after.length) {
        options = after;
      } else if (!O.sawWholeList() && Date.now() < budgetEnds - 250) {
        await typeAhead(widget, want);
        after = optionsIn(overlay, widget.lib);
        if (after.length && matchAmong(asTexts(after), candidates)) options = after;
      }
    }

    // The control may already hold the wanted option; pressing it would change nothing.
    if (!multi) {
      const already = matchAmong(asTexts(optionsIn(overlay, widget.lib)), candidates);
      if (already && isSelected(already.el)) {
        overlay.removeAttribute('data-formforge-overlay');
        await closeOverlay(widget);
        return already.text || displayedValue(widget) || null;
      }
    }

    tt.hunt = Date.now() - tHunt;
    const tPick = Date.now();
    const picked = [];
    const count = multi ? Math.min(options.length, 1 + Math.floor((ctx.rng ? ctx.rng() : Math.random()) * 2)) : 1;
    for (let i = 0; i < count; i++) {
      const fresh = optionsIn(overlay, widget.lib).filter(o => !picked.includes(o));
      if (!fresh.length) break;
      /* requireMatch buys a longer search, never a veto: an empty required
       * picker blocks the form and everything that depends on it, where a
       * mismatched country is visibly test data. */
      const wanted = i === 0 ? candidates : null;
      let choice = (ctx.requireMatch && i === 0)
        ? matchAmong(asTexts(fresh), wanted)
        : chooseOption(fresh, wanted, ctx.rng);
      let settledFor = false;
      if (!choice && i === 0) {
        choice = chooseOption(fresh, null, ctx.rng);
        settledFor = !!choice;
      }
      if (i === 0 && (settledFor || !choice)) {
        const seen = asTexts(fresh).map(o => o.text).filter(Boolean);
        const asked = first(wanted) || '';
        note(`${ctx.label || widget.id}: no "${asked}" among ${seen.length} option(s)` +
          (seen.length ? ` (${seen.slice(0, 3).join(', ')}…)` : '') +
          (settledFor ? ` — took "${choice.text || choice.value || '?'}"` : ' — nothing to take'));
      }
      if (!choice) break;
      const shownBefore = displayedValue(widget);
      press(choice.el);
      picked.push(choice.el);
      await settle(() => {
        if (displayedValue(widget) !== shownBefore) return true;
        const combo = comboOf(widget);
        return !multi && combo && combo.getAttribute('aria-expanded') === 'false';
      }, 220);
    }

    tt.pick = Date.now() - tPick;
    const tClose = Date.now();
    overlay.removeAttribute('data-formforge-overlay');
    const pickedText = picked.length ? textOf(picked[picked.length - 1]) : '';
    await closeOverlay(widget);
    await sleep(40);
    tt.close = Date.now() - tClose;

    const shown = displayedValue(widget);
    if (shown && !PLACEHOLDER.test(shown)) return shown;

    /* A picker that renders its value as a flag has no text to read, and
     * choosing the app's own default alters no markup. A pressed option that
     * is now selected, or a control that has closed, is what committing looks like. */
    const chosen = picked[picked.length - 1];
    if (isSelected(chosen)) return pickedText || displayedValue(widget) || null;
    if (pickedText && widget.root.innerHTML !== markBefore) return pickedText;
    if (!multi && pickedText) {
      const combo = comboOf(widget);
      if (combo && combo.getAttribute('aria-expanded') === 'false') return pickedText;
    }

    // Some libraries only commit from the keyboard.
    const focusable = widget.root.querySelector('input, [tabindex]') || widget.root;
    key(focusable, 'ArrowDown'); await sleep(80);
    key(focusable, 'Enter'); await sleep(120);
    const retry = displayedValue(widget);
    return retry && !PLACEHOLDER.test(retry) ? retry : null;
  }

  async function fillInlineChoice(widget, candidates, ctx) {
    const options = optionsIn(widget.root, widget.lib);
    if (!options.length) return null;
    const choice = chooseOption(options, candidates, ctx.rng);
    if (!choice) return null;
    press(choice.el);
    await sleep(80);
    return choice.text || displayedValue(widget);
  }

  async function fillRadioGroup(widget, candidates, ctx) {
    const options = widget.members.map(m => {
      const input = m.root.querySelector('input');
      return { el: m.root, input, text: radioLabel(m.root, input), value: (input && input.value) || '' };
    }).filter(o => o.input && !o.input.disabled && visible(o.el));
    if (!options.length) return null;

    // A caption shared by every member is the group's question, not an option's name.
    const unique = new Set(options.map(o => o.text).filter(Boolean));
    if (unique.size < options.length) options.forEach(o => { o.text = o.value || o.text; });
    const groupLabel = norm(labelFor(widget));
    if (groupLabel) {
      options.forEach((o, i) => {
        const n = norm(o.text);
        if (!n || (n !== groupLabel && !groupLabel.startsWith(n))) return;
        const id = o.input && o.input.id ? String(o.input.id).split(/[.\-_]/).pop() : '';
        o.text = o.value || id || `option ${i + 1}`;
      });
    }

    const choice = chooseOption(options, candidates, ctx.rng);
    if (!choice) return null;
    // The hidden input is the control; the wrapper is the fallback.
    press(choice.input || choice.el);
    await settle(() => choice.input && choice.input.checked, 200);
    if (choice.input && !choice.input.checked) {
      press(choice.el);
      await settle(() => choice.input.checked, 200);
    }
    return choice.text || choice.value || null;
  }

  // ------------------------------------------------------------------- bool ----
  async function fillBool(widget, value, ctx) {
    const input = widget.lib.input ? widget.root.querySelector(widget.lib.input) : null;
    const required = input && (input.required || input.getAttribute('aria-required') === 'true');
    const want = value === true || value === 'true' ? true
      : value === false || value === 'false' ? false
      : required ? true : (ctx.rng ? ctx.rng() : Math.random()) > 0.55;
    const isOn = () => {
      if (input && typeof input.checked === 'boolean') return input.checked;
      const a = widget.root.getAttribute('aria-checked') || widget.root.getAttribute('aria-pressed');
      if (a != null) return a === 'true';
      return /checked|active|selected/.test(widget.root.className);
    };
    if (isOn() !== want) {
      // The real input first (PrimeVue keeps it at opacity 0 behind the wrapper), then the wrapper.
      const target = input || widget.root;
      press(target);
      await settle(() => isOn() === want, 200);
      if (isOn() !== want) {
        press(target === widget.root ? input : widget.root);
        await settle(() => isOn() === want, 200);
      }
    }
    return String(isOn());
  }

  // ----------------------------------------------------------- autocomplete ----
  const SAYS_EMPTY = '[class*="empty"], [class*="no-option"], [class*="no-result"],' +
                     '[class*="noOption"], [class*="noResult"], [role="status"], [role="alert"]';

  /* Shortest query first, whole candidate last: a backend matches on a prefix,
   * so "Jul" is likelier to return "Julia Koch" than the full string, and
   * ending on the candidate leaves the field holding it if nothing matches.
   * A panel that says "no results" is believed at once; a silent empty panel
   * gets one short grace period. */
  async function fillAutocomplete(widget, candidates, ctx) {
    const input = widget.root.querySelector(widget.lib.input || 'input');
    if (!input) return null;
    const seedText = String(first(candidates) == null ? '' : first(candidates));
    // With nothing to aim at, a single common letter makes the list appear.
    const probe = seedText || String((ctx.persona && (ctx.persona.lastName || ctx.persona.company)) || 'a').slice(0, 2);
    if (!probe) return null;

    const before = new Set(overlayCandidates(widget));
    const wantId = linkedOverlayId(widget);
    const mine = () => overlayCandidates(widget).filter(liveOverlay)
      .filter(o => wantId ? o.id === wantId : !before.has(o));
    const pickOverlay = () => mine().find(o => optionsIn(o, widget.lib).length) || null;

    // A panel counts only once it differs from the one left by the previous attempt.
    let asked = new Map();
    const snapshot = () => {
      asked = new Map(overlayCandidates(widget).filter(liveOverlay).map(o => [o, o.innerHTML.length]));
    };
    const emptyOverlay = () => {
      const panels = mine().filter(o => !asked.has(o) || asked.get(o) !== o.innerHTML.length);
      if (!panels.length || panels.some(o => optionsIn(o, widget.lib).length)) return null;
      return panels.some(o => safeQuery(o, SAYS_EMPTY).some(visible)) ? 'said-empty' : 'empty';
    };

    let overlay = null;
    let sawPanel = false;
    const shorter = seedText ? [probe.slice(0, 3), probe.slice(0, 1)] : ['e', 'a'];
    const attempts = [...new Set(shorter.filter(x => x && x !== probe)), probe];
    const deadline = Date.now() + 1500;
    for (let i = 0; i < attempts.length; i++) {
      const left = deadline - Date.now();
      if (left < 150) break;
      const slice = Math.max(300, Math.floor(left / (attempts.length - i)));
      snapshot();
      typeInto(input, attempts[i]);
      input.dispatchEvent(new Event('keyup', { bubbles: true }));
      const verdict = await waitFor(() => pickOverlay() || emptyOverlay(), Math.min(slice, left));
      if (verdict) sawPanel = true;
      if (verdict && verdict !== 'empty' && verdict !== 'said-empty') { overlay = verdict; break; }
      if (verdict === 'empty') {
        const late = await waitFor(pickOverlay, Math.min(220, Math.max(0, deadline - Date.now())));
        if (late) { overlay = late; break; }
      }
    }
    if (overlay) {
      const choice = chooseOption(optionsIn(overlay, widget.lib), candidates, ctx.rng);
      if (choice) {
        press(choice.el);
        await settle(() => (input.value || '').length > 0, 200);
        return displayedValue(widget) || choice.text;
      }
    }

    /* No suggestion. Leave the whole candidate (a free-text autocomplete keeps
     * it) or clear a probe, then wait for the panel that last write triggers
     * and dismiss it — otherwise it lands over the next field. */
    if (!seedText) typeInto(input, '');
    else if (input.value !== seedText) typeInto(input, seedText);
    commit(input);
    if (sawPanel) await settle(() => overlayCandidates(widget).filter(liveOverlay).length > 0, 320);
    await closeOverlay(widget);
    return seedText ? (input.value || null) : null;
  }

  // ------------------------------------------------------------------- date ----
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const CLOCK = /^\d{1,2}:\d{2}$/;

  function localDate(iso, fmt) {
    const [y, m, d] = iso.split('-');
    const map = { DD: d, TT: d, MM: m, YYYY: y, JJJJ: y };
    return String(fmt).replace(/TT|DD|MM|JJJJ|YYYY/g, k => map[k]);
  }

  /* A time-only picker is a pair of spinners; its input refuses focus and is
   * written by the component, so the buttons are driven the way a person would. */
  async function fillTimeOnly(widget, hhmm) {
    const input = widget.root.querySelector('input');
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return null;
    const wantH = Number(m[1]), wantM = Number(m[2]);

    const tOpen = Date.now();
    const before = new Set(ownPanels(widget));
    const wantId = linkedOverlayId(widget);
    press(input || widget.root);
    const panel = await waitFor(() => {
      const now = ownPanels(widget).filter(p => p.querySelector('[class*="time-picker"], [data-pc-section="timepicker"]'));
      return (wantId && now.find(p => p.id === wantId)) || now.find(p => !before.has(p)) || null;
    }, 900);
    if (!panel) return null;

    const group = (kind) => panel.querySelector(`[class*="${kind}-picker"], [data-pc-section="${kind}picker"]`);
    const readNum = (g) => {
      const span = g && [...g.querySelectorAll('span, div')].find(e => /^\d{1,2}$/.test(textOf(e)));
      return span ? Number(textOf(span)) : null;
    };
    const spin = async (g, want, wrap) => {
      if (!g) return false;
      const buttons = g.querySelectorAll('button');
      if (buttons.length < 2) return false;
      const up = buttons[0], down = buttons[buttons.length - 1];
      const start = readNum(g);
      if (start == null) return false;
      if (start === want) return true;
      // The whole distance in one burst, the shorter way round; the spinner updates synchronously.
      const upDist = (want - start + wrap) % wrap;
      const downDist = (start - want + wrap) % wrap;
      const useUp = upDist <= downDist;
      for (let i = 0, n = useUp ? upDist : downDist; i < n; i++) press(useUp ? up : down);
      await settle(() => readNum(g) === want, 200);
      // A component that debounced the burst is finished off one step at a time.
      for (let i = 0; i < wrap && readNum(g) !== want; i++) {
        const cur = readNum(g);
        if (cur == null) break;
        press(((want - cur + wrap) % wrap) <= wrap / 2 ? up : down);
        await settle(() => readNum(g) !== cur, 120);
      }
      return readNum(g) === want;
    };

    const msOpen = Date.now() - tOpen;
    const tSpin = Date.now();
    await spin(group('hour'), wantH, 24);
    await spin(group('minute'), wantM, 60);
    const msSpin = Date.now() - tSpin;
    const tClose = Date.now();

    // Click away, never Escape (it cancels the edit); wait for the value, not for the panel's exit.
    press(document.body);
    await settle(() => String(input && input.value || '') !== '', 450);
    if (ownPanels(widget).length) press(document.body);
    choiceTimings.push({ id: 'timeonly', open: msOpen, hunt: msSpin, pick: 0, close: Date.now() - tClose });
    return (input && input.value) || null;
  }

  async function typeDate(widget, input, text) {
    const v = typeInto(input, String(text));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await dismissPanel(widget, { keepTypedValue: true });
    await settle(() => String(input.value || '') !== '', 220);
    return input.value || null;
  }

  async function fillDate(widget, value, ctx) {
    const input = widget.root.querySelector(widget.lib.input || 'input');
    const fmt = (ctx.persona && ctx.persona.dateFormat) || 'YYYY-MM-DD';
    // A model can answer in ISO; the control wants the locale's shape.
    if (ISO_DATE.test(String(value || ''))) value = localDate(String(value), fmt);

    if (CLOCK.test(String(value || '')) && input) {
      const viaPanel = await fillTimeOnly(widget, value);
      if (viaPanel) return viaPanel;
      const typed = await typeDate(widget, input, value);
      if (typed) return typed;
    }

    // A specific date (a birth date) is typed; the panel opens on today and prefers the future.
    if (ctx.typeFirst && input && !input.readOnly && value) {
      const typed = await typeDate(widget, input, value);
      if (typed) return typed;
    }

    // Clicking a day is format-independent, so try the panel first.
    const before = new Set([...safeQuery(document, PANEL_SELECTOR).filter(visible), ...ownPanels(widget)]);
    press(input && !input.readOnly ? input : widget.root);
    const panel = await waitFor(() => {
      const mine = ownPanels(widget).filter(p => p.querySelector('td, [class*="day"]'));
      const fresh = mine.find(p => !before.has(p));
      if (fresh) return fresh;
      if (mine.length && !before.size) return mine[0];
      return safeQuery(document, PANEL_SELECTOR)
        .filter(p => visible(p) && p.querySelector('td, [class*="day"]'))
        .find(p => !before.has(p)) || null;
    }, 1200);

    if (panel) {
      const enabledCells = () => safeQuery(panel, 'td:not([class*="other-month"]) span, td:not(.p-datepicker-other-month), [class*="day-cell"]:not([class*="other-month"]), [class*="cell"]:not([class*="other"])')
        .filter(c => visible(c) && /^\d{1,2}$/.test(textOf(c)) &&
          !(c.getAttribute('aria-disabled') === 'true' || c.classList.contains('p-disabled')));
      let cells = enabledCells();
      // A constrained picker can open on a month with nothing selectable: step forward.
      for (let hop = 0; !cells.length && hop < 3; hop++) {
        const next = panel.querySelector('[class*="next"], [aria-label*="Next"], [aria-label*="Nächst"]');
        if (!next) break;
        press(next);
        await settle(() => enabledCells().length > 0, 400);
        cells = enabledCells();
      }
      // A picker scoped to years or months offers a coarse grid instead of days.
      if (!cells.length) {
        const wantYear = /^\d{4}$/.test(String(value || '')) ? String(value) : null;
        let coarse = safeQuery(panel, 'span, button, td, div')
          .filter(c => visible(c) && !c.querySelector('span, button, td') &&
            /^([A-Za-zÄÖÜäöü]{3,12}|\d{4})$/.test(textOf(c)) &&
            !(c.getAttribute('aria-disabled') === 'true' || c.classList.contains('p-disabled')));
        if (wantYear) {
          const exact = coarse.find(c => textOf(c) === wantYear);
          if (exact) coarse = [exact];
        }
        if (coarse.length) {
          press(coarse[Math.floor((ctx.rng ? ctx.rng() : Math.random()) * coarse.length)] || coarse[0]);
          const el2 = widget.root.querySelector('input');
          await settle(() => el2 && el2.value, 300);
          // A year view may then ask for a month, and a month view for a day.
          for (let step = 0; step < 2 && el2 && !el2.value; step++) {
            const next = safeQuery(panel, 'td span, [class*="day-cell"], [class*="month"]')
              .filter(c => visible(c) && !c.classList.contains('p-disabled'));
            if (!next.length) break;
            press(next[Math.floor((ctx.rng ? ctx.rng() : Math.random()) * next.length)]);
            await settle(() => el2 && el2.value, 300);
          }
          await dismissPanel(widget, { keepTypedValue: true });
          if (el2 && el2.value) return el2.value;
        }
      }
      if (cells.length) {
        // Today or later, since many pickers disable the past; each end of a range takes its own half.
        const todayIdx = cells.findIndex(c => /today/.test(c.className) || /today/.test(c.parentElement?.className || ''));
        let pool = todayIdx >= 0 ? cells.slice(todayIdx) : cells;
        const caption = labelFor(widget);
        const role = /\b(end|return|to|until|bis|rückgabe|ende)\b/i.test(caption) ? 'end'
                   : /\b(start|from|rental|von|beginn|ausleihe)\b/i.test(caption) ? 'start' : '';
        if (role && pool.length > 3) {
          const half = Math.floor(pool.length / 2);
          pool = role === 'end' ? pool.slice(half) : pool.slice(0, half);
        }
        const target = pool[Math.floor((ctx.rng ? ctx.rng() : Math.random()) * pool.length)] || pool[0];
        press(target);
        const el = widget.root.querySelector('input');
        await settle(() => el && el.value, 250);
        if (el && el.value) { await dismissPanel(widget); return el.value; }
      }
      await dismissPanel(widget);
    }

    // Fall back to typing, in the locale's format.
    if (input && !input.readOnly) {
      const fallback = ctx.persona?.futureDateLocal || ctx.persona?.futureDate || '';
      return await typeDate(widget, input, value || fallback);
    }
    return null;
  }

  // ------------------------------------------------------------------- text ----
  async function fillText(widget, value) {
    const input = widget.root.querySelector(widget.lib.input || 'input, textarea, [contenteditable]');
    if (!input) return null;
    const v = Array.isArray(value) ? value[0] : value;
    if (v == null || String(v) === '') return null;      // "null" is not test data

    const written = typeInto(input, v);
    if (input.isContentEditable) return written;

    commit(input);
    await settle(() => String(input.value || '') !== '', 180);
    if (!input.value) {
      // Second attempt through the native setter, then commit again.
      setNativeValue(input, String(v));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: String(v), inputType: 'insertText' }));
      commit(input);
      await settle(() => String(input.value || '') !== '', 180);
    }
    return input.value || written || null;
  }

  // --------------------------------------------------------------- dispatch ----
  async function fill(widget, value, ctx) {
    ctx = ctx || {};
    try {
      switch (widget.kind) {
        case 'choice': return await fillChoice(widget, value, ctx, false);
        case 'multichoice': return await fillChoice(widget, value, ctx, true);
        case 'inline-choice': return await fillInlineChoice(widget, value, ctx);
        case 'autocomplete': return await fillAutocomplete(widget, value, ctx);
        case 'date': return await fillDate(widget, value, ctx);
        case 'bool': return await fillBool(widget, value, ctx);
        case 'radio': return await fillBool(widget, value === undefined ? true : value, ctx);
        case 'radio-group': return await fillRadioGroup(widget, value, ctx);
        default: return await fillText(widget, value);
      }
    } catch (err) {
      note(`${widget.id}: threw while being driven — ${err && err.message || err}`);
      return null;
    }
  }

  // Diagnosis for a choice or date widget: does it open, and what does it offer?
  async function probe(widget) {
    const out = { id: widget.id, kind: widget.kind, before: displayedValue(widget), opened: false, overlay: null, options: [], count: 0 };
    if (widget.kind === 'date') {
      const input = widget.root.querySelector('input');
      out.readOnly = !!(input && input.readOnly);
      out.value = input ? input.value : '';
      press(input && !input.readOnly ? input : widget.root);
      const panel = await waitFor(() => ownPanels(widget).find(p => p.querySelector('td, [class*="day"]')), 1200);
      out.opened = !!panel;
      if (panel) {
        const all = safeQuery(panel, 'td span, [class*="day-cell"]').filter(c => /^\d{1,2}$/.test(textOf(c)));
        const on = all.filter(c => !(c.getAttribute('aria-disabled') === 'true'
          || c.classList.contains('p-disabled')
          || (c.parentElement && c.parentElement.classList.contains('p-disabled'))));
        out.count = on.length;
        out.options = [`${on.length} of ${all.length} days selectable`];
        const title = panel.querySelector('[class*="title"], [class*="month"]');
        out.overlay = title ? textOf(title).slice(0, 40) : 'panel';
      }
      await dismissPanel(widget);
      return out;
    }
    if (!['choice', 'multichoice', 'autocomplete'].includes(widget.kind)) return out;
    let overlay = null;
    try { overlay = await openOverlay(widget); } catch (e) { out.error = String(e.message || e); }
    out.opened = !!overlay;
    if (overlay) {
      out.overlay = (overlay.className || overlay.tagName || '').toString().slice(0, 70);
      const opts = optionsIn(overlay, widget.lib);
      out.count = opts.length;
      out.options = opts.slice(0, 8).map(o => textOf(o));
      const sc = scrollerFor(overlay);
      out.scroller = sc ? {
        cls: (sc.className || sc.tagName || '').toString().slice(0, 60),
        clientHeight: sc.clientHeight, scrollHeight: sc.scrollHeight
      } : null;
      if (sc) {
        const wasTop = sc.scrollTop;
        const seenTexts = new Set(opts.map(o => textOf(o)));
        const step = Math.max(80, Math.floor(sc.clientHeight * 0.85));
        for (let i = 0; i < 25; i++) {
          const was = sc.scrollTop;
          sc.scrollTop = was + step;
          sc.dispatchEvent(new Event('scroll', { bubbles: true }));
          await sleep(80);
          optionsIn(overlay, widget.lib).forEach(o => seenTexts.add(textOf(o)));
          if (sc.scrollTop <= was) break;
        }
        out.afterScroll = seenTexts.size;
        out.sample = [...seenTexts].slice(-6);
        out.overlayStillInDom = document.contains(overlay);
        sc.scrollTop = wasTop;
      }
      try { await closeOverlay(widget); } catch (_) { }
    }
    return out;
  }

  globalThis.FormForgeWidgets = {
    detect, claimed, labelFor, displayedValue, fill, probe,
    takeChoiceTimings: () => choiceTimings.splice(0, choiceTimings.length),
    // content.js reaches the dom layer through this bundle; anything it needs must be listed here.
    helpers: { press, key, typeInto, setNativeValue, commit, sleep, waitFor, settle,
               visible, textOf, norm, optionsIn, note, takeNotes, PLACEHOLDER }
  };
})();
