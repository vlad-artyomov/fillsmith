# FormForge

A Chrome extension that fills any form with coherent, valid test data in one click — including the custom dropdowns,
date pickers, switches and rich-text editors that ordinary form fillers cannot touch.

Built for QA. No build step, no runtime dependencies, nothing leaves the browser.

## What it does

- **Fills the whole form at once.** Native inputs, `<select>`, radios, checkboxes, file uploads, `contenteditable` — and
  component-library widgets: PrimeVue, MUI, Ant Design, react-select, Radix, Headless UI, Choices.js, Select2, Tom
  Select, vue-multiselect, plus anything that speaks plain ARIA (`role="combobox"` / `role="option"`).
- **The data hangs together.** Every fill invents one person: the email matches the name, the postcode matches the city,
  the phone matches the country. IBANs, VAT ids and card numbers pass their checksums. Dates come out in the locale's
  format, and a "return date" lands after the "rental date".
- **It respects the control.** Values are clamped to `min`/`max`/`step`/`maxlength`/`pattern`. A dropdown only ever gets
  one of its own options. A required field is never left empty.
- **It checks its work.** Every control is read back after writing; anything a component silently reverted is written
  again, and fields revealed by the fill (a switch that shows more inputs) are filled too. The result names what did
  *not* work.
- **Optional on-device AI.** Fields no rule recognises can be answered by Chrome's built-in Gemini Nano, or by your own
  API key. Neither is required, and neither can slow a fill past its budget.

## Install

1. Clone the repository.
2. Open `chrome://extensions`, enable *Developer mode*, choose *Load unpacked* and pick the folder.

Chrome 128 or later. The on-device model needs a Chrome build that ships it; without one, the rules fill everything.

## Use

| How                                                         | What                                                                           |
|-------------------------------------------------------------|--------------------------------------------------------------------------------|
| Toolbar popup → **Fill this page**                          | Fills the form, shows what went where and why                                  |
| Popup → **Dry run**                                         | Lists every control it would fill and which adapter claimed it; writes nothing |
| Popup → **Clear**                                           | Empties what FormForge filled                                                  |
| `Alt+Shift+F` / `R` / `C`                                   | Fill · fill with new data · clear                                              |
| `Alt+Shift+D`                                               | Fill only the field the cursor is in; press again for another value            |
| Right-click → **Fill this page** / **Fill just this field** | Whole form, or the one control under the cursor                                |

Chrome binds these keys when the extension is installed. If one does not work (on a Mac, `Alt+Shift+D` then types
`Î` into the page), the popup footer says which shortcut is not set and links to `chrome://extensions/shortcuts`.

A small card in the corner of the page shows progress and then the result: how many fields, how many came from rules,
from the model, or were left empty. Click it for the persona and a *Copy for bug report* button. Turn on **Show the
Debug tab** in Settings for the full trail — the rule behind each value, what the model was asked and answered, and
where the time went — reachable from the *why?* link under every result.

## How a value is chosen

For every field, in order; the first step that answers wins:

1. **Rule** — an ordered list of `[pattern, persona => value]` in `src/generator.js`, matched against the field's label,
   name, id and placeholder. `zip` → postcode, `iban` → valid IBAN, `country` → the persona's country tried against the
   dropdown's real options.
2. **Type default** — what the control's kind implies: a number, a date in the locale's format, a time, prose, markup
   for a rich-text editor.
3. **Model** — everything a rule could not answer is sent in one batch with the persona and the page's own heading, so
   the answers stay coherent. Bounded by a budget; whatever has not answered in time is filled by the fallback.
4. **Fallback** — text named after the field (`Prerequisite 43`), or a seeded pick among the control's real options.

Everything derives from a seed, so a fill is reproducible: pin the seed in *Settings → Repeat data* to get the same
person twice.

## Settings

- **Language** of the generated data: English (US) or German.
- **Repeat data** — a fixed seed. Empty (the default) means new data every fill.
- **Model patience** — how long to wait for the model. *Automatic* is patient once per browser session and brisk after.
- **Use the model**, **Overwrite filled fields**, **Tag the email with the seed** (`name+ab12cd@example.com`).
- **Fallback API key** — Anthropic, OpenAI or Gemini, used only when the on-device model cannot answer. *On-device only*
  keeps everything offline; *API key only* skips the on-device model. **Test this setup** makes one real request through
  the configured backend and shows the provider's own answer or error.

## Privacy

Rules and the on-device model run entirely in your browser. Field labels are sent to a hosted provider only if you enter
an API key, and only the labels and limits of the fields no rule could answer. Uploaded files are generated in the page;
nothing is fetched. Phone numbers come from ranges reserved for fiction; card numbers are the `4111 11…` test family.

## Development

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
test/            four suites and two fixtures
tools/           audit.mjs (drive the real extension), vendor-faker.mjs
```

The files under `src/` are plain scripts injected in the order `background.js` lists them; each hands its surface to
`globalThis`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and the rules the project learned the hard way.

```bash
npm install                 # Playwright and faker, dev only
npm test                    # all four suites
npm run test:native         # generator and native controls
npm run test:widgets        # the widget layer against the PrimeVue fixture
npm run test:complete       # one fill on a clean page leaves nothing empty
npm run test:ext            # the unpacked extension and popup in Chromium
npm run audit               # fill the fixture with the real extension and judge the result
npm run audit -- --url URL  # the same against any page
```

**Adding a rule:** one line in `RULES` in `src/generator.js`, specific patterns above general ones. Return an array to
offer a dropdown several candidates.

**Teaching it a widget library:** one entry in `LIBS` in `src/adapters.js`. Only `root` and `kind` are required; the
other selectors are hints with generic ARIA fallbacks.

## License

MIT
