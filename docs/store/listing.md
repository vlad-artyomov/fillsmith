# Chrome Web Store listing

Everything the developer dashboard asks for, in one place, so the listing is written once and reviewed like code.
The screenshots come from `npm run screenshots`.

## Name

Fillsmith — Free AI Form Filler & Test Data Generator

## Short description (132 characters max)

One click fills any form with realistic test data, even custom dropdowns and date pickers. Free built-in AI: no API key, no account.

## Category

Developer Tools

## Detailed description

The first two lines show before "read more", so they carry the whole pitch. The sections after them answer the
doubts in the order a tester has them: will it handle my form, is the data believable, will it pass validation, what
does the AI cost. Search terms are written into sentences, never listed — a keyword list is spam to the reviewers.

Paste the block as it is: the store keeps line breaks, so a paragraph is one line.

```text
Stop typing test data. One click fills the whole form — every field, every custom dropdown, every date picker — with one believable person. Free, with AI that runs on your own computer: no API key, no account, no subscription.

WORKS WHERE OTHER FORM FILLERS STOP
Most fillers set a value and hope. That does nothing on the controls real apps are built from: a Select that is really a popup, a date picker that ignores typing, a rich-text editor that only accepts a real paste. Fillsmith works each control like a person: opens the dropdown and picks a real option, waits for lists that load from the server, clicks the day in the calendar — then reads the field back to check the page kept it.
• PrimeVue, MUI, Ant Design, react-select, Radix, Headless UI, Choices.js, Select2, Tom Select, vue-multiselect — and any library that follows ARIA
• React, Vue and Angular apps, on localhost, staging or any other host

ONE PERSON, NOT RANDOM NOISE
• The email matches the name, the postcode matches the city, the phone matches the country
• Dates make sense together: a return date lands after the start date
• IBANs, VAT numbers and test card numbers pass their checksums
• English or German data, with addresses and phone numbers to match

VALID ON THE FIRST SUBMIT
• Respects min, max, step, maxlength and pattern
• A dropdown only ever gets one of its own options
• Required fields are never left empty
• File uploads get real generated files — PNG, PDF, CSV or JSON, whatever the field accepts
• Reads the validation messages and fixes what the form rejects; fills the fields that appear mid-fill

AI WITHOUT THE BILL
Fields no rule recognises go to Gemini Nano, the AI model built into Chrome. It runs on your machine: no API key, no account, no per-token cost, and your form never leaves the browser. The form is filled immediately; the AI's answers improve it as they arrive, so you never wait for it. Prefer a hosted model? Add your own Anthropic, OpenAI or Gemini key — or switch AI off entirely.

BUILT FOR REPRODUCING BUGS
• Pin a seed and get the exact same person again
• See where every value came from: which rule, what the AI was asked, where the time went
• Save a report of the last ten fills to attach to a ticket

FAST
Alt+Shift+F fills the page · Alt+Shift+D fills the focused field · Alt+Shift+R fills again as a new person · Alt+Shift+C clears. Or right-click → Fill this page.

FREE. REALLY.
No subscription, no Pro plan, no credits, no sign-up. No analytics, no tracking, nothing sent anywhere unless you add your own API key — and then only for fields no rule could answer: their labels, limits and options, the form's title and a few short texts from a table on the page, to the provider you chose.
Privacy policy: https://github.com/vlad-artyomov/fillsmith/blob/main/PRIVACY.md

The built-in AI needs Chrome 138 or later and a one-time model download by Chrome (about 2 GB) on supported hardware. Without it, Fillsmith still fills every field it recognises.

Open source (MIT): https://github.com/vlad-artyomov/fillsmith
```

## URLs

- **Homepage**: https://vlad-artyomov.github.io/fillsmith/ — the landing page, with the demo form to try it on
- **Support**: https://github.com/vlad-artyomov/fillsmith/issues
- **Privacy policy**: https://github.com/vlad-artyomov/fillsmith/blob/main/PRIVACY.md

## Single purpose

Fillsmith fills forms on the current page with generated test data for QA and development, and reports what it
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
  read to choose values. For fields no rule answers, their labels, section headings, limits and options, the form's
  title and up to three short texts from a table on the page go to the on-device model or, if the user entered an
  API key, to the hosted provider they chose. What is typed into the form's fields is never sent anywhere.
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
