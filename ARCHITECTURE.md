# Architecture

FormForge is a Chrome MV3 extension with no build step: plain ES2020 scripts, loaded in order, each handing its public
surface to `globalThis`. This document is the shape of the thing and the rules that shaped it. README.md is what it does
for a user.

## Layers

Nothing runs until asked. Pressing Fill injects the filler into the page once (`content.js` returns early if it is
already listening), and each file depends only on the ones above it:

| File           | Answers                                        | Knows about                     |
|----------------|------------------------------------------------|---------------------------------|
| `dom.js`       | How do I make the page believe a change?       | nothing                         |
| `vocab.js`     | What words are there to choose from?           | nothing — a generated data file |
| `generator.js` | What value should this field hold?             | nothing in the DOM              |
| `adapters.js`  | What is this control, and what is it called?   | `dom`                           |
| `overlays.js`  | Where is this control's popup, and is it mine? | `dom`                           |
| `fillers.js`   | How do I drive this kind of control?           | `dom`, `adapters`, `overlays`   |
| `uploads.js`   | What file do I put in a file input?            | nothing                         |
| `hud.js`       | What does the person watching see?             | nothing                         |
| `content.js`   | In what order, and did it stick?               | all of the above                |

Outside the page, `background.js` owns the model and **the list of injected files**; the popup, the shortcuts and every
test suite read that list rather than carrying a copy. `popup.*` is a Fill button, a dry run, a clear, settings and a
debug trail.

Why these seams: `generator.js` never touches the DOM, so every rule is a pure function. *Identifying* a control
(permissive: an unknown library should still work through ARIA) and *driving* it (exact: this one commits on blur, that
one cancels on Escape) are different problems, so `adapters.js` and `fillers.js` are separate. `overlays.js` exists
because popups are teleported to `<body>` and are therefore global, while every question about them is local — giving
that a file makes the rule enforceable.

## The pipeline

For each field, the first step that answers wins:

1. **Rule** — ordered `[regex, persona => value, tag?]` in `generator.js`. Specific above general, because `describe()`
   folds `name`/`id` into the label and `address.zip` contains "address". A rule tagged `WEAK` (generic prose: "notes",
   "description") is a floor: the field is also offered to the model, and the rule fills it only if the model does not.
2. **Type default** — number, date in the locale's format, time, prose, markup.
3. **Model** — one batched request with the persona and the page's context (a dialog title beats a breadcrumb beats
   `document.title`, which on an SPA is the product name everywhere). Each field is described by its whole contract —
   type, section, required, limits, options — so the answer fits. Replies are matched by id where recognisable and by
   position otherwise. Bounded; never a dependency. The request is *asked, not awaited*: writing starts as soon as the
   form has been read, a field the model owns is written the moment its answer lands, and only what is still
   outstanding when the form runs out of fields is waited for.
4. **Fallback** — text named after the field, or a seeded pick among real options.

`constrain()` then clips the value to `maxlength`, `min`/`max`/`step` and `pattern`.

## After the write

`run()` loops until the form stops changing: re-write what a component reverted, retry what wrote nothing, fill what our
own writes revealed, then pause once and look again. A field is identified by name/id (and by caption only when its
original node left the DOM), so a node the framework rebuilt gets its *original* value back rather than a freshly
invented one. The same loop reads the form's own complaints: a maximum that lives only in a validation schema reaches
the DOM as the message under the field, so a value it calls too long is shortened to what it asks and written again.

## Entry points

The popup's Fill button injects and dispatches. Shortcuts and the *Fill this page* context menu go through `send()` in
the worker, which puts an indicator on the page *before* injecting. *Fill just this field* (the context menu) and
`Alt+Shift+D`
fill one control with no ordering or repair loop. From the keyboard the field is the focused one; from the menu it is
the one under the pointer, which `content.js` records with its own `contextmenu` listener since Chrome does not say
what was clicked.

## Telling the user

`#formforge-hud` on the page shows the stage, the progress and the result in one element, and relays each stage to the
popup through `fill-progress`; the toolbar icon animates off the same signal. The result names what did not work. The
Debug tab keeps the whole trail in `chrome.storage.local`, written by `content.js` so keyboard-triggered fills are
recorded too.

## Verification

Judge a fill by the page, not by our report. Every filler reads its control back and returns what it holds.
`test/complete.mjs` presses Fill once on a clean page and asks the page whether every required control now holds a
value. `tools/audit.mjs` drives the real extension and watches the indicator, the overlays, the console and the icon
*while* a fill runs — a still screenshot cannot tell a working progress bar from a frozen one.

## Rules learned the hard way

Each of these was a bug on a real form and has a regression check.

**Adapters**

- Only the outermost match survives, so a false outer match is not a near miss: it silently replaces the real control
  with a worse one. `root` is the one entry in `LIBS` that has to be exact — something only that library renders —
  and everything else is a hint. `.multiselect` is also what an application calls its own wrapper, and one such
  wrapper hid the PrimeVue MultiSelect inside it: no label selector, no option selector, and a read-back that
  returned the caption the wrapper holds.

**Overlays**

- Every overlay question is scoped to the widget that owns it — through `aria-controls`, or by being an element that was
  not there before the press. "Any open panel" belongs to somebody else's control.
- A closing overlay stays visible and full of options for its whole leave transition; the previous control's overlay is
  always mid-leave when the next opens.
- The class that says a panel is leaving sits on the overlay wrapper, while `aria-controls` names the list inside it —
  which has no such class and full opacity of its own. Ask the ancestors, or every dropdown reads as open for its whole
  fade and gets chased with Escapes and clicks it does not need.
- `aria-expanded="true"` proves open; `"false"` does not prove closed. Ask the DOM.
- A panel on screen before the fill (an inline calendar) is not ours to close. Libraries mark one on the wrapper or
  on the panel itself, so both spellings count — a booking form showing one had every date field spend a second
  trying to close the page's own calendar.
- Escape means *cancel* to a date picker; click away once a value is committed.
- A panel is this control's or it is not; what it *shows* is a second question. Deciding a picker had opened only
  once a day cell appeared meant a year-scoped one never counted as open: the search ran to its budget, the
  month-paging loop ran to its own, and the value came from typing at the end — 2.4 seconds a field against 0.2.
- A control closes its own panel before the next one is touched. Left to the end-of-fill sweep, which gets three
  presses for everything it finds, five opening-hour rows finished the fill under a stack of five time panels.
- A press that lands while any panel is on screen can be spent closing that one — including this picker's own, left
  over from the fill before, which toggles shut rather than open. One more press on a quiet page is the fix; a
  control still saying `aria-expanded="false"` declined outright and is not worth the second wait.
- A day grid matches twice over — once as the cell, once as the day inside it — and the library binds its click to the
  inner one. A pool holding both filled about half the date fields, differently on every seed.
- A dropdown is opened once per fill. Remember what was committed and restore that.
- `data-formforge-opened` means "ours, and possibly still up", so it is cleared the moment the panel closes — by
  whatever closes it. Only `closeOverlay` was taking it off, so a panel that outlived it and was shut by the
  end-of-fill sweep kept the mark for the life of the page, and the next scan read the fields under it as a popup's
  own furniture and skipped them. Both readers are misled by a stale one, so a fill clears them at both ends.

**Writing values**

- Type, do not assign: `execCommand('insertText')` produces the events controlled inputs accept. It writes wherever the
  caret is, so check focus landed first.
- Write, then commit (blur), then read back. Report only what the control holds.
- Which way to write is decided by what the element *is* — a form control has a `value` setter on its prototype —
  never by whether it happens to carry a `value` property. The control branch used to invent one on whatever it was
  handed, so a rich-text editor written to once while the form had it switched off became a "form control" for the
  rest of the page's life, and its markup went in as visible tags, appended rather than replaced.
- A control the form has switched off (`contenteditable="false"`, `ql-disabled`) takes nothing and is not collected.
  Reporting it as filled is the same lie as reporting what was typed instead of what the control holds; the pass that
  runs after our own writes picks it up once the form has enabled it.
- A placeholder is not a value; ask the component (`p-placeholder`, `-empty`), then the wording.
- A control that states its own date format outranks the locale the data is in: a German form handed 11/24/2026
  discards it without a word, and the field reads as skipped with nothing to explain it. Otherwise dates and times go
  in the locale's format; ranges are ordered; a birth date is typed, not clicked.
- A phone beside a country picker gets the national number. A control's own popup (its search box) is not a field.
- `null` means "pick one yourself" and only a choice or a bool can honour it.
- A radio group is one field. Only the outermost widget match wins. A required choice is never left empty; when no
  option matches, take a valid one and say so in the notes.
- A time-only picker takes no typing; drive its spinners. A picker scoped to years wants a year.
- An empty file input is what a successful upload looks like; attach once per field and never repair.

**Finding fields**

- Rule matching ignores the section legend, or "Registered address" wins the address rule for the postcode inside it.
- The caption is the first label fragment with two letters; an asterisk in any fragment means required.
- Page chrome (a language switcher) and CAPTCHA-shaped fields are skipped by whole-word patterns.
- A field is identified by name/id across re-renders, not by DOM node.
- A fill starts by removing the marks the previous fill left. A control disabled at collect time is skipped, and a
  stale mark would hide it from the later passes once this fill has enabled it (Fill → Clear → Fill).

**Waiting**

- Poll a condition; never sleep a fixed time. Every search gets a budget, and the caller sets it.
- A list that comes over the network says so while it loads (a spinner on the trigger, a loader in the panel,
  `aria-busy`). Wait on that state, never on a fixed clock — and PrimeVue ignores clicks on a trigger that is still
  loading, so wait before pressing it too.
- Search a list only for a candidate that could be in it: a country, a city, a salutation. An invented company name is
  in nobody's list, and asking a server-side filter for it costs two round trips to learn nothing.
- An open modal dialog is the whole form. Nothing under its mask is a field, and no popup inside it is closed with
  Escape or a click on the body: both reach the dialog's own listeners and close it. Click the dialog's header instead.
- The node a control names through `aria-controls` is the list itself; the filter box, the loader and the empty
  message live in the panel around it, and a server's answer to a filter may replace the list node under the same id.
  Look things up from the panel, and hold the id rather than the node.
- A filter that answers from the rows it already holds, then asks the server, has not answered until the loader that
  follows has cleared; a "no results" left over from the previous query is not a reaction to this one.
- A sorted virtualised list is binary-searched by scroll position; an unsorted one is walked. When a match is required
  and not in sight, the filter is asked, under every spelling the persona knows for its country: the rows on screen say
  nothing about what a virtualised window or a server's page leaves out, and a client-side miss answers at once.
- An autocomplete asks its shortest query first and its full candidate last; a panel that says "no results" has
  answered.

**The model**

- Never block on the model. Session creation, the download and the answer each have their own budget; the download is
  opt-in.
- Ask it, then get on with the form. The deadline runs from the request rather than from the moment somebody starts
  waiting, so overlapping the request with the writing shortens a fill and never lengthens the patience the setting
  promises.
- Declare the languages a fill uses when creating the session; undeclared, a German form gets English values back.
- Standing instructions live in the session; each batch runs on a `clone()` so requests do not grow; batches run
  together.
- "Still loading" and "no model" are different answers and get different advice.
- Count a model answer where it lands in the form, not where it arrives.
- The model copies the shape of the example it is shown. The response schema constrains the decoder but is never
  spelled out in the prompt (`omitResponseConstraintInput`), so the skeleton on the last line is the only shape the
  model ever sees — and a skeleton holding one `{"id":N}` came back with one value for a batch of twelve, in under
  two seconds, looking for all the world like a model that simply had nothing to say. List every id.

**Showing the work**

- Nothing FormForge writes goes to the console: a content-script warning is a red *Errors* badge on the extension. Notes
  go to the Debug tab.
- The indicator's stylesheet starts with `all: initial !important`; every rule in it is important too, run-time values
  travel in custom properties, hiding is a class.
- One progress bar for the whole job, and it only moves forward.
- The result toast is what says the job is over, so it is what sends `done` — every ending, not just the happy
  one. While only "filled N fields" reported it, a fill that found nothing to fill left the toolbar icon animating
  until its 90-second watchdog, which is indistinguishable from a fill still running. The shortcut path hid it:
  `send()` turns the icon off in a `finally`, and the popup does not go through `send()`.
- The toolbar mark has one definition, `drawMark()` in the worker, because the icon that sits still and the icon
  that animates are the same silhouette. `tools/icons.mjs` renders the shipped PNGs from it rather than beside it;
  a hand-made set drifts from it, and the 128 in this repo was a scaled-up 32 with stair steps on its corners.
