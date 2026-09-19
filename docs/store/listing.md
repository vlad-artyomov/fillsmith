# Chrome Web Store listing

Everything the developer dashboard asks for, in one place, so the listing is written once and reviewed like code.
The screenshots come from `npm run screenshots`.

## Name

FormForge — AI QA Form Filler

## Short description (132 characters max)

Fills any form with coherent QA test data in one click — custom dropdowns, date pickers and editors included. On-device
AI.

## Category

Developer Tools

## Detailed description

One press fills the whole form — including the component-library dropdowns, date pickers, rich-text editors and
file uploads that ordinary form fillers cannot touch.

Most fillers assign a value and fire a change event. That works on a plain input and does nothing on the controls
modern admin panels are built from: a Select that is a div with a popup, a date picker that refuses typed text, an
editor that ignores anything but a real paste. FormForge drives each control the way a person does — opens the
popup, picks a real option, waits for a list that comes from the server, clicks a day — and then reads it back to
see whether the page kept it.

WHAT ONE PRESS DOES
• Finds every fillable control: native inputs and selects, radios, checkboxes, file inputs, contenteditable, plus
widgets from PrimeVue, MUI, Ant Design, react-select, Radix, Headless UI, Choices.js, Select2, Tom Select and
vue-multiselect. An unknown library still works if it speaks ARIA.
• Invents one coherent person: the email matches the name, the postcode matches the city, the phone number the
country. A return date lands after the rental date. IBANs, VAT ids and card numbers pass their checksums.
• Respects the control: min, max, step, maxlength, pattern. A dropdown only ever receives one of its own options. A
required field is never left empty.
• Generates the files an upload wants — a PNG, PDF, CSV or JSON matching the input's accept — in the page, from
nothing.
• Checks its own work: what a framework reverted is written again, fields that appeared because of the fill are
filled too, and a limit that lives only in a validation message is read and obeyed.
• Says what went wrong: a card on the page reports how many fields were filled and which were left; the Debug tab
keeps every value and where it came from, and the report page holds the last ten fills, to read or to save as one
text file for a ticket.

THE MODEL IS OPTIONAL AND NEVER IN THE WAY
Fields no rule recognises go to Chrome's built-in Gemini Nano — on your machine, no key, no account. The form is
filled from the rules immediately; the model's answers replace what they improve as they arrive. Without a model
nothing waits and nothing is left empty. You can add your own Anthropic, OpenAI or Gemini key for the fields the
on-device model cannot answer, or switch the network off entirely.

REPRODUCIBLE
Every fill derives from a seed. Pin one to get the same person twice — what you want when you are reproducing a bug
rather than finding one.

SHORTCUTS
Alt+Shift+F fills the page, Alt+Shift+D the focused field, Alt+Shift+R fills again as a new person, Alt+Shift+C
clears. Right-click → Fill this page / Fill just this field.

PRIVACY
Everything runs in your browser. Nothing leaves it unless you enter an API key, and then only the labels of fields no
rule could answer go to the provider you chose. No analytics, no telemetry, no remote code.
https://github.com/vlad-artyomov/formforge/blob/main/PRIVACY.md

Open source, MIT: https://github.com/vlad-artyomov/formforge

## Single purpose

FormForge fills forms on the current page with generated test data for QA and development, and reports what it
filled. It does nothing else.

## Permission justifications

- **activeTab, scripting** — to inject the filler into the tab the user invoked it on (toolbar, shortcut or context
  menu) and read the form's controls and labels there. There is no declared content script; nothing runs while the
  user browses.
- **storage** — the user's settings, an API key if one is entered, and the trail of the last ten fills that the
  Debug tab and the report page are built from. Local to the profile.
- **contextMenus** — the "Fill this page", "Fill just this field" and "Clear" entries in the page's context menu.
- **Host permission `<all_urls>`** — the extension fills whatever form the user is looking at, and a tester's form is
  on their own staging host, which cannot be known in advance. Forms are also routinely split across origins: a
  payment provider's card fields, an embedded booking widget. `activeTab` alone covers neither, because a frame from
  another origin is outside the tab's own origin. Nothing is declared as a content script and nothing runs while the
  user browses: the filler is injected into one tab, on the user's action, and is removed when the page is left.

## Remote code

None. All code ships in the package. The optional hosted providers are called with `fetch` and return data only.

## Data use disclosure

- **Authentication information**: an API key the user may enter, stored locally, sent only to the provider chosen.
- **Website content**: field labels, names, placeholders, option lists and headings of the form being filled are
  read to choose values; for fields no rule answers they are sent to the on-device model or, if configured, to the
  hosted provider. Values the user already typed are never sent anywhere.
- Not sold, not used for purposes unrelated to the single purpose, not used for creditworthiness or lending.

## Assets

All of it comes out of `npm run screenshots`, drawn at twice the size and reduced, so the text holds up wherever the
store shrinks it. `--dark` renders the same set in the dark theme.

| File                             | Size     | What it shows                                                                 |
|----------------------------------|----------|-------------------------------------------------------------------------------|
| `docs/store/1-filled-form.png`   | 1280×800 | A form filled in one press, with the card reporting what came from where      |
| `docs/store/2-one-press.png`     | 1280×800 | The result: every field and the source of its value                           |
| `docs/store/3-debug.png`         | 1280×800 | The decision trail: which rule, what the model was asked, where the time went |
| `docs/store/4-settings.png`      | 1280×800 | On-device by default, the key optional, the network optional                  |
| `docs/store/5-promo-440x280.png` | 440×280  | The small promo tile: the mark and the one line                               |
| `docs/store-icon128.png`         | 128×128  | The listing icon — the mark inside the store's 16 px of padding               |
