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
| `collect.js`   | What is on this page, and what is it called?   | `fillers`, `overlays`           |
| `model.js`     | What does the model say, and has it said it?   | `collect`, `hud`                |
| `content.js`   | In what order, and did it stick?               | all of the above                |

Outside the page, `background.js` owns the model, **the list of injected files**, the record of what every fill did,
and the one migration a profile from an older build needs; the popup, the shortcuts and every test suite read that
list rather than carrying a copy. `popup.*` is a Fill button, a dry run, a clear, settings and a debug trail;
`report.*` is the same trail on a page of its own, and `welcome.html` is the one screen a fresh install opens.

Why these seams: `generator.js` never touches the DOM, so every rule is a pure function. *Identifying* a control
(permissive: an unknown library should still work through ARIA) and *driving* it (exact: this one commits on blur, that
one cancels on Escape) are different problems, so `adapters.js` and `fillers.js` are separate. `overlays.js` exists
because popups are teleported to `<body>` and are therefore global, while every question about them is local — giving
that a file makes the rule enforceable. `collect.js` and `model.js` came out of `content.js` when it reached 1675
lines: reading the page changes nothing in it, and the model conversation outlives the fill that starts it, so
neither belongs in the file that orders a fill. What is left is the ordering, the writing and the repair.

## The pipeline

For each field, the first step that answers wins:

1. **Rule** — ordered `[regex, persona => value, tag?]` in `generator.js`. Specific above general, because `describe()`
   folds `name`/`id` into the label and `address.zip` contains "address". A rule tagged `WEAK` (generic prose: "notes",
   "description") is a floor: the field is also offered to the model, and the rule fills it only if the model does not.
2. **Type default** — number, date in the locale's format, time, prose, markup.
3. **Model** — one batched request with the persona and the page's context (a dialog title beats a breadcrumb beats
   `document.title`, which on an SPA is the product name everywhere). Only fields it can improve are in it: not files,
   not booleans, and not a closed list the page spells out — asking which of "01…12" to use is asking the model to read
   the markup back, at the price of a slot in a batch and a share of the deadline. A list earns a question only when
   the persona settles it (a country, a salutation) and no rule already has. Each field that is asked is described by
   its whole contract — type, section, required, limits, options — so the answer fits.

   Replies are matched by the ids the model echoes. Position is a fallback for a reply that names none at all, and only
   when the count is exact: a reply one entry short or long slides every field after the gap into its neighbour's slot,
   and a state in the phone box reads as data rather than as a miss. An odd entry among named ones is dropped.

   **Nothing waits for it.** The first pass writes every field with the best answer that exists then — a rule's, the
   control's own, or the filler's — so the form is complete in milliseconds. Each batch that lands afterwards replaces
   what it finds, and the request's window is the work it was given (about 600 ms a field), not a fixed ceiling: a
   twelve-second one was below the work on any form of more than two batches, so the last batch was aborted on every
   fill and the fields it held kept filler values. A slow model now costs a better answer arriving a moment later,
   never a wait and never a lost batch. The request is *asked, not awaited*: writing starts as soon as the
   form has been read, a field the model owns is written the moment its answer lands, and only what is still
   outstanding when the form runs out of fields is waited for.
4. **Fallback** — a short phrase from the persona's vocabulary, or a seeded pick among real options. Never the
   caption echoed back with a number: it traces nicely and exercises nothing, and the Debug tab is where a reader
   finds out which field got what.

`constrain()` then clips the value to `maxlength`, `min`/`max`/`step` and `pattern`.

## After the write

`run()` loops until the form stops changing: re-write what a component reverted, retry what wrote nothing, fill what our
own writes revealed, then pause once and look again. A field is identified by name/id (and by caption only when its
original node left the DOM), so a node the framework rebuilt gets its *original* value back rather than a freshly
invented one. The same loop reads the form's own complaints: a maximum that lives only in a validation schema reaches
the DOM as the message under the field, so a value it calls too long is shortened to what it asks and written again.

## Entry points

Every entry point asks the page through `askPage()` in the worker. A page is usually several frames — an analytics
pixel, an ad, an embedded form — and the filler runs in all of them, so a broadcast to the tab comes back as one
frame's answer picked by whichever replied first: a hidden 0×0 tag-manager frame reporting "cleared 0 fields" over a
form that just lost forty. `askPage()` lists the frames that carry the filler, asks each one by id, and adds up what
they say; the busiest frame's persona and verdict describe the run. A frame with nothing to fill or clear also stays
off the progress channel, so its stages cannot land in the popup on top of the frame doing the work.

The popup's Fill button injects and dispatches. Shortcuts and the *Fill this page* context menu go through `send()` in
the worker, which puts an indicator on the page *before* injecting. *Fill just this field* (the context menu) and
`Alt+Shift+D`
fill one control with no ordering or repair loop. From the keyboard the field is the focused one; from the menu it is
the one under the pointer, which `content.js` records with its own `contextmenu` listener since Chrome does not say
what was clicked.

## Telling the user

`#formforge-hud` on the page shows the stage, the progress and the result in one element, and relays each stage to the
popup through `fill-progress`; the toolbar icon animates off the same signal. The result names what did not work. The
whole trail lives in `chrome.storage.local`, written **by the worker** in `remember()` after `askPage` has added the
frames up — the last ten fills in full (`fillHistory`) and the last hundred in outline (`fillLog`). "It worked a
minute ago" is a comparison, and the trail of the fill before the broken one is the half that makes it; the Debug tab
points at any of the ten, and `src/report.html` renders all of them on a page of its own.

Three surfaces, and each is the size of its job. The card is the verdict, four words wide, and takes itself off
screen. The Debug tab is the last fill, in a 360px column: what every field got, why, and how the run of fills has
been going. The report page is a tab — read it, copy it, or save it as one text file to attach to a ticket. It is a
page rather than a button because a popup closes the moment a save dialog takes focus, which is what the `downloads`
permission was for.

`src/welcome.html` opens once, on install: three steps and the shortcuts as Chrome actually bound them. Before it,
a first press on a page with no form was indistinguishable from nothing happening.

## Verification

Judge a fill by the page, not by our report. Every filler reads its control back and returns what it holds.
`test/complete.mjs` presses Fill once on a clean page and asks the page whether every required control now holds a
value. `tools/audit.mjs` drives the real extension and watches the indicator, the overlays, the console and the icon
*while* a fill runs — a still screenshot cannot tell a working progress bar from a frozen one.

The fixtures are where a library's markup lives: `test/primevue-form.html` is the hard page (remote lists, a modal,
an editor, uploads that answer late), `test/libraries-form.html` holds one select per library `LIBS` claims, and
`test/demo-form.html` is the quick one the README's recording is made on.

`npm run typecheck` reads the JSDoc and `types/` over the logic — the generator, the worker, the adapters, the
overlays, the fillers and the model client — and emits nothing. `popup.js`, `content.js` and `collect.js` are left
out on purpose: they are almost
entirely DOM narrowing, and ninety complaints that `getElementById` returns an `HTMLElement` would bury the one that
mattered. `model.js` is checked, and the first thing the checker caught there was two names its move out of
`content.js` had left behind — a class of mistake no suite sees until the path that uses them runs. What it is for is the shapes that travel between files, where a misremembered property name is silent at
run time and reads as a control that would not take a value.

## Why `<all_urls>`

It is the permission that costs the most at install — "read and change all your data on all websites" — so it was
measured rather than argued about. An extension with `activeTab` and `<all_urls>` as an *optional* permission was
built and driven against a page with a form, and a page whose form is partly inside a frame from another origin:

- `chrome.scripting.executeScript` fails outright with *"Cannot access contents of the page. Extension manifest must
  request permission to access the respective host"* on any path that did not start with a user gesture Chrome
  itself counts. The three real entry points do; **nothing automated does**, so the extension suite and
  `tools/audit.mjs` — the two things that judge FormForge by the page — could no longer drive a fill at all.
- `chrome.tabs.query` stops reporting `url` and `title`, which is how the suites and the audit find the tab.
- A cross-origin frame needs the optional grant anyway, and asking for it opens a dialog no test can answer. An
  embedded payment or booking form is exactly the case a tester needs filled.

So the permission stays, and the Store listing says why in the same words. The thing that makes it defensible is not
the manifest but the behaviour: there is no declared content script, nothing runs while you browse, and the filler is
injected into one tab, on your action, and never on its own.

## Rules learned the hard way

Each of these was a bug on a real form and has a regression check.

**Adapters**

- Only the outermost match survives, so a false outer match is not a near miss: it silently replaces the real control
  with a worse one. `root` is the one entry in `LIBS` that has to be exact — something only that library renders —
  and everything else is a hint. `.multiselect` is also what an application calls its own wrapper, and one such
  wrapper hid the PrimeVue MultiSelect inside it: no label selector, no option selector, and a read-back that
  returned the caption the wrapper holds.

- The name a control states beats anything guessed from what sits near it. A MUI Select names its label through
  `aria-labelledby` on the combobox and wraps a nameless input, so the first thing `describe()` found was the
  placeholder beside it: three libraries came out called "Select…", and one took the caption of the field above it.
  The order is ARIA, then the inner control's own label, then a label pointing at the root — ids are not unique on
  real pages, and putting the root's label first had a date picker answering to the caption of a file input that
  shared its wrapper's id.
- Nine libraries, nine markups, and `test/libraries-form.html` carries one of each. Eight of them had never been
  driven by anything — they were selectors nobody had watched match, and a wrong one does not miss a control, it
  claims one and drives it blind.

**Overlays**

- The trigger is never the panel, and a press lands on the deepest surface rather than the root. Choices.js and Tom
  Select render their list inside the control with "dropdown" in its class, so "the first thing whose class says
  dropdown" pressed the hidden list and both reported "would not open" on every field; and a listener bound to a
  child — Tom Select's control, react-select's control div, Select2's selection — never hears a press on the root
  above it, while a listener on the root hears one on a child.

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
- An upload is the one thing a fill starts and does not finish, so the fill waits for it. The row that comes back —
  the file's caption, its alt text, its "show this one" switch — is a field this fill caused, and on a short form
  the fill is over in eighty milliseconds while the row lands a second later: left alone, those fields were found by
  the *next* run, which filled the previous run's rows and left its own. The patience runs from the attach, as the
  model's does from its request, so a form with plenty still to do pays nothing for it, and it is bounded: a server
  that never answers gets a note, not an open-ended fill.
- A file input is never offered to the model. The bytes are made in the page from the seed to match the input's own
  `accept`; asked anyway, it replied "image1.jpeg" and "Technical specifications.pdf" — two slots of a batch of
  twelve spent on names nothing reads.
- Clear presses a remove button only inside a row that names a file we generated. "The nearest ancestor holding any
  delete button" is the card the uploader sits in as soon as our rows are gone, and the delete button in that card
  belongs to the record: Clear removed an attachment the tester had uploaded and pressed "Delete location".
- The uploads a fill waits for belong to that fill. The list lived for the page, holding a DOM zone per attached
  file, and on an SPA every fill pinned a few more detached subtrees for good.
- A report row is found by seat, not by caption. An uploader's rows all read "Alternative text", and a complaint
  about the first row's length marked the last row's entry — which then carried the first row's shortened value
  while the first row's entry kept the long one, a form that did not exist.
- Only a positive sign means a choice has been made: a selected option, a value in the inner input. "No placeholder
  class in sight" used to pass for one, and a select that had reverted its value — blank label, no placeholder —
  was believed to hold a choice, so the repair pass left it empty.

**Finding fields**

- Rule matching ignores the section legend, or "Registered address" wins the address rule for the postcode inside it.
- The caption is the first label fragment with two letters; an asterisk in any fragment means required.
- Page chrome (a language switcher) and CAPTCHA-shaped fields are skipped by whole-word patterns.
- A field is identified by name/id across re-renders, not by DOM node.
- Rows a page renders one per item — an uploaded file's alt text, its source, its "show this one" switch — have no
  name and no id and are captioned like the row above, so the label key is the same key for all of them. They are
  numbered in DOM order, over *every* such field on the page and not merely the ones the pass collected: a later
  pass collects only what is still empty, so counting the collected ones gave the third row the first row's number
  and, with it, the first row's value. Four rows read as one field, and it showed only on a second fill.
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

- Clear empties an editor through the door it converts, exactly as the fill writes to it. `textContent = ''` edits
  what the editor is showing, not the model it keeps, and it puts its own content back on the next tick: six
  editors on a device form were reported cleared and every one of them still held its text. The other half of that
  miss is that a library marks its wrapper, not the surface inside it, so the branch for a contenteditable never
  saw them.
- The name of one of our files carries no word boundary. A tile renders it against its neighbours with nothing
  between them, `PDFformforge-a1.pdfHochgeladen`, and a `\b` on either side sits between two letters. Two PDFs
  survived every Clear for that reason while two images went; the prefix is ours and needs no fence.
- Take attachments off one at a time, asking the page again each time. Removing one re-renders the list, so every
  other button in a list taken beforehand is a node that is no longer on the page: pressed, it does nothing, and
  four attachments came off as two.
- Clear looks for our own attachments by name across the whole page, not only under the input it used. A component
  that takes the files rebuilds its input, and the filler's mark goes with it, so by the time Clear runs there is
  nothing to walk up from — the rows it rendered are all that is left, and they name our files.
- A required key in the grammar may still be answered with an empty string. It was, five times on a batch of
  sixteen, and those fields reached the filler as "Cyan Chair 16" while the report said the model had answered.
  `minLength: 1` makes declining impossible rather than silent.
- Collect every option a list offers, however many that is. They were truncated at forty, and the truncation was
  invisible: the wanted option was simply absent, the match missed, and the random pick that follows a miss came
  out of the same forty. On a 250-country select a US persona lived in Aruba, Belize or Burkina Faso, ten fills out
  of ten, reported as a rule that had matched. A cap belongs where a cap is needed — the model's prompt takes
  twenty — not where the choice is made.
- An autocomplete that answers the broadest probe it will be given with nothing at all — no list, no "no results",
  nothing loading — has no list to show, and the probe after that only learns it again. Measured on a white-label
  domain field: a second and a half on every fill, eleven fills running, for suggestions that do not exist.
- A rich-text editor keeps a model of its content, not the DOM it is handed. Quill has no `<ul>` — it renders a
  bullet list as `<ol><li data-list="bullet">` — so markup written in with `insertHTML` was a shape it could not
  name and it rebuilt the editor without it on its next tick, 7ms later, after the filler had already read the
  field back as full. Markup goes in as a **paste**, which is the door an editor converts rather than the one it
  polices, and the readback happens on the far side of the editor's own pass. An editor that kept nothing is given
  the words without the markup. `test/primevue-form.html` models both halves of Quill so the suite can see it.
- Plain words go into an editor as paragraphs, never at a caret. `insertText` applies the formatting of wherever the
  selection starts: a model's answer dropped over content that opened with `<strong>Note:</strong>` came out bold,
  every line of it, and read as a worse answer than the one it replaced.
- A page with five editors on it must not get the same text five times. The layout has four shapes and is drawn
  from a stream seeded by the field, so between them a form exercises bold, italic, a bullet list and a numbered
  list instead of one path five times over. The same field on the same seed still says the same thing.
- A value a whole column shares is one value tested many times. Four upload rows all carried the same alt text and
  the same source, because both hung off the persona; a caption and a source are drawn per call now, from the
  persona's own stream, so the order of the calls still reproduces from the seed.
- The model answers such a field in prose, and prose exercises nothing the control does. Its sentences are laid into
  the same skeleton the rule builds — a bold lead-in, a paragraph with the italic note, a list — so the words are
  the model's and the markup is ours. Asking the model for markup instead was a line in every prompt that the
  on-device model ignored. The layout draws on its own stream, seeded from the persona and the answer: batches
  finish in whatever order they finish, and taking from the persona's sequence here would make the rest of the page
  depend on that order.

**The model**

- Weights on the disk are not a running model. `availability()` says the first; a session takes about half a minute
  to build and dies with the worker. The pill read "model ready" over a cold one, which is the extension promising
  what the next fill cannot deliver, so the two are reported apart and the popup watches the build it started.
- A fill waits out a session that is coming up, because the form is finished before the window opens. Three seconds
  against a twenty-eight-second create meant the first fill after Chrome starts never had a model — on the day
  somebody installs this for its AI — and nothing on screen said why. The window is twenty-five seconds now, the
  card says what it is waiting for, and a fill that ends without the model still says the model is on its way.
- Coming up and answering are different waits and take different times, so the card names which one it is. Reported
  as "AI is still answering 0/5", a model that was only being loaded read as a model thinking very hard about five
  fields — and the popup said "model starting" while the page did not. The card carries the same clock, which means
  the loop that draws it wakes once a second as well as on a batch.
- A window that long must not make the page unusable. A fill that is only waiting for the model has finished
  writing, so the next press cuts it short and goes ahead instead of being told the page is busy.
- Never block on the model, and that includes bringing it up. A cold `create()` takes as long as it takes —
  twenty-eight seconds, measured — so the session gets a small grace on top of the work the fill is doing anyway,
  not its whole cold start. A session that arrives while the form is being written costs nothing; one that does not
  finishes in the background and the next fill has it. Waiting it out bought a better postcode at the price of a
  form that sits there, and sometimes bought nothing at all. The answer's patience is separate, and is the setting.
- A request past its deadline is aborted, not merely ignored. `prompt()` takes a `signal`; without one the worker
  keeps generating for an answer the fill has already thrown away, and the single on-device session is busy until it
  finishes — so the next fill queues behind it and reads as a hang.
- The model is unloaded once no session is alive, and the worker Chrome stops after half a minute idle takes the
  session with it. A build nobody holds up is therefore killed before it finishes — waiting on `create()` is not
  activity Chrome counts — and "the next fill has it" was false: every fill started a build from zero and the model
  answered only when somebody pressed Fill four or five times in a row, fast enough that the presses themselves kept
  the worker awake. So the build holds the worker up while it runs, and the session it produces holds it up for ten
  minutes after the last use. One ticker does both; a hold that never expires is a worker that never sleeps.
- The worker warms wherever somebody is about to fill — the popup opening, a shortcut, a menu click — and nowhere
  else: bringing the model into memory alongside whatever woke the worker made the browser itself feel slow, and a
  warm-up on `onStartup` did the same at every Chrome launch, on days no form was ever opened. Nothing is downloaded
  on that path — a model that is not on disk is left alone.
- Answers go back to the frame that asked, never to the tab. Every frame runs the filler and numbers its own fields
  from zero, so a batch broadcast to the tab landed in every frame that was filling: an iframe's form took the top
  form's answers under the same numbers, and its own batch, arriving later, found those fields already written.
- One record per request. The worker kept a single "last exchange", and two frames asking at once pushed their
  batches into whichever record was created last — each frame's Debug tab then showed two prompts for its three
  fields, and the worker wrote one request's session time into the other's record.
- A value that says "no value" is not an answer. "N/A" in a city box is a form that looks filled and validates
  nothing; the field falls through to the rules or the filler instead.
- How long a session has been coming up is reported, not just that it is. The number rising from one fill to the
  next is a build on its way; the same number twice is one that is starting over.
- Ask it, then get on with the form. The deadline runs from the request rather than from the moment somebody starts
  waiting, so overlapping the request with the writing shortens a fill and never lengthens the patience the setting
  promises.
- A hosted request's extras are the model's to accept. Anthropic takes `output_config.effort` on the current models
  and answers HTTP 400 naming it on Haiku 4.5 — and the model is a string the tester types, so a table here of which
  ones accept what would be a second place to go stale. The option goes out, a refusal that names it drops it and
  sends the request again, and the refusal is remembered for that model so it is paid once, not once per batch.
- The fixture reads in English and its option lists stay German, on purpose: the labels are what a screenshot and a
  reader see, the options are what a persona has to match — the country list is alphabetical, 240 long and German
  only, as the application's is. A German *label* is checked in `test/run.mjs` instead, against `matchRule` directly,
  so the German half of every rule pattern keeps a test: that check is what found `\btelefon\b` never reaching
  "Telefonnummer".
- Declare the languages a fill uses when creating the session; undeclared, a German form gets English values back.
- And then say which one to use, in the request. Left to infer it from the labels — which is what "match the page
  language" asked for — the model reads the labels, and a German application is very often labelled in English: a
  tester who picked DE got German from every rule, the city, the postcode, the prose, and English sentences from the
  model in the same form. The language is a setting, so it comes from the setting.
- The prompt has a budget, because on a small on-device model its length is most of the latency. A batch of twelve
  fits in 1100 characters and a check holds it there. What that budget buys is an argument every line has to win:
  the ids were listed three times — on each field line, in a prose line, and in the JSON skeleton — and the skeleton
  is the one that made a batch answer in full, so the prose copy went. `(custom widget)` after the type said nothing
  about the value. Two cells of a grid offered as examples of shape were "1" and "2".
- Standing instructions live in the session; each batch runs on a `clone()` so requests do not grow; batches run
  together.
- "Still loading" and "no model" are different answers and get different advice.
- Count a model answer where it lands in the form, not where it arrives.
- One session answers one prompt at a time, so the batches of a request do not run together however they are
  started: measured on a form of 34 fields, three finished at 6.6s, 11.9s and 17.6s — their total is the sum, not
  the maximum. Each batch is sent to the tab as it lands and written then; waiting for all of them put twelve fields
  that were ready at six seconds into the form at seventeen. `phase.firstLate` is how long the first outstanding
  field waited, and is the only number that tells the two shapes apart — they both end when the model does.
- A fill asks more than once — the form's own fields, then whatever an upload or a switch revealed — and each
  request comes back with its own record. They accumulate: keeping the last one alone showed the second prompt in
  the Debug tab with no trace of the first, and counting the answers of every request against the first one's total
  read "answered 14 of 10".
- Ask it only what it can improve. A bool has two values and the seed picks one; a list asked without its options
  can only be invented, and the invention is discarded by the filler that then picks a valid option itself. Seven
  toggles and two blind lists once filled a batch of twelve, and every one of those answers was thrown away. A
  control whose options are on screen (a radio group, a select button) carries them into the prompt; one whose list
  lives behind a popup is not asked at all.
- A field the seed decided is reported as a choice, not as a fallback. "The model had no answer for it" against a
  toggle nobody asked it about sends the reader looking in the wrong place.
- A bare `contenteditable` is a rich-text field like a library's editor: same length cap in the prompt, same layout
  on the way back. Treating only the recognised widgets as rich text left the plain ones with no stated maximum.
- A prose field with no declared maximum gets one in the prompt. One richtext answer ran to seven hundred
  characters, spent the reply's token budget and left the other two fields of its batch unanswered.
- The model copies the shape of the example it is shown. The response schema constrains the decoder but is never
  spelled out in the prompt (`omitResponseConstraintInput`), so the skeleton on the last line is the only shape the
  model ever sees — and a skeleton holding one `{"id":N}` came back with one value for a batch of twelve, in under
  two seconds, looking for all the world like a model that simply had nothing to say. List every id.
- The skeleton is a map keyed by id, `{"0":"","1":""}`, and the schema is built per batch: one property per id, all
  of them `required`, nothing else admitted. The grammar is then what makes a reply complete, rather than the
  model's willingness to copy a long example. A list of `{"id":N,"value":""}` objects spent twenty characters on a
  field where the map spends eight, and on a batch of twelve it was a third of the whole prompt.
- Keep off the field lines anything the model cannot act on. `text` was the type of almost every field and `required`
  was true of many, and neither changes the value written: every field in a batch is being answered regardless.

**Data**

- Phone numbers come only from ranges reserved for fiction. One German block applied to every city gave Leipzig a
  number somebody in Leipzig may well have, and a three-digit area code cut the block in half; the US "digits" form
  used 555-1000 to 555-9999, of which only 555-0100 to 555-0199 is reserved. Five German cities have a block of their
  own; the rest get one of the two reserved mobile blocks, because a mobile number is from nowhere in particular.
- A locale is a country, and the picker names it as a language: EN and DE. A third entry for British English was
  built and taken out again — which English it is is not a distinction anyone filling these forms wanted to make,
  and two entries reading "English" would have been worse than one.
- "Apt", "Suite" and "Unit" are the second address line only in an address. On their own they are a unit price, a
  business unit, a test suite — and every one of them was getting "Unit 4".
- Wait for a form to complain before believing it has not. A limit that lives only in a validation schema reaches
  the page as a message a few ticks after the value, and the pass that shortens the value used to look for it in
  the same breath as the write. On a form with other work to do a later pass caught it; on a dialog with one field
  there is no later pass, and a seventy-character answer sat in a thirty-character box under a red line. The wait
  is bounded and only taken for a value long enough to trip such a limit, so a form of short ones pays nothing.
- A bool takes no value from a text rule. A form names the switch that gates a block after the block, so a billing
  address gets `isBillingAddressEnabled`; loosening the name put a word boundary around "Address", the street rule
  matched, and the toggle's state came out of "8913 Park Avenue" — reported, wrongly, as a rule having decided it.
  Two states and no options to match a string against means the seed picks, as it always did before the name was
  loosened. A list is the other case: there a string is matched against real options.
- A field name is not a caption. Real forms write `02frstname`, `10address1`, `24emailadr`, `61pers ssn`: the
  numbering is glued to the word and the vowels are gone, so a pattern anchored on word boundaries matches none of
  them. The name is loosened first — digits prised off letters, camelCase humps split — and what is still buried in
  a word is caught by a short second pass of abbreviations that mean one thing on a form. It is worth the trouble
  because the alternative is the model, and the model's answer to a phone box was 555-123-4567, a number somebody
  may well have; to an SSN, `1234567890`; to a card, `RDouglas123`. A rule answers with a reserved number, a
  reserved SSN and a card that passes Luhn.
- The model is shown the name a person would read, not the one the form uses. Loosening is enough for a pattern;
  it is not enough for a model. Given `46cccstsvc` it wrote "XYZ-789", and `45ccissuer` got "ABC-123" — alphabet
  soup is what a model produces when the label tells it nothing. Expanded to "credit card customer service" the
  same box gets an answer. Only names no rule claimed are ever sent, so a wrong expansion costs a guess that was
  already wrong, and a name that needed no expansion keeps its own capitals.
- Asked about a label it cannot read, the model answers with the label. `46cccstsvc` came back as "46cccstsvc" and
  `60pers sex` as "60pers Male". A value equal to its own label is dropped, and a leading token is taken off only
  when the label's first word carries a digit, so "Project Apollo" under "Project name" is left alone.
- Nothing in the system prompt may be copyable as a value. `Infer from the label: "Project code" -> "PRJ-2481"` put
  PRJ-2481 into an unrelated title field on five fills out of five.
- A rule word that is also an ordinary word needs its context: "pass" alone was a boarding pass, "cost" a cost
  centre, "mobile" an app version, "land" a plot. The German Steuernummer and the USt-IdNr are different numbers with
  different shapes, and a validator for one rejects the other.
- A step counts from `min`, or from zero when there is none, as the browser counts it; a `pattern` is compiled with
  the `v` flag HTML compiles it with, or `\p{L}` fails to compile and the value goes through unchecked.
- The email domain is whatever the tester typed into a box. "@acme.test", "acme" and "https://acme.test/" all
  reached the address as typed.

**Tools**

- A tool that drives "the page" finds its tab by address, never by which one is active. `tools/audit.mjs` took the
  active tab, which was right until the extension began opening its own on a fresh install — and every audit run
  starts from a fresh profile, so every audit run was a fresh install. It filled the welcome page instead and hung
  waiting for an answer from a tab with no filler in it.

**Showing the work**

- Nothing FormForge writes goes to the console: a content-script warning is a red *Errors* badge on the extension. Notes
  go to the Debug tab.
- The indicator's stylesheet starts with `all: initial !important`; every rule in it is important too, run-time values
  travel in custom properties, hiding is a class.
- One progress bar for the whole job, and it only moves forward.
- The card on the page carries the verdict; the Debug tab carries the detail. The card dismisses itself after a few
  seconds, which is no place for a bug report somebody has to copy into a ticket — and two reports meant two places
  to keep in step.
- The result toast is what says the job is over, so it is what sends `done` — every ending, not just the happy
  one. While only "filled N fields" reported it, a fill that found nothing to fill left the toolbar icon animating
  until its 90-second watchdog, which is indistinguishable from a fill still running. The shortcut path hid it:
  `send()` turns the icon off in a `finally`, and the popup does not go through `send()`.
- The toolbar mark has one definition, `drawMark()` in the worker, because the icon that sits still and the icon
  that animates are the same silhouette. `tools/icons.mjs` renders the shipped PNGs from it rather than beside it;
  a hand-made set drifts from it, and the 128 in this repo was a scaled-up 32 with stair steps on its corners.
