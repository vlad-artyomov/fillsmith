<div align="center">

# ⚡ FormForge

### One press fills the whole form — including the custom dropdowns, date pickers, rich-text editors and file uploads that ordinary form fillers can't touch.

For QA engineers who fill the same create-form forty times a day.

[![Chrome Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-1f6f4f)](manifest.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-1f6f4f)](package.json)
[![No build step](https://img.shields.io/badge/build%20step-none-1f6f4f)](#-development)
[![AI: on-device](https://img.shields.io/badge/AI-on--device-1f6f4f)](#-the-model-is-optional-and-never-in-the-way)
[![License: MIT](https://img.shields.io/badge/license-MIT-1f6f4f)](LICENSE)

<img src="docs/filled-form.png" alt="A form filled in one press: selects, a dependent dropdown, a phone country picker, a file upload — with a card in the corner reporting 39 fields" width="820">

</div>

---

## 🤔 Why another form filler

Most of them assign `input.value` and dispatch `change`. That works on a plain `<input>` and does **nothing** on the
controls modern admin panels are built from: a component-library `Select` is a `<div>` that opens a teleported
overlay, a date picker refuses typed text, a Quill editor ignores anything that isn't a real `beforeinput`. So you
fill the six text boxes by machine and the fourteen interesting fields by hand.

FormForge drives each control the way a person does — then reads it back to see whether the page kept it.

|                               | A `.value =` filler                 | ⚡ FormForge                                                           |
|-------------------------------|-------------------------------------|------------------------------------------------------------------------|
| `<input>`, `<select>`, radios | ✅                                  | ✅                                                                     |
| Component-library dropdowns   | ❌ the component reverts the write  | ✅ opens the popup, picks a real option, waits if the list is remote   |
| Date & time pickers           | ❌ text the component rejects       | ✅ clicks a day, or types in the locale's format; drives time spinners |
| Rich-text editors             | ❌ plain text, or nothing           | ✅ real markup through the editor's own input events                   |
| File inputs                   | ❌ skipped                          | ✅ a PNG, PDF, CSV or JSON generated to match `accept`                 |
| The data                      | 🎲 random, field by field           | 🧑 one invented person: email matches name, postcode matches city      |
| IBAN / VAT id / card number   | ❌ fail their checksums             | ✅ pass                                                                |
| The report                    | what it *typed*                     | what the control **holds afterwards**, and what didn't stick           |
| AI                            | 💳 cloud API, account, subscription | 🧠 Chrome's on-device model — optional, and never able to delay a fill |
| Your data                     | leaves the browser                  | 🔒 stays in it                                                         |

## 🎯 What one press does

- **Finds every fillable control.** Native inputs, `<select>`, radio groups, checkboxes, file inputs,
  `contenteditable` — plus widgets from **PrimeVue, MUI, Ant Design, react-select, Radix, Headless UI, Choices.js,
  Select2, Tom Select and vue-multiselect**. An unknown library still works if it speaks ARIA.
- **Invents one coherent person.** Not forty unrelated strings: `anna.becker+tv6cbv@example.com` belongs to Anna
  Becker, who lives at a Cologne postcode and answers a Cologne phone number. A *return* date lands after the *rental*
  date.
- **Respects the control.** Clamped to `min`, `max`, `step`, `maxlength`, `pattern`. A dropdown only ever receives
  one of its own options. A required field is never left empty.
- **Checks its own work.** Everything is read back. What a framework reverted is written again; fields that appeared
  *because* of the fill get filled too; a maximum that exists only in a validation schema is read off the error
  message under the field and obeyed.
- **Says what went wrong.** A card in the corner reports how many fields were filled, where each value came from,
  and which ones were left — with a **Copy for bug report** button underneath.

<div align="center">
<img src="docs/popup.png" alt="The FormForge popup: one Fill button, a dry run, a clear, and the last fill listed field by field" width="380">
</div>

## 📦 Install

1. Clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, pick the folder.

Chrome 128+. Nothing to build, nothing to sign up for.

## 🖱 Use

| How                                                         | What                                                                    |
|-------------------------------------------------------------|-------------------------------------------------------------------------|
| Popup → **Fill this page**                                  | Fills the form, then shows what went where and why                      |
| Popup → **Dry run**                                         | Lists what it *would* fill and which adapter claimed it; writes nothing |
| Popup → **Clear**                                           | Empties what FormForge filled                                           |
| `Alt+Shift+F` / `R` / `C`                                   | Fill · fill again as a new person · clear                               |
| `Alt+Shift+D`                                               | Fill just the focused field; press again for a different value          |
| Right-click → **Fill this page** / **Fill just this field** | The whole form, or the one control under the pointer                    |

If a shortcut does nothing (on a Mac `Alt+Shift+D` types `Î` instead), the popup footer says which one is unassigned
and links to `chrome://extensions/shortcuts`.

## 🎲 How a value is chosen

For each field, the first step that answers wins:

1. **Rule** — an ordered list of `[pattern, persona => value]` in [`src/generator.js`](src/generator.js), matched
   against label, name, id and placeholder. `zip` → a postcode, `iban` → a valid IBAN, `country` → the persona's
   country tried against the dropdown's real options, under every spelling that country has.
2. **Type default** — a number, a date in the locale's format, a time, prose, markup for a rich-text editor.
3. **Model** — everything left over goes to Chrome's built-in Gemini Nano in one batch, with the persona and the
   page's own heading, so the answers stay coherent with each other.
4. **Filler** — text named after the field, or a seeded pick among the control's real options.

Everything derives from a seed, so a fill is reproducible: pin one in **Settings → Repeat data** to get the same
person twice — what you want when you're reproducing a bug rather than finding one.

## 🏎 Speed

**The fill never waits for the model.** The request goes out as soon as the form has been read and writing starts
immediately; a field the model owns is written the moment its answer lands, and only what's *still* outstanding at
the end is waited for.

One `npm run audit` against the bundled fixture — 39 fields, 24 of them component-library widgets, three of the
dropdowns answering from a simulated server:

```
collect        11 ms   reading the form
model           0 ms   time the fill actually spent waiting for the model
firstPass    5956 ms   driving 39 controls (1036 ms of it the page's own loaders)
recollect       3 ms   looking again for what the fill revealed
secondPass    284 ms   re-checking, and writing what it found
total        6251 ms
```

`model` is the only number a model can inflate, and it's the time the fill **blocked**, not the time the model took.
In the suite, a stand-in that needs 2.5 seconds to answer costs a fill zero milliseconds — the form is written while
it thinks — and the Debug tab reports both numbers so they're never confused.

Every wait in the code is a condition with a budget, never a fixed sleep: a list that arrives at once isn't paid for
as though it arrived slowly.

## 🧠 The model is optional, and never in the way

- **On-device by default.** Chrome's built-in Gemini Nano runs locally — no key, no account, and after its one-time
  download, no network. Without it, the rules still fill every recognised field.
- **Bounded, always.** Loading it, downloading it and answering each have their own budget. A missing, slow or
  wedged model changes how *good* the values are, never whether they arrive.
- **Your own key, if you want one.** Anthropic, OpenAI or Gemini, used only for what the on-device model couldn't
  answer. *On-device only* keeps everything offline; *key only* skips Nano. **Test this setup** makes one real
  request and shows the provider's own answer — or its own error text.

## 🔒 Privacy and permissions

| Permission               | Why                                                                                                                    |
|--------------------------|------------------------------------------------------------------------------------------------------------------------|
| `activeTab`, `scripting` | The filler is injected **only** when you press Fill. It is not a declared content script and never runs as you browse. |
| `storage`                | Settings, the last fill's trail, and an API key if you enter one. Local to this browser profile.                       |
| `contextMenus`           | The right-click entries.                                                                                               |
| `<all_urls>`             | A tester's form can be on any host, and the extension can't know which in advance.                                     |

Rules and the on-device model run entirely in your browser. Field labels reach a hosted provider only if you enter
an API key, and then only the labels and limits of fields no rule could answer — never values already on the page.
Uploaded files are generated in the page; nothing is fetched. Phone numbers come from ranges reserved for fiction (US
`555-01xx`, DE `23125 xxx`) and card numbers are the `4111 11…` test family.

## 🧩 Extending it

**A new rule** is one line in `RULES` in [`src/generator.js`](src/generator.js) — specific patterns above general
ones. Return an array to offer a dropdown several candidates:

```js
[/\b(manufacturer|hersteller|brand|marke)\b/i, p => p.company, WEAK],
```

`WEAK` makes a rule a floor rather than an answer: the field is also offered to the model, and the rule fills it
only if the model doesn't.

**A new widget library** is one entry in `LIBS` in [`src/adapters.js`](src/adapters.js). Only `root` and `kind` are
required; the rest are hints with generic ARIA fallbacks. Make `root` specific enough that an application's own
wrapper class can't match it:

```js
{
    id: 'acme-select', kind
:
    'choice',
        root
:
    '.acme-select:has(> .acme-select__trigger)',
        label
:
    '.acme-select__value', option
:
    '[role="option"]',
        overlay
:
    '.acme-select__panel', filter
:
    '.acme-select__search'
}
,
```

## 🛠 Development

Plain ES2020 scripts injected in the order [`background.js`](src/background.js) lists them; each hands its surface to
`globalThis`. No bundler, no framework, no runtime dependency.

```
src/
  dom.js         clicks, typing, waiting — knows nothing about forms
  vocab.js       word lists (generated from faker by `npm run vocab`)
  generator.js   seed → persona → rules → checksums
  adapters.js    which control is which, and what it is called
  overlays.js    finding, opening and closing a widget's popup
  fillers.js     how to drive each kind of control
  uploads.js     generated files for <input type="file">
  hud.js         the on-page progress card
  content.js     discovery, planning, the fill loop, repair
  background.js  service worker: the model, the injected file list, shortcuts, menus
  popup.*        the toolbar popup
```

```bash
npm install                 # Playwright and faker, dev only
npm test                    # all four suites, in parallel
npm run test:widgets        # just the widget layer (fast)
npm run fixture             # serve test/ at :8099 to try it by hand
npm run audit               # fill the fixture with the real extension and judge the page
npm run audit -- --url URL  # the same against any page you can reach
npm run package             # the store ZIP: manifest, src and icons, nothing else
npm run icons               # redraw icons/ from the mark the worker animates
```

The suites judge the **page**, not FormForge's own report: `test/complete.mjs` presses Fill once on a clean form and
asks the page whether every required control now holds a value, and `tools/audit.mjs` watches the indicator, the
overlays, the console and the toolbar icon *while* a fill runs — a still screenshot can't tell a working progress bar
from a frozen one. CI runs all four on every push, plus a check that regenerating `src/vocab.js` leaves it
byte-identical.

[ARCHITECTURE.md](ARCHITECTURE.md) has the design, and one line per bug that ever got out — each with a regression
check behind it.

## License

MIT
