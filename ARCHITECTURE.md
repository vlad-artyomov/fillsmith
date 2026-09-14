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
   position otherwise. Bounded; never a dependency.
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

**Overlays**

- Every overlay question is scoped to the widget that owns it — through `aria-controls`, or by being an element that was
  not there before the press. "Any open panel" belongs to somebody else's control.
- A closing overlay stays visible and full of options for its whole leave transition; the previous control's overlay is
  always mid-leave when the next opens.
- `aria-expanded="true"` proves open; `"false"` does not prove closed. Ask the DOM.
- A panel on screen before the fill (an inline calendar) is not ours to close.
- Escape means *cancel* to a date picker; click away once a value is committed.
- A dropdown is opened once per fill. Remember what was committed and restore that.

**Writing values**

- Type, do not assign: `execCommand('insertText')` produces the events controlled inputs accept. It writes wherever the
  caret is, so check focus landed first.
- Write, then commit (blur), then read back. Report only what the control holds.
- A placeholder is not a value; ask the component (`p-placeholder`, `-empty`), then the wording.
- Dates and times go in the locale's format; ranges are ordered; a birth date is typed, not clicked.
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
- Standing instructions live in the session; each batch runs on a `clone()` so requests do not grow; batches run
  together.
- "Still loading" and "no model" are different answers and get different advice.
- Count a model answer where it lands in the form, not where it arrives.

**Showing the work**

- Nothing FormForge writes goes to the console: a content-script warning is a red *Errors* badge on the extension. Notes
  go to the Debug tab.
- The indicator's stylesheet starts with `all: initial !important`; every rule in it is important too, run-time values
  travel in custom properties, hiding is a class.
- One progress bar for the whole job, and it only moves forward.
