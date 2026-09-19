# Privacy

FormForge fills forms on pages you choose, with data it invents. This is what it reads, what it keeps and what, if
anything, leaves your browser.

## What it reads

When you press Fill (or a shortcut, or the context menu), the filler is injected into the current tab and reads the
form: field labels, names, placeholders, the options a list offers, the headings around the form and, when a table
is on the page, a few of its cells so generated values match the shape of existing ones. It never reads values you
have already typed into other fields to send them anywhere; it only checks whether a field is empty.

## What it writes

Generated values: an invented person with a matching email, address, phone number and company; checksum-valid test
identifiers (IBAN, VAT id, `4111 11…` card numbers); generated PNG, PDF, CSV, JSON or text files for upload fields.
Phone numbers come only from ranges reserved for fiction. Nothing is fetched from the network to produce them.

## What it keeps, on this computer only

- **Settings**, in `chrome.storage.local`: the data language, a pinned seed if you set one, the email domain, the
  checkboxes, the model backend, and an API key if you enter one. The key is stored as you typed it, in the
  profile's extension storage, and is sent only to the provider you chose.
- **The last ten fills**, for the Debug tab and the report: the page URL and title, the values FormForge wrote and
  where each came from, and — when a model was asked — the prompts and replies. **Debug → Clear** deletes them.
- **A log of the last hundred fills' timings** (URL, title, phases, counts; no values), for the report.

Uninstalling the extension removes all of it. Nothing is synced to other devices.

## What leaves your browser

By default, **nothing**. The rules and Chrome's built-in model run on your machine. The model's one-time download is
Chrome's own, from Google, and only starts when you click the download button.

If you enter an API key, then for fields no rule could answer FormForge sends the provider you chose (Anthropic,
OpenAI or Google) the labels and limits of those fields, the page or dialog title, up to five short texts from a
table on the page, and the invented persona. It never sends values from the page, your key to anyone but that
provider, or anything at all when the backend is set to *On-device only*.

FormForge has no analytics, no telemetry, no ads and no remote code. It does not phone home.

## Permissions

| Permission               | Why                                                                                                                                                      |
|--------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| `activeTab`, `scripting` | To inject the filler into the tab you invoked it on, and only then.                                                                                      |
| `storage`                | The settings and the fill history above.                                                                                                                 |
| `contextMenus`           | The right-click entries.                                                                                                                                 |
| `<all_urls>`             | A tester's form is on their own host, and forms are often split across origins (an embedded payment or booking frame). Nothing runs until you invoke it. |

## Questions

Open an issue at <https://github.com/vlad-artyomov/formforge/issues>.
